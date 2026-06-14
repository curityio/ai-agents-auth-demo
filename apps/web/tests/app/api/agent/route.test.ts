/**
 * BFF agent route — step-up / access-denied detection tests.
 *
 * Mocking strategy:
 *  - `@/auth`         → vi.mock; auth() returns a minimal non-null session so
 *                       the handler considers the user authenticated.
 *  - `next-auth/jwt`  → vi.mock; getToken() returns a token with an accessToken.
 *  - global fetch     → vi.stubGlobal; controls what the copilot call and the
 *                       RFC 9728 metadata dereference return.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── auth mocks (must be hoisted before the route import) ──────────────────────

vi.mock('@/auth', () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }),
}));

vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn().mockResolvedValue({ accessToken: 'test-access-token' }),
}));

// ── import the route after mocks are established ──────────────────────────────

import { POST } from '@/app/api/agent/route.js';

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://app.localtest.me/api/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Build a minimal fetch mock from a map of url → { status, body, headers? }. */
function stubFetch(
  responses: Map<
    string,
    { status: number; body: unknown; headers?: Record<string, string> }
  >,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // Find the first entry whose key is a prefix/exact match of the requested URL
      for (const [key, res] of responses) {
        if (url.startsWith(key)) {
          return new Response(JSON.stringify(res.body), {
            status: res.status,
            headers: {
              'content-type': 'application/json',
              ...(res.headers ?? {}),
            },
          });
        }
      }
      throw new Error(`Unexpected fetch to: ${url}`);
    }),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  // Re-apply the session/token defaults after clearing
  const { auth } = await import('@/auth');
  const { getToken } = await import('next-auth/jwt');
  vi.mocked(auth).mockResolvedValue({ user: { id: 'user-1' } } as never);
  vi.mocked(getToken).mockResolvedValue({ accessToken: 'test-access-token' } as never);
});

describe('POST /api/agent — step-up / access-denied', () => {
  it('returns 401 step-up with authServer when copilot returns 401 step-up', async () => {
    const resourceMetadataUrl =
      'https://mcp-ops.localtest.me/.well-known/oauth-protected-resource';

    stubFetch(
      new Map([
        [
          'http://agent-copilot',
          {
            status: 401,
            body: {
              kind: 'step-up',
              acrValues: 'mfa',
              resourceMetadata: resourceMetadataUrl,
              scope: 'ops:write',
            },
            headers: {
              'www-authenticate':
                'Bearer realm="agent-copilot", error="insufficient_user_authentication", acr_values="mfa", resource_metadata="' +
                resourceMetadataUrl +
                '"',
            },
          },
        ],
        [
          resourceMetadataUrl,
          {
            status: 200,
            body: {
              authorization_servers: [
                'https://curity.localtest.me/oauth/v2/oauth-anonymous',
              ],
              scopes_supported: ['ops:write'],
              acr_values_supported: ['mfa'],
            },
          },
        ],
      ]),
    );

    const req = makeRequest({ message: 'restart the api-gateway deployment' });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({
      kind: 'step-up',
      acrValues: 'mfa',
      scope: 'ops:write',
      authServer: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
    });
  });

  it('returns 401 step-up with authServer="" when metadata fetch fails', async () => {
    const resourceMetadataUrl =
      'https://mcp-ops.localtest.me/.well-known/oauth-protected-resource';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;

        if (url.startsWith('http://agent-copilot')) {
          return new Response(
            JSON.stringify({
              kind: 'step-up',
              acrValues: 'mfa',
              resourceMetadata: resourceMetadataUrl,
              scope: 'ops:write',
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          );
        }
        // metadata fetch fails
        throw new Error('Network error fetching metadata');
      }),
    );

    const req = makeRequest({ message: 'restart the api-gateway deployment' });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({
      kind: 'step-up',
      acrValues: 'mfa',
      scope: 'ops:write',
      authServer: '',
    });
  });

  it('returns 403 access-denied when copilot returns 403 access-denied', async () => {
    stubFetch(
      new Map([
        [
          'http://agent-copilot',
          {
            status: 403,
            body: {
              kind: 'access-denied',
              reason: 'Role ops-engineer required to restart deployments.',
            },
          },
        ],
      ]),
    );

    const req = makeRequest({ message: 'restart the api-gateway deployment' });
    const res = await POST(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({
      kind: 'access-denied',
      reason: 'Role ops-engineer required to restart deployments.',
    });
  });

  it('passes through copilot 200 success response unchanged', async () => {
    const successBody = { answer: 'CPU at 42%', specialist: null };
    stubFetch(
      new Map([
        [
          'http://agent-copilot',
          {
            status: 200,
            body: successBody,
          },
        ],
      ]),
    );

    const req = makeRequest({ message: 'what is the CPU usage?' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(successBody);
  });

  it('passes through a 401 with a non-step-up JSON body unchanged (no kind transform)', async () => {
    const upstreamBody = { error: 'invalid_token', error_description: 'Token has expired' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(upstreamBody), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const req = makeRequest({ message: 'what is the CPU usage?' });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    // Must NOT be transformed into a step-up envelope
    expect(body).not.toHaveProperty('kind', 'step-up');
    expect(body).toEqual(upstreamBody);
  });

  it('passes through a 401 with a non-JSON body unchanged without crashing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('Unauthorized', {
          status: 401,
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    );

    const req = makeRequest({ message: 'what is the CPU usage?' });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toBe('Unauthorized');
  });
});
