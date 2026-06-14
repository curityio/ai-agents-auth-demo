import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('@ai-agents-demo/auth-curity', async () => {
  const actual = await vi.importActual<typeof import('@ai-agents-demo/auth-curity')>(
    '@ai-agents-demo/auth-curity',
  );
  return {
    ...actual,
    verifyJwt: vi.fn(),
  };
});

import { verifyJwt, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { authMiddleware, walkActChain } from '../src/auth-middleware.js';
import type { Config } from '../src/config.js';

const cfg: Config = {
  port: 8080,
  curityIssuer: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
  curityJwksUri: 'https://curity.localtest.me/oauth/v2/oauth-anonymous/jwks',
  expectedAudience: 'mcp-ops',
  requiredScopes: ['ops:write'],
  expectedActorChain: [
    /^spiffe:\/\/demo\.curity\.local\/ns\/agents\/sa\/agent-specialist$/,
    /^spiffe:\/\/demo\.curity\.local\/ns\/agents\/sa\/agent-copilot$/,
  ],
  targetNamespace: 'prod',
  requiredAcr: 'mfa',
  resourceMetadataUrl: 'https://mcp-ops.localtest.me/.well-known/oauth-protected-resource',
  curityTokenEndpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  clientId: 'mcp-ops',
  clientSecret: 'test-secret',
  opsApiUrl: 'http://ops-api.apis.svc.cluster.local:8083/restart',
  opsApiAudience: 'ops-api',
  opsApiScope: 'ops:write',
};

const SPECIALIST = 'spiffe://demo.curity.local/ns/agents/sa/agent-specialist';
const COPILOT = 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot';
const STRANGER = 'spiffe://demo.curity.local/ns/agents/sa/agent-rogue';

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as unknown as Response & typeof res;
}

function mockReq(authz?: string): Request {
  return {
    header(name: string) {
      return name.toLowerCase() === 'authorization' ? authz : undefined;
    },
  } as unknown as Request;
}

describe('walkActChain', () => {
  it('returns [] for non-object input', () => {
    expect(walkActChain(undefined)).toEqual([]);
    expect(walkActChain(null)).toEqual([]);
    expect(walkActChain('string')).toEqual([]);
  });

  it('returns depth-1 chain', () => {
    expect(walkActChain({ sub: COPILOT })).toEqual([COPILOT]);
  });

  it('returns depth-2 chain in outer→inner order', () => {
    expect(walkActChain({ sub: SPECIALIST, act: { sub: COPILOT } })).toEqual([SPECIALIST, COPILOT]);
  });

  it('stops at first node missing string sub', () => {
    expect(walkActChain({ sub: SPECIALIST, act: { not_sub: 'x' } })).toEqual([SPECIALIST]);
  });
});

describe('authMiddleware', () => {
  beforeEach(() => vi.mocked(verifyJwt).mockReset());

  it('401 when bearer header missing', async () => {
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq(undefined), res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'invalid_token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('401 when verifyJwt throws CurityAuthError', async () => {
    vi.mocked(verifyJwt).mockRejectedValueOnce(
      new CurityAuthError('Token expired', 'expired_token'),
    );
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'expired_token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('403 insufficient_scope when ops:write missing', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: { sub: SPECIALIST, act: { sub: COPILOT } } },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['obs:read']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'insufficient_scope' });
    expect(next).not.toHaveBeenCalled();
  });

  it('403 act_required when act claim absent', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: {},
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['ops:write']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'act_required' });
  });

  it('403 act_chain_length when chain too short (flat fallback)', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: { sub: COPILOT } },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['ops:write']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'act_chain_length' });
  });

  it('403 act_chain_order when specialist is on the inside', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: { sub: COPILOT, act: { sub: SPECIALIST } } },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['ops:write']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'act_chain_order', position: 0 });
  });

  it('403 act_chain_unknown when an actor is not in the expected chain', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: { sub: STRANGER, act: { sub: COPILOT } } },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['ops:write']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'act_chain_unknown', position: 0, sub: STRANGER });
  });

  it('calls next() on the canonical depth-2 chain', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: { sub: SPECIALIST, act: { sub: COPILOT } }, acr: 'mfa' },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['ops:write']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer abc'), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it('401 insufficient_user_authentication when acr is not mfa', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: { sub: SPECIALIST, act: { sub: COPILOT } }, acr: 'password' },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['ops:write']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer abc'), res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'insufficient_user_authentication' });
    expect(res.headers['www-authenticate']).toContain('acr_values="mfa"');
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    expect(res.headers['www-authenticate']).toContain('resource_metadata="https://mcp-ops.localtest.me');
    expect(next).not.toHaveBeenCalled();
  });

  it('401 insufficient_user_authentication when acr claim is absent', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: { sub: SPECIALIST, act: { sub: COPILOT } } },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['ops:write']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer abc'), res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'insufficient_user_authentication' });
    expect(res.headers['www-authenticate']).toContain('acr_values="mfa"');
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    expect(res.headers['www-authenticate']).toContain('resource_metadata="https://mcp-ops.localtest.me');
    expect(next).not.toHaveBeenCalled();
  });
});
