/**
 * Unit tests for selectLlmLeaf — whether the specialist's /last-token surfaces
 * its aud=llm-gateway token as a leaf of the OBO chain.
 *
 * Within one remediation the exchanges run in a fixed order: obs:read →
 * ops:write → llm:invoke → LLM loop. A run that is refused at the ops:write
 * exchange (step-up, wrong role) never reaches the LLM exchange, so a leaf
 * stamped BEFORE the current ops slot belongs to an earlier run and must not
 * be shown under this one.
 */
import { describe, it, expect } from 'vitest';
import { selectLlmLeaf } from '../src/last-token-route.js';

const NOW = 1_000;

describe('selectLlmLeaf', () => {
  it('shows the leaf when it was minted after the ops:write exchange of the same run', () => {
    expect(selectLlmLeaf({ at: NOW }, { at: NOW + 1 })).toBe(true);
  });

  it('hides a leaf that predates the current ops:write exchange (this run stopped before the model)', () => {
    expect(selectLlmLeaf({ at: NOW }, { at: NOW - 1 })).toBe(false);
  });

  it('hides the leaf when no ops:write exchange has happened — the model is only reached after it', () => {
    expect(selectLlmLeaf(undefined, { at: NOW })).toBe(false);
  });

  it('shows nothing when there is no leaf', () => {
    expect(selectLlmLeaf({ at: NOW }, undefined)).toBe(false);
  });
});
