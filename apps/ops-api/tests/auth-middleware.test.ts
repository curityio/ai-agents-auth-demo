import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('@ai-agents-demo/auth-curity', async () => {
  const actual = await vi.importActual<typeof import('@ai-agents-demo/auth-curity')>(
    '@ai-agents-demo/auth-curity',
  );
  return { ...actual, verifyJwt: vi.fn() };
});

import { verifyJwt, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { authMiddleware, walkActChain } from '../src/auth-middleware.js';
import type { Config } from '../src/config.js';

const cfg: Config = {
  port: 8083,
  curityIssuer: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
  curityJwksUri: 'https://curity.localtest.me/oauth/v2/oauth-anonymous/jwks',
  expectedAudience: 'ops-api',
  requiredScopes: ['ops:write'],
  expectedActorChain: [
    /^spiffe:\/\/demo\.curity\.local\/ns\/mcp\/sa\/mcp-ops$/,
    /^spiffe:\/\/demo\.curity\.local\/ns\/agents\/sa\/agent-specialist$/,
    /^spiffe:\/\/demo\.curity\.local\/ns\/agents\/sa\/agent-copilot$/,
  ],
  targetNamespace: 'prod',
  requiredAcr: 'mfa',
  resourceMetadataUrl: 'https://ops-api.localtest.me/.well-known/oauth-protected-resource',
};

const MCP_OPS = 'spiffe://demo.curity.local/ns/mcp/sa/mcp-ops';
const SPECIALIST = 'spiffe://demo.curity.local/ns/agents/sa/agent-specialist';
const COPILOT = 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot';

/** Canonical depth-3 act claim: outer=mcp-ops, then specialist, then copilot. */
const FULL_ACT = { sub: MCP_OPS, act: { sub: SPECIALIST, act: { sub: COPILOT } } };

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
  it('returns the depth-3 chain outer→inner', () => {
    expect(walkActChain(FULL_ACT)).toEqual([MCP_OPS, SPECIALIST, COPILOT]);
  });
  it('returns [] for non-object input', () => {
    expect(walkActChain(undefined)).toEqual([]);
  });
});

describe('authMiddleware (ops-api)', () => {
  beforeEach(() => vi.mocked(verifyJwt).mockReset());

  it('401 when bearer missing', async () => {
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq(undefined), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('403 insufficient_scope when ops:write absent', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: FULL_ACT, acr: 'mfa' },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['obs:read']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'insufficient_scope' });
  });

  it('403 act_chain_length when mcp-ops actor is absent (depth-2 only)', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: { sub: SPECIALIST, act: { sub: COPILOT } }, acr: 'mfa' },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['ops:write']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'act_chain_length' });
  });

  it('403 act_chain_order when mcp-ops is not outermost', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: { sub: SPECIALIST, act: { sub: MCP_OPS, act: { sub: COPILOT } } }, acr: 'mfa' },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['ops:write']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'act_chain_order', position: 0 });
  });

  it('401 insufficient_user_authentication when acr is not mfa', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: FULL_ACT, acr: 'password' },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['ops:write']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'insufficient_user_authentication' });
    expect(res.headers['www-authenticate']).toContain('acr_values="mfa"');
  });

  it('next() on the canonical depth-3 chain with acr=mfa', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: FULL_ACT, acr: 'mfa' },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['ops:write']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer abc'), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it('401 when verifyJwt throws CurityAuthError', async () => {
    vi.mocked(verifyJwt).mockRejectedValueOnce(new CurityAuthError('expired', 'expired_token'));
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'expired_token' });
  });
});
