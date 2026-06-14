/**
 * A2A server-side helpers — auth context plumbing on top of @a2a-js/sdk.
 *
 * The SDK's `userBuilder` lets us inject auth at the Express layer. We define
 * a small `BearerUser` carrier so the `AgentExecutor` can recover the inbound
 * bearer from `ServerCallContext.user` and forward it (after token exchange)
 * to downstream services.
 *
 * This only needs to:
 *   - extract `Authorization: Bearer …` from the request
 *   - hand it to a verifier (provided by the consumer; usually
 *     `verifyAccessToken` from @ai-agents-demo/auth-curity)
 *   - stash the raw bearer on the resulting User so executors can read it
 *
 * Anything more (extensions, push, RBAC) belongs in the consumer.
 */

import type { Request } from 'express';
import { UnauthenticatedUser, type User, type ServerCallContext } from '@a2a-js/sdk/server';

export interface BearerUser extends User {
  readonly bearer: string;
}

class BearerUserImpl implements BearerUser {
  constructor(public readonly bearer: string, private readonly _sub: string) {}
  get isAuthenticated(): boolean {
    return true;
  }
  get userName(): string {
    return this._sub;
  }
}

export function isBearerUser(u: User | undefined): u is BearerUser {
  return !!u && u.isAuthenticated && typeof (u as Partial<BearerUser>).bearer === 'string';
}

/** Recover the raw bearer from a `ServerCallContext`, if any. */
export function bearerFromContext(ctx: ServerCallContext | undefined): string | undefined {
  if (!ctx) return undefined;
  return isBearerUser(ctx.user) ? ctx.user.bearer : undefined;
}

export interface BearerUserBuilderOptions {
  /**
   * Verifies the bearer and returns the authenticated principal's `sub`.
   * Throw to reject the request — the SDK propagates the error as a JSON-RPC fault.
   * On a missing/malformed Authorization header, the builder yields an unauthenticated
   * User; the executor is then responsible for rejecting if it requires auth.
   */
  verify: (bearer: string) => Promise<{ sub: string }>;
}

/**
 * Build a `userBuilder` for the SDK's Express handlers.
 *
 * Usage:
 *   const userBuilder = createBearerUserBuilder({ verify: async (jwt) => ({ sub: '…' }) });
 *   app.use(jsonRpcHandler({ requestHandler, userBuilder }));
 */
export function createBearerUserBuilder(opts: BearerUserBuilderOptions) {
  return async (req: Request): Promise<User> => {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      return new UnauthenticatedUser();
    }
    const bearer = header.slice('bearer '.length).trim();
    if (!bearer) return new UnauthenticatedUser();
    const { sub } = await opts.verify(bearer);
    return new BearerUserImpl(bearer, sub);
  };
}
