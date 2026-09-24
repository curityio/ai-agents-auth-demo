import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('@ai-agents-demo/auth-curity', async () => {
  const actual = await vi.importActual<typeof import('@ai-agents-demo/auth-curity')>(
    '@ai-agents-demo/auth-curity',
  );
  return { ...actual, verifyJwt: vi.fn() };
});

import { verifyJwt, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { authMiddleware, walkActChain, chainMatchesAny } from '../src/auth-middleware.js';
import type { Config } from '../src/config.js';

const cfg: Config = {
  port: 8084,
  curityIssuer: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
  curityJwksUri: 'https://curity.localtest.me/oauth/v2/oauth-anonymous/jwks',
  expectedAudience: 'inspect-api',
  requiredScopes: ['inspect:read'],
  expectedActorChains: [
    [
      /^spiffe:\/\/demo\.curity\.local\/ns\/mcp\/sa\/mcp-inspect$/,
      /^spiffe:\/\/demo\.curity\.local\/ns\/agents\/sa\/agent-copilot$/,
    ],
    [
      /^spiffe:\/\/demo\.curity\.local\/ns\/mcp\/sa\/mcp-inspect$/,
      /^spiffe:\/\/demo\.curity\.local\/ns\/agents\/sa\/agent-specialist$/,
      /^spiffe:\/\/demo\.curity\.local\/ns\/agents\/sa\/agent-copilot$/,
    ],
  ],
  targetNamespace: 'prod',
};

const MCP_INSPECT = 'spiffe://demo.curity.local/ns/mcp/sa/mcp-inspect';
const COPILOT = 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot';
const FULL_ACT = { sub: MCP_INSPECT, act: { sub: COPILOT } };

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
  it('returns depth-2 outer→inner', () => {
    expect(walkActChain(FULL_ACT)).toEqual([MCP_INSPECT, COPILOT]);
  });
  it('walks outer→inner (plan fixture)', () => {
    expect(walkActChain({ sub: 'a', act: { sub: 'b' } })).toEqual(['a', 'b']);
  });
});

const ID = (ns: string, sa: string) => new RegExp(`^spiffe://demo\\.curity\\.local/ns/${ns}/sa/${sa}$`);
const COPILOT_CHAIN = [ID('mcp', 'mcp-inspect'), ID('agents', 'agent-copilot')];
const SPECIALIST_CHAIN = [
  ID('mcp', 'mcp-inspect'),
  ID('agents', 'agent-specialist'),
  ID('agents', 'agent-copilot'),
];
const sid = (ns: string, sa: string) => `spiffe://demo.curity.local/ns/${ns}/sa/${sa}`;

describe('chainMatchesAny', () => {
  const allowed = [COPILOT_CHAIN, SPECIALIST_CHAIN];

  it('accepts the copilot 2-chain', () => {
    expect(
      chainMatchesAny([sid('mcp', 'mcp-inspect'), sid('agents', 'agent-copilot')], allowed),
    ).toBe(true);
  });

  it('accepts the specialist 3-chain', () => {
    expect(
      chainMatchesAny(
        [
          sid('mcp', 'mcp-inspect'),
          sid('agents', 'agent-specialist'),
          sid('agents', 'agent-copilot'),
        ],
        allowed,
      ),
    ).toBe(true);
  });

  it('rejects a spliced/unknown chain', () => {
    expect(
      chainMatchesAny([sid('mcp', 'mcp-ops'), sid('agents', 'agent-copilot')], allowed),
    ).toBe(false);
  });

  it('rejects a chain of the wrong length', () => {
    expect(chainMatchesAny([sid('mcp', 'mcp-inspect')], allowed)).toBe(false);
  });
});

describe('authMiddleware (inspect-api)', () => {
  beforeEach(() => vi.mocked(verifyJwt).mockReset());

  it('401 when bearer missing', async () => {
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq(undefined), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('403 insufficient_scope when inspect:read absent', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: FULL_ACT },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set([]),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'insufficient_scope' });
  });

  it('403 act_chain when mcp-inspect actor is absent (flat act — no allowed chain matches)', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: { sub: COPILOT } },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['inspect:read']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'act_chain' });
  });

  it('403 act_chain when mcp-inspect is not outermost (wrong order — no allowed chain matches)', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: { sub: COPILOT, act: { sub: MCP_INSPECT } } },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['inspect:read']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'act_chain' });
  });

  it('next() on the canonical depth-2 chain (no acr required)', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: { act: FULL_ACT },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['inspect:read']),
    });
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer abc'), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it('401 when verifyJwt throws CurityAuthError', async () => {
    vi.mocked(verifyJwt).mockRejectedValueOnce(new CurityAuthError('bad aud', 'invalid_audience'));
    const res = mockRes();
    const next = vi.fn();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'invalid_audience' });
  });
});
