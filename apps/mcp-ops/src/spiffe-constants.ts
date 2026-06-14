/**
 * SPIFFE JWT-SVID for mcp-ops — used as the actor_token when this MCP calls
 * Curity's token-exchange endpoint to mint an ops-api-bound Bearer. The
 * spiffe-helper sidecar already mints an SVID with exactly this audience
 * (k8s/workloads/mcp-ops.yaml), so no manifest change is needed for it.
 */
export const SVID_AUDIENCE = 'https://curity.localtest.me/oauth/v2/oauth-token';
export const SVID_FILE = '/run/spiffe/curity-actor.jwt';
