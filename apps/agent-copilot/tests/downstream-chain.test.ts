/**
 * The downstream walk of /last-token authenticates to the next service with
 * the exchanged token this hop minted. Once that token expires the next hop
 * answers 401 and the walk used to return nothing, so the chain silently
 * truncated to the copilot's own hops. A per-bearer snapshot keeps the full
 * chain on screen (tokens still render as expired) without loosening auth
 * on any /last-token route.
 */
import { describe, it, expect, vi } from 'vitest';
import { createDownstreamChainFetcher } from '../src/last-token-route.js';

const URL = 'http://mcp-inspect/last-token';
const HOPS = [{ hop: 'agentgateway → mcp-inspect', header: {}, payload: { sub: 'alice' } }];

function fetchReturning(status: number, chain?: unknown) {
  return vi.fn(
    async () =>
      ({ ok: status < 400, status, json: async () => ({ chain }) }) as unknown as Response,
  );
}

describe('createDownstreamChainFetcher', () => {
  it('returns the downstream hops on success', async () => {
    const f = createDownstreamChainFetcher(fetchReturning(200, HOPS));
    expect(await f(URL, 'tok-A', false)).toEqual(HOPS);
  });

  it('serves the last successful snapshot for the SAME bearer when the next hop rejects it', async () => {
    const fetchImpl = fetchReturning(200, HOPS);
    const f = createDownstreamChainFetcher(fetchImpl);
    await f(URL, 'tok-A', false);
    fetchImpl.mockImplementation(async () => ({ ok: false, status: 401 }) as unknown as Response);
    expect(await f(URL, 'tok-A', false)).toEqual(HOPS);
  });

  it('never serves another bearer’s snapshot', async () => {
    const fetchImpl = fetchReturning(200, HOPS);
    const f = createDownstreamChainFetcher(fetchImpl);
    await f(URL, 'tok-A', false);
    fetchImpl.mockImplementation(async () => ({ ok: false, status: 401 }) as unknown as Response);
    expect(await f(URL, 'tok-B', false)).toEqual([]);
  });

  it('keeps raw and non-raw snapshots apart', async () => {
    const fetchImpl = fetchReturning(200, HOPS);
    const f = createDownstreamChainFetcher(fetchImpl);
    await f(URL, 'tok-A', false);
    fetchImpl.mockImplementation(async () => ({ ok: false, status: 401 }) as unknown as Response);
    expect(await f(URL, 'tok-A', true)).toEqual([]);
  });

  it('serves the snapshot when the fetch throws (service unreachable)', async () => {
    const fetchImpl = fetchReturning(200, HOPS);
    const f = createDownstreamChainFetcher(fetchImpl);
    await f(URL, 'tok-A', false);
    fetchImpl.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await f(URL, 'tok-A', false)).toEqual(HOPS);
  });
});
