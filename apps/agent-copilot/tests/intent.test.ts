import { describe, expect, it } from 'vitest';
import { detectIntent } from '../src/intent.js';

describe('detectIntent', () => {
  it('returns observe for plain questions', () => {
    expect(detectIntent('which pods are crashlooping in prod?').kind).toBe('observe');
    expect(detectIntent('show me logs for api-gateway').kind).toBe('observe');
  });

  it('picks up restart and the deployment name', () => {
    const out = detectIntent('please restart api-gateway');
    expect(out.kind).toBe('restart');
    if (out.kind === 'restart') {
      expect(out.deployment).toBe('api-gateway');
    }
  });

  it('handles reboot/kick/bounce variants', () => {
    expect(detectIntent('bounce checkout-svc').kind).toBe('restart');
    expect(detectIntent('reboot the api-gateway deployment').kind).toBe('restart');
    expect(detectIntent('kick api-gateway').kind).toBe('restart');
  });

  it('extracts namespace if explicitly named', () => {
    const out = detectIntent('restart api-gateway in prod');
    if (out.kind !== 'restart') throw new Error('expected restart');
    expect(out.namespace).toBe('prod');
  });

  it('falls back to observe when the verb has no plausible target', () => {
    expect(detectIntent('restart please').kind).toBe('observe');
    expect(detectIntent('restart the deployment').kind).toBe('observe');
  });

  it('rejects single-token bare nouns as deployment names', () => {
    // "pod" is a stopword and has no dash/digit — should not be treated as a name.
    expect(detectIntent('restart pod').kind).toBe('observe');
  });
});

describe('detectIntent — privileged verbs', () => {
  it('routes restart to privileged', () => {
    expect(detectIntent('restart api-gateway').kind).toBe('restart');
  });
  it('routes image updates to privileged', () => {
    expect(detectIntent('update the image of api-gateway to v1.2').kind).toBe('restart');
    expect(detectIntent('set image checkout-svc=demo/checkout:v2').kind).toBe('restart');
    expect(detectIntent('roll out v1.3 to api-gateway').kind).toBe('restart');
  });
  it('routes the image-change phrasings a presenter is likely to use', () => {
    // demo.md Act 4 has carol ask to "change its image"; a phrasing the router
    // does not recognise silently takes the READ path and the copilot just says
    // it cannot — so the presenter's vocabulary is pinned here.
    for (const msg of [
      'change the image of order-service to busybox:1.36',
      'switch the image on order-service to busybox:1.36',
      'bump order-service image to busybox:1.36',
      'update order-service image to busybox:1.36',
    ]) {
      const out = detectIntent(msg);
      expect(out.kind, msg).toBe('restart');
      if (out.kind === 'restart') expect(out.deployment, msg).toBe('order-service');
    }
  });
  it('does not treat a question about a change as a privileged verb', () => {
    expect(detectIntent('what changed in prod overnight?').kind).toBe('observe');
    expect(detectIntent('did the image change on order-service?').kind).toBe('observe');
  });
  it('does not pick a version token as the deployment name', () => {
    // The version precedes the real name; we must skip `v1.3`/`v1` and pick `api-gateway`.
    const out = detectIntent('roll out v1.3 to api-gateway');
    if (out.kind !== 'restart') throw new Error('expected restart');
    expect(out.deployment).toBe('api-gateway');
  });
  it('still extracts a name that precedes the version (set image)', () => {
    // Regression guard: `checkout-svc` comes before `:v2`, must still extract.
    const out = detectIntent('set image checkout-svc=demo/checkout:v2');
    if (out.kind !== 'restart') throw new Error('expected restart');
    expect(out.deployment).toBe('checkout-svc');
  });
  it('routes a status phrasing with a privileged verb to privileged (accepted tradeoff)', () => {
    // Documented benign-extra-hop case: "rollout status of …" contains a
    // privileged verb + a name, so the deterministic gate routes it to the
    // specialist. Not ideal UX, but accepted — the specialist re-gates
    // acr/scope/act-chain downstream, so it is not a security issue.
    expect(detectIntent('what is the rollout status of api-gateway?').kind).toBe('restart');
  });
  it('routes scaling to privileged', () => {
    expect(detectIntent('scale checkout-svc to 3 replicas').kind).toBe('restart');
  });
  it('keeps pure reads on observe', () => {
    expect(detectIntent('what is failing in prod?').kind).toBe('observe');
    expect(detectIntent('show me the logs for api-gateway').kind).toBe('observe');
  });
});
