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
