/**
 * The single SPIFFE JWT-SVID this agent fetches via spiffe-helper, used as
 * the actor_token in RFC 8693 token exchange against Curity. Both the
 * exchange call (mcp-client.ts) and the debug endpoint (spiffe-route.ts)
 * read the same file at the same audience.
 */
export const SVID_AUDIENCE = 'https://curity.localtest.me/oauth/v2/oauth-token';
export const SVID_FILE = '/run/spiffe/curity-actor.jwt';
