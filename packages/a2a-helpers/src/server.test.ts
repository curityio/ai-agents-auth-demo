import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';
import {
  bearerFromContext,
  createBearerUserBuilder,
  isBearerUser,
  type BearerUser,
} from './server.js';
import { UnauthenticatedUser, ServerCallContext, type User } from '@a2a-js/sdk/server';

function reqWithAuth(value: string | undefined): Request {
  return { headers: value === undefined ? {} : { authorization: value } } as unknown as Request;
}

describe('createBearerUserBuilder', () => {
  it('returns BearerUser carrying the raw token on a valid Bearer header', async () => {
    const verify = vi.fn().mockResolvedValue({ sub: 'alice' });
    const builder = createBearerUserBuilder({ verify });

    const user = await builder(reqWithAuth('Bearer abc.def.ghi'));

    expect(verify).toHaveBeenCalledWith('abc.def.ghi');
    expect(user.isAuthenticated).toBe(true);
    expect(user.userName).toBe('alice');
    expect(isBearerUser(user)).toBe(true);
    expect((user as BearerUser).bearer).toBe('abc.def.ghi');
  });

  it('accepts lower-case "bearer "', async () => {
    const verify = vi.fn().mockResolvedValue({ sub: 'alice' });
    const builder = createBearerUserBuilder({ verify });

    const user = await builder(reqWithAuth('bearer abc'));
    expect(user.isAuthenticated).toBe(true);
  });

  it('yields UnauthenticatedUser on a missing Authorization header', async () => {
    const verify = vi.fn();
    const builder = createBearerUserBuilder({ verify });

    const user = await builder(reqWithAuth(undefined));

    expect(verify).not.toHaveBeenCalled();
    expect(user.isAuthenticated).toBe(false);
    expect(user).toBeInstanceOf(UnauthenticatedUser);
  });

  it('yields UnauthenticatedUser on a non-Bearer scheme', async () => {
    const verify = vi.fn();
    const builder = createBearerUserBuilder({ verify });

    const user = await builder(reqWithAuth('Basic dXNlcjpwYXNz'));

    expect(verify).not.toHaveBeenCalled();
    expect(user.isAuthenticated).toBe(false);
  });

  it('yields UnauthenticatedUser when the bearer value is empty', async () => {
    const verify = vi.fn();
    const builder = createBearerUserBuilder({ verify });

    const user = await builder(reqWithAuth('Bearer '));

    expect(verify).not.toHaveBeenCalled();
    expect(user.isAuthenticated).toBe(false);
  });

  it('propagates verify() errors so the SDK can surface them', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('invalid signature'));
    const builder = createBearerUserBuilder({ verify });

    await expect(builder(reqWithAuth('Bearer bad'))).rejects.toThrow(/invalid signature/);
  });
});

describe('bearerFromContext', () => {
  it('returns the bearer when the context user is a BearerUser', async () => {
    const verify = vi.fn().mockResolvedValue({ sub: 'alice' });
    const user = await createBearerUserBuilder({ verify })(reqWithAuth('Bearer xyz'));
    const ctx = new ServerCallContext(undefined, user);

    expect(bearerFromContext(ctx)).toBe('xyz');
  });

  it('returns undefined for an unauthenticated context', () => {
    const ctx = new ServerCallContext(undefined, new UnauthenticatedUser());
    expect(bearerFromContext(ctx)).toBeUndefined();
  });

  it('returns undefined when context is missing', () => {
    expect(bearerFromContext(undefined)).toBeUndefined();
  });

  it('returns undefined for a User without a bearer field', () => {
    const fakeUser: User = {
      get isAuthenticated() {
        return true;
      },
      get userName() {
        return 'no-bearer';
      },
    };
    const ctx = new ServerCallContext(undefined, fakeUser);
    expect(bearerFromContext(ctx)).toBeUndefined();
  });
});
