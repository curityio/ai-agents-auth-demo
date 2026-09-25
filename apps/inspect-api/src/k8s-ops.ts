import type { V1Pod, V1Deployment } from '@kubernetes/client-node';
import { oboLog } from '@ai-agents-demo/auth-curity';
import { coreV1, appsV1 } from './k8s-client.js';

export interface PodSummary {
  name: string;
  namespace: string;
  status: string;
  restarts: number;
  ageSeconds: number;
  image: string;
}

/** Pure mapper from a K8s V1Pod to the demo's PodSummary shape. */
export function toPodSummary(pod: V1Pod): PodSummary {
  const start = pod.status?.startTime ? new Date(pod.status.startTime).getTime() : 0;
  const ageSeconds = start ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : 0;
  const restarts = (pod.status?.containerStatuses ?? []).reduce(
    (acc, c) => acc + (c.restartCount ?? 0),
    0,
  );
  return {
    name: pod.metadata?.name ?? '',
    namespace: pod.metadata?.namespace ?? '',
    status: pod.status?.phase ?? 'Unknown',
    restarts,
    ageSeconds,
    image: pod.spec?.containers?.[0]?.image ?? '',
  };
}

/** Real list: every pod in `namespace`, mapped to PodSummary. */
export async function listPods(namespace: string): Promise<PodSummary[]> {
  oboLog({
    service: 'inspect-api',
    kind: 'CALL',
    headline: '→ K8s API list pods',
    fields: { namespace, verb: 'list', resource: 'pods' },
  });
  const res = await coreV1().listNamespacedPod(namespace);
  return (res.body.items ?? []).map(toPodSummary);
}

export interface PodLogsResult {
  podName: string;
  namespace: string;
  lines: string[];
}

/** Real logs: tail of `podName`'s log, split into lines. */
export async function getPodLogs(
  podName: string,
  namespace: string,
  tailLines: number,
): Promise<PodLogsResult> {
  oboLog({
    service: 'inspect-api',
    kind: 'CALL',
    headline: '→ K8s API read pod logs',
    fields: { namespace, pod: podName, tailLines, verb: 'get', resource: 'pods/log' },
  });
  // @kubernetes/client-node 0.22.x readNamespacedPodLog positional args:
  //   (name, namespace, container?, follow?, insecureSkipTLSVerifyBackend?,
  //    limitBytes?, pretty?, previous?, sinceSeconds?, tailLines?, timestamps?)
  const res = await coreV1().readNamespacedPodLog(
    podName,
    namespace,
    undefined, // container — first/default
    false, // follow
    undefined,
    undefined,
    undefined,
    false, // previous
    undefined,
    tailLines,
    true, // timestamps
  );
  const text = typeof res.body === 'string' ? res.body : String(res.body ?? '');
  const lines = text.split('\n').filter((l) => l.length > 0);
  return { podName, namespace, lines };
}

export interface DeploymentSummary {
  name: string;
  namespace: string;
  image: string;
  replicas: number;
  readyReplicas: number;
  updatedReplicas: number;
  generation: number | undefined;
  observedGeneration: number | undefined;
}

/** Pure mapper from a K8s V1Deployment to the demo's DeploymentSummary shape. */
export function toDeploymentSummary(dep: V1Deployment): DeploymentSummary {
  return {
    name: dep.metadata?.name ?? '',
    namespace: dep.metadata?.namespace ?? '',
    image: dep.spec?.template?.spec?.containers?.[0]?.image ?? '',
    replicas: dep.spec?.replicas ?? 0,
    readyReplicas: dep.status?.readyReplicas ?? 0,
    updatedReplicas: dep.status?.updatedReplicas ?? 0,
    generation: dep.metadata?.generation,
    observedGeneration: dep.status?.observedGeneration,
  };
}

/** Real get: fetch a single deployment by name and return its summary. */
export async function getDeployment(name: string, namespace: string): Promise<DeploymentSummary> {
  oboLog({
    service: 'inspect-api',
    kind: 'CALL',
    headline: '→ K8s API get deployment',
    fields: { namespace, deployment: name, verb: 'get', resource: 'deployments' },
  });
  const res = await appsV1().readNamespacedDeployment(name, namespace);
  return toDeploymentSummary(res.body);
}
