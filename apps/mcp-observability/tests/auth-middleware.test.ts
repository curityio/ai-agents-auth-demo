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
  expectedAudience: 'mcp-observability',
  requiredScopes: ['obs:read'],
  actorPattern: /^spiffe:\/\/demo\.curity\.local\/ns\/agents\/sa\/[a-z0-9-]+$/,
  curityTokenEndpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  clientId: 'mcp-observability',
  clientSecret: 'test',
  obsApiBaseUrl: 'http://obs-api.apis.svc.cluster.local:8084',
  obsApiAudience: 'obs-api',
  obsApiScope: 'obs:read',
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

const baseReq = { header: (n: string) => (n.toLowerCase() === 'authorization' ? 'Bearer fake.tok' : undefined) } as unknown as Request;

beforeEach(() => verifyJwt.mockReset());

describe('mcp-observability authMiddleware', () => {
  it('passes when act.sub matches actorPattern and scope is satisfied', async () => {
    verifyJwt.mockResolvedValue({
      payload: { sub: 'alice', act: { sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot' } },
      protectedHeader: {},
      scopes: new Set(['obs:read']),
    });
    const next = vi.fn();
    const { res } = mockRes();
    await authMiddleware(cfg)(baseReq, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects when act claim is missing', async () => {
    verifyJwt.mockResolvedValue({
      payload: { sub: 'alice' },
      protectedHeader: {},
      scopes: new Set(['obs:read']),
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
      scopes: new Set(['obs:read']),
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
      scopes: new Set(['obs:read']),
    });
    const next = vi.fn();
    const { res, peek } = mockRes();
    await authMiddleware(cfg)(baseReq, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(peek()._status).toBe(403);
  });

  it('rejects when required scope is missing', async () => {
    verifyJwt.mockResolvedValue({
      payload: { sub: 'alice', act: { sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot' } },
      protectedHeader: {},
      scopes: new Set(['ops:read']),
    });
    const next = vi.fn();
    const { res, peek } = mockRes();
    await authMiddleware(cfg)(baseReq, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(peek()._status).toBe(403);
  });
});
