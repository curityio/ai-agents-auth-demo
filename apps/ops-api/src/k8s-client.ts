import { KubeConfig, AppsV1Api } from '@kubernetes/client-node';

let cached: AppsV1Api | undefined;

/**
 * In-cluster AppsV1 client. The Pod's ServiceAccount + a `prod`-scoped
 * Role/RoleBinding are the actual capability gate; this code path will get
 * 403'd by the API server if those aren't wired correctly. We deliberately
 * do NOT hold a cluster-scoped admin client.
 */
export function appsV1(): AppsV1Api {
  if (cached) return cached;
  const kc = new KubeConfig();
  if (process.env.KUBECONFIG_MODE === 'local') {
    kc.loadFromDefault();
  } else {
    kc.loadFromCluster();
  }
  cached = kc.makeApiClient(AppsV1Api);
  return cached;
}
