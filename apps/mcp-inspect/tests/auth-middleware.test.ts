import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const verifyJwt = vi.fn();
vi.mock('@ai-agents-demo/auth-curity', () => ({
  verifyJwt: (...args: unknown[]) => verifyJwt(...args),
  // No-op stand-in: the real decorator is a no-op when there is no active span,
  // and these unit tests run with no OTel SDK started. Must be present or the
  // middleware's call throws and gets swallowed into a 500.
  decorateSpanWithIdentity: () => {},
  CurityAuthError: class CurityAuthError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { authMiddleware } from '../src/auth-middleware.js';
import type { Config } from '../src/config.js';

const cfg: Config = {
  port: 8080,
  curityIssuer: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
  curityJwksUri: 'https://curity.localtest.me/oauth/v2/oauth-anonymous/jwks',
  expectedAudience: 'mcp-inspect',
  requiredScopes: ['inspect:read'],
  resourceMetadataUrl:
    'https://mcp-inspect.localtest.me/.well-known/oauth-protected-resource',
  actorPattern: /^spiffe:\/\/demo\.curity\.local\/ns\/mcp\/sa\/agentgateway$/,
  curityTokenEndpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  clientId: 'mcp-inspect',
  clientSecret: 'test',
  inspectApiBaseUrl: 'http://inspect-api.apis.svc.cluster.local:8084',
  inspectApiAudience: 'inspect-api',
  inspectApiScope: 'inspect:read',
  targetNamespace: 'prod',
};

function mockRes() {
  const headers: Record<string, string> = {};
  const inner = {
    _status: undefined as number | undefined,
    _body: undefined as unknown,
    status(code: number) { this._status = code; return this; },
    set(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
    json(body: unknown) { this._body = body; return this; },
  };
  return { res: inner as unknown as Response, headers, peek: () => inner };
}

/** Parse `Bearer k="v", k2="v2"` into a map. Values are unquoted; keys lowercased. */
function parseChallenge(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header || !/^bearer\s/i.test(header)) return out;
  for (const m of header.slice('bearer '.length).matchAll(/(\w+)="([^"]*)"/g)) {
    out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}

const baseReq = { header: (n: string) => (n.toLowerCase() === 'authorization' ? 'Bearer fake.tok' : undefined) } as unknown as Request;

// Braces matter: `mockReset()` returns the mock, and vitest treats a function
// returned from a beforeEach hook as an after-test cleanup — it would then CALL
// verifyJwt() after every test, which with a rejecting mock fails the test.
beforeEach(() => {
  verifyJwt.mockReset();
});

describe('mcp-inspect authMiddleware', () => {
  it('passes when act.sub is the agentgateway and scope is satisfied', async () => {
    verifyJwt.mockResolvedValue({
      payload: { sub: 'alice', act: { sub: 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway' } },
      protectedHeader: {},
      scopes: new Set(['inspect:read']),
    });
    const next = vi.fn();
    const { res } = mockRes();
    await authMiddleware(cfg)(baseReq, res, next);
    expect(next).toHaveBeenCalled();
  });

  // The MCP SDK reads credentials only from `req.auth`, never from headers, so
  // this hand-off IS the authentication seam: drop it and every tool would
  // exchange an empty subject_token.
  it('publishes the validated bearer as AuthInfo on req.auth', async () => {
    verifyJwt.mockResolvedValue({
      payload: {
        sub: 'alice',
        client_id: 'agentgateway',
        act: { sub: 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway' },
      },
      protectedHeader: {},
      scopes: new Set(['inspect:read']),
    });
    const req = { ...baseReq, header: baseReq.header } as Request & { auth?: unknown };
    const { res } = mockRes();
    await authMiddleware(cfg)(req, res, vi.fn());
    expect(req.auth).toEqual({
      token: 'fake.tok',
      clientId: 'agentgateway',
      scopes: ['inspect:read'],
      extra: { sub: 'alice' },
    });
  });

  it('rejects when act claim is missing', async () => {
    verifyJwt.mockResolvedValue({
      payload: { sub: 'alice' },
      protectedHeader: {},
      scopes: new Set(['inspect:read']),
    });
    const next = vi.fn();
    const { res, peek } = mockRes();
    await authMiddleware(cfg)(baseReq, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(peek()._status).toBe(401);
  });

  it('rejects when act is null', async () => {
    verifyJwt.mockResolvedValue({
      payload: { sub: 'alice', act: null } as unknown,
      protectedHeader: {},
      scopes: new Set(['inspect:read']),
    });
    const next = vi.fn();
    const { res, peek } = mockRes();
    await authMiddleware(cfg)(baseReq, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(peek()._status).toBe(401);
  });

  it('rejects when act.sub does not match the actor pattern', async () => {
    verifyJwt.mockResolvedValue({
      payload: { sub: 'alice', act: { sub: 'spiffe://demo.curity.local/ns/other/sa/whatever' } },
      protectedHeader: {},
      scopes: new Set(['inspect:read']),
    });
    const next = vi.fn();
    const { res, peek } = mockRes();
    await authMiddleware(cfg)(baseReq, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(peek()._status).toBe(403);
  });

  it('rejects when required scope is missing', async () => {
    verifyJwt.mockResolvedValue({
      payload: { sub: 'alice', act: { sub: 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway' } },
      protectedHeader: {},
      scopes: new Set(['ops:read']),
    });
    const next = vi.fn();
    const { res, peek } = mockRes();
    await authMiddleware(cfg)(baseReq, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(peek()._status).toBe(403);
  });

  // MCP 2026-07-28 asks the insufficient_scope challenge to advertise the RFC 9728
  // document too, so a client can reach the AS from the 403 without a prior 401.
  it('advertises scope and resource_metadata on the insufficient_scope challenge', async () => {
    verifyJwt.mockResolvedValue({
      payload: { sub: 'alice', act: { sub: 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway' } },
      protectedHeader: {},
      scopes: new Set(['ops:read']),
    });
    const { res, headers } = mockRes();
    await authMiddleware(cfg)(baseReq, res, vi.fn());
    const challenge = headers['www-authenticate'];
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="inspect:read"');
    expect(challenge).toContain(`resource_metadata="${cfg.resourceMetadataUrl}"`);
  });

  it('401 without a bearer advertises resource_metadata and the required scope (MCP 2026-07-28 discovery)', async () => {
    const req = { header: () => undefined } as unknown as Request;
    const { res, headers, peek } = mockRes();
    await authMiddleware(cfg)(req, res, vi.fn());
    expect(peek()._status).toBe(401);
    const c = parseChallenge(headers['www-authenticate']);
    expect(c.realm).toBe('mcp-inspect');
    expect(c.scope).toBe('inspect:read');
    expect(c.resource_metadata).toBe(cfg.resourceMetadataUrl);
    expect(c.error).toBeUndefined();
  });

  it('401 on a verification failure uses RFC 6750 invalid_token, keeps the specific code in the description, and advertises resource_metadata', async () => {
    verifyJwt.mockRejectedValue(
      new (await import('@ai-agents-demo/auth-curity')).CurityAuthError('Token expired', 'expired_token'),
    );
    const { res, headers, peek } = mockRes();
    await authMiddleware(cfg)(baseReq, res, vi.fn());
    expect(peek()._status).toBe(401);
    const c = parseChallenge(headers['www-authenticate']);
    expect(c.error).toBe('invalid_token');
    expect(c.error_description).toBe('expired_token: Token expired');
    expect(c.resource_metadata).toBe(cfg.resourceMetadataUrl);
    // The body still carries the specific code for callers that read it.
    expect(peek()._body).toMatchObject({ error: 'expired_token' });
  });

  it('escapes quotes in error_description so the challenge stays parseable', async () => {
    verifyJwt.mockRejectedValue(
      new (await import('@ai-agents-demo/auth-curity')).CurityAuthError('unknown "kid" in header', 'invalid_token'),
    );
    const { res, headers } = mockRes();
    await authMiddleware(cfg)(baseReq, res, vi.fn());
    const c = parseChallenge(headers['www-authenticate']);
    expect(c.error_description).toBe("invalid_token: unknown 'kid' in header");
    expect(c.resource_metadata).toBe(cfg.resourceMetadataUrl);
  });

  it('401 for a missing act.sub advertises resource_metadata', async () => {
    verifyJwt.mockResolvedValue({ payload: { sub: 'alice' }, protectedHeader: {}, scopes: new Set(['inspect:read']) });
    const { res, headers } = mockRes();
    await authMiddleware(cfg)(baseReq, res, vi.fn());
    const c = parseChallenge(headers['www-authenticate']);
    expect(c.error).toBe('invalid_token');
    expect(c.resource_metadata).toBe(cfg.resourceMetadataUrl);
  });
});
