import { buildLlm as buildLlmShared, type BuildLlmOptions } from '@ai-agents-demo/agent-runtime';
import type { Config } from './config.js';

/** Thin wrapper so callers keep passing the app Config. */
export function buildLlm(cfg: Config, opts?: BuildLlmOptions) {
  return buildLlmShared(cfg, opts);
}
