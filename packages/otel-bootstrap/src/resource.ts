import { Resource } from '@opentelemetry/resources';

/**
 * Build the OTel resource carrying the WORKLOAD identity (`spiffe.id`).
 * service.name / service.namespace are left to NodeSDK's envDetector
 * (OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES) and merged automatically.
 */
export function buildResource(spiffeId: string | null): Resource {
  return new Resource({
    'spiffe.id': spiffeId ?? 'unknown',
  });
}
