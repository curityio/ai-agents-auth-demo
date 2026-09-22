/**
 * Deterministic intent router.
 *
 * Why regex, not an LLM call: the privileged path needs to be auditable in
 * a single grep. If the LLM is the gate that decides "do we forward to the
 * specialist (= attempt the privileged action)", then a prompt injection or
 * a sufficiently confused completion can elevate. Pulling the gate out of
 * the LLM and into deterministic code lets us reason about who can reach
 * the privileged surface without reading model evaluations.
 *
 * MFA step-up layers on top of this — the regex still gates which tokens get
 * requested, the step-up adds an acr=mfa requirement before Curity will mint
 * them.
 */

export type Intent =
  | { kind: 'observe' }
  // The `restart` discriminant means "any privileged write goal" — restart,
  // scale, or image update. The name is kept for back-compat; all such goals
  // route to the privileged specialist over A2A. (Renaming is out of scope.)
  | { kind: 'restart'; deployment: string; namespace?: string; reasonHint?: string };

// "restart"/"reboot"/"kick"/"bounce" (restart), "scale" (replicas),
// "deploy"/"roll out"/"rollout"/"upgrade" and "update/set/change/switch/bump …
// image" (image). The captured deployment name must be a DNS-1123 label. The
// `… image` alternative tolerates one filler token, which may itself be the
// deployment name ("update the image of …", "bump order-service image …").
// `change`/`switch`/`bump` are deliberately bound to "image" rather than listed
// as bare verbs: "what changed in prod?" must stay on the read path.
// Accepted limitation: a status phrasing that contains a privileged verb + a
// deployment name (e.g. "what is the rollout status of api-gateway?") routes to
// the privileged path and incurs a benign extra A2A hop. The specialist re-
// enforces acr/scope/act-chain downstream, so this is a UX wart, not a security
// issue — keeping the gate deterministic and grep-auditable is the priority.
const RESTART_VERBS =
  /\b(restart|reboot|kick|bounce|scale|deploy|roll\s?out|upgrade)\b|\b(update|set|change|switch|bump)\s+(?:[\w-]+\s+)?image\b/i;
const NAMESPACE_HINT = /\bin\s+([a-z][a-z0-9-]{0,61}[a-z0-9])(?:\s+(?:namespace|ns))?/i;

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'please',
  'pod',
  'pods',
  'deployment',
  'deployments',
  'svc',
  'service',
  'in',
  'on',
  'and',
  'or',
  'restart',
  'reboot',
  'kick',
  'bounce',
  'scale',
  'deploy',
  'rollout',
  'upgrade',
  'image',
  'replicas',
  'to',
  'version',
  'namespace',
  'ns',
]);

export function detectIntent(message: string): Intent {
  if (!RESTART_VERBS.test(message)) return { kind: 'observe' };

  // Find the first DNS-shaped token that isn't a stopword. Skip version-shaped
  // tokens (`v1`, `v2`, `v1.3`) — the image/rollout phrasings put a version
  // before the real deployment name ("roll out v1.3 to api-gateway"), and the
  // `/[-0-9]/` name-shape filter would otherwise pick the version.
  const tokens = message.toLowerCase().match(/[a-z][a-z0-9-]{0,61}[a-z0-9]/g) ?? [];
  const deployment = tokens.find(
    (t) => !STOP_WORDS.has(t) && /[-0-9]/.test(t) && !/^v\d/i.test(t),
  );
  if (!deployment) {
    // We saw the verb but no plausible deployment name — let the LLM
    // surface a clarifying question rather than blindly call the specialist.
    return { kind: 'observe' };
  }

  const nsMatch = NAMESPACE_HINT.exec(message);
  // "in prod" is implicit and the demo's only target; let the specialist
  // default it. Avoid false-positives like "in the cluster".
  const namespace =
    nsMatch && !STOP_WORDS.has(nsMatch[1]!.toLowerCase()) && nsMatch[1]!.toLowerCase() !== 'the'
      ? nsMatch[1]
      : undefined;

  return {
    kind: 'restart',
    deployment,
    namespace,
    reasonHint: message.trim().slice(0, 256),
  };
}
