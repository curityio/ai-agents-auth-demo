import { KubeConfig, CoreV1Api, AppsV1Api } from '@kubernetes/client-node';

let cachedCore: CoreV1Api | undefined;
let cachedApps: AppsV1Api | undefined;

function kubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  if (process.env.KUBECONFIG_MODE === 'local') kc.loadFromDefault();
  else kc.loadFromCluster();
  return kc;
}

/**
 * In-cluster CoreV1 client. The Pod's ServiceAccount + a `prod`-scoped read
 * Role/RoleBinding are the actual capability gate; the API server 403s this
 * code path if RBAC isn't wired. No cluster-scoped client is held.
 */
export function coreV1(): CoreV1Api {
  if (!cachedCore) cachedCore = kubeConfig().makeApiClient(CoreV1Api);
  return cachedCore;
}

/** In-cluster AppsV1 client (deployments read). */
export function appsV1(): AppsV1Api {
  if (!cachedApps) cachedApps = kubeConfig().makeApiClient(AppsV1Api);
  return cachedApps;
}
