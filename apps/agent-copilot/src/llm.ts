import {
  buildLlm as buildLlmShared,
  type BuildLlmOptions,
  type AgentLanguageModel,
} from '@ai-agents-demo/agent-runtime';
import type { Config } from './config.js';

/**
 * Thin wrapper so callers keep passing the app Config.
 *
 * The return type is annotated rather than inferred: the inferred type reaches
 * SDK types only through agent-runtime's `dist`, which tsc cannot name portably
 * (TS2742) when emitting this package's declarations.
 */
export function buildLlm(cfg: Config, opts?: BuildLlmOptions): AgentLanguageModel {
  return buildLlmShared(cfg, opts);
}
