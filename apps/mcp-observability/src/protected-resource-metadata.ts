import type { Request, Response } from 'express';

export interface ResourceMetadataInput {
  resource: string;
  authorizationServer: string;
  scopesSupported: string[];
  acrValuesSupported?: string[];
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  /**
   * NON-STANDARD. `acr_values_supported` is an OpenID Provider metadata field; RFC 9728
   * does not define it for protected resources, and MCP's authorization chapter has no
   * step-up story beyond scopes. mcp-ops emits it so a client that gets its RFC 9470
   * `insufficient_user_authentication` challenge can discover which `acr` to step up to.
   * Unused here — the read path requires no step-up. Demo-local extension either way.
   */
  acr_values_supported?: string[];
}

export function buildResourceMetadata(i: ResourceMetadataInput): ProtectedResourceMetadata {
  return {
    resource: i.resource,
    authorization_servers: [i.authorizationServer],
    scopes_supported: i.scopesSupported,
    bearer_methods_supported: ['header'],
    ...(i.acrValuesSupported ? { acr_values_supported: i.acrValuesSupported } : {}),
  };
}

export function resourceMetadataHandler(i: ResourceMetadataInput) {
  const doc = buildResourceMetadata(i);
  return (_req: Request, res: Response) => res.json(doc);
}
