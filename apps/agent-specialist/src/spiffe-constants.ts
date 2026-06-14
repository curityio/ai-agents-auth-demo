/**
 * SPIFFE JWT-SVID for agent-specialist — used as the actor_token when this
 * agent calls Curity's token-exchange endpoint to mint an mcp-ops-bound
 * Bearer. Mirrors agent-copilot's constants.ts so the spiffe-helper config
 * (the audience it tells SPIRE to mint for) matches what the agent reads.
 */
export const SVID_AUDIENCE = 'https://curity.localtest.me/oauth/v2/oauth-token';
export const SVID_FILE = '/run/spiffe/curity-actor.jwt';
