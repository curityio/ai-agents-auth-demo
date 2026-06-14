/**
 * SPIFFE JWT-SVID for mcp-observability — actor_token for the exchange to
 * obs-api. The spiffe-helper sidecar already mints an SVID with this audience.
 */
export const SVID_AUDIENCE = 'https://curity.localtest.me/oauth/v2/oauth-token';
export const SVID_FILE = '/run/spiffe/curity-actor.jwt';
