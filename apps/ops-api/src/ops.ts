import { oboLog } from '@ai-agents-demo/auth-curity';
import { appsV1 } from './k8s-client.js';

export interface RestartResult {
  deployment: string;
  namespace: string;
  restartedAt: string;
  generation: number | undefined;
}

/**
 * Trigger a rolling restart by patching `spec.template.metadata.annotations`
 * with a fresh `kubectl.kubernetes.io/restartedAt` timestamp — the same
 * mechanism `kubectl rollout restart` uses. Strategic-merge JSON patch via
 * the K8s API; no kubectl shell-out.
 *
 * The caller's chain has already been validated by ops-api's auth-middleware
 * (mcp-ops → specialist → copilot OBO required + acr=mfa), and the API server
 * enforces the `prod`-namespace-scoped RoleBinding on top.
 */
export async function restartDeployment(
  name: string,
  namespace: string,
  reason: string | undefined,
): Promise<RestartResult> {
  oboLog({
    service: 'ops-api',
    kind: 'CALL',
    headline: '→ K8s API patch deployment (rollout restart)',
    fields: { namespace, deployment: name, verb: 'patch', resource: 'deployments', reason },
  });
  const restartedAt = new Date().toISOString();
  const annotations: Record<string, string> = {
    'kubectl.kubernetes.io/restartedAt': restartedAt,
  };
  if (reason) {
    annotations['demo.curity.local/restart-reason'] = reason.slice(0, 512);
  }
  const body = {
    spec: {
      template: {
        metadata: { annotations },
      },
    },
  };

  const res = await appsV1().patchNamespacedDeployment(
    name,
    namespace,
    body,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
  );

  return {
    deployment: name,
    namespace,
    restartedAt,
    generation: res.body.metadata?.generation,
  };
}

export interface MutationResult {
  deployment: string;
  namespace: string;
  generation: number | undefined;
}

/** Strategic-merge patch body to set one container's image (by container name). */
export function buildSetImageBody(containerName: string, image: string) {
  return {
    spec: { template: { spec: { containers: [{ name: containerName, image }] } } },
  };
}

/** Strategic-merge patch body to set replicas. */
export function buildScaleBody(replicas: number) {
  return { spec: { replicas } };
}

export async function setDeploymentImage(
  name: string,
  namespace: string,
  image: string,
  reason: string | undefined,
): Promise<MutationResult> {
  oboLog({
    service: 'ops-api',
    kind: 'CALL',
    headline: '→ K8s API patch deployment (set image)',
    fields: { namespace, deployment: name, image, reason: reason?.slice(0, 512), verb: 'patch', resource: 'deployments' },
  });
  // Container name == deployment name in the demo workloads.
  const res = await appsV1().patchNamespacedDeployment(
    name,
    namespace,
    buildSetImageBody(name, image),
    undefined, undefined, undefined, undefined, undefined,
    { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
  );
  return { deployment: name, namespace, generation: res.body.metadata?.generation };
}

export async function scaleDeployment(
  name: string,
  namespace: string,
  replicas: number,
  reason: string | undefined,
): Promise<MutationResult> {
  oboLog({
    service: 'ops-api',
    kind: 'CALL',
    headline: '→ K8s API patch deployment (scale)',
    fields: { namespace, deployment: name, replicas, reason: reason?.slice(0, 512), verb: 'patch', resource: 'deployments' },
  });
  const res = await appsV1().patchNamespacedDeployment(
    name,
    namespace,
    buildScaleBody(replicas),
    undefined, undefined, undefined, undefined, undefined,
    { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
  );
  return { deployment: name, namespace, generation: res.body.metadata?.generation };
}
