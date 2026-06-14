import { describe, it, expect, vi } from 'vitest';
import { createBearerAuthHandler } from './client.js';

describe('createBearerAuthHandler', () => {
  it('returns a handler whose headers() embeds Bearer <token>', async () => {
    const provider = vi.fn().mockResolvedValue('jwt-abc');
    const handler = createBearerAuthHandler(provider);

    const headers = await handler.headers();

    expect(provider).toHaveBeenCalledOnce();
    expect(headers).toEqual({ authorization: 'Bearer jwt-abc' });
  });

  it('accepts a sync provider', async () => {
    const handler = createBearerAuthHandler(() => 'sync-token');
    const headers = await handler.headers();
    expect(headers).toEqual({ authorization: 'Bearer sync-token' });
  });

  it('calls the provider per request — does not memoize', async () => {
    const provider = vi.fn()
      .mockResolvedValueOnce('one')
      .mockResolvedValueOnce('two');
    const handler = createBearerAuthHandler(provider);

    expect((await handler.headers()).authorization).toBe('Bearer one');
    expect((await handler.headers()).authorization).toBe('Bearer two');
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('does not retry — shouldRetryWithHeaders returns undefined', async () => {
    const handler = createBearerAuthHandler(() => 'x');
    const result = await handler.shouldRetryWithHeaders!(
      // The SDK's shouldRetryWithHeaders signature; we don't care about the params here.
      {} as never,
      {} as never,
    );
    expect(result).toBeUndefined();
  });
});
