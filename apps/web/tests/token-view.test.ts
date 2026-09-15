/**
 * Unit tests for the delegation-ledger view model: the pure functions that turn
 * the `/api/obo-chain` hops (decoded JWT payloads) into per-hop rows with the
 * diff against the token each one was exchanged FROM.
 *
 * These are the beats the demo has to make visible: scope narrowing, `act`
 * growing one actor per hop, and `may_act` naming the next permitted actor.
 */
import { describe, it, expect } from 'vitest';
import {
  buildLedger,
  flattenActChain,
  listClaim,
  mayActSub,
  shortSpiffe,
  summarizeHop,
} from '../src/lib/token-view';

const SPIFFE = (ns: string, sa: string) => `spiffe://demo.curity.local/ns/${ns}/sa/${sa}`;
const COPILOT = SPIFFE('agents', 'agent-copilot');
const SPECIALIST = SPIFFE('agents', 'agent-specialist');
const GATEWAY = SPIFFE('mcp', 'agentgateway');

describe('shortSpiffe', () => {
  it('reduces a SPIFFE ID to its service-account name', () => {
    expect(shortSpiffe(COPILOT)).toBe('agent-copilot');
  });
  it('leaves a non-SPIFFE subject untouched', () => {
    expect(shortSpiffe('alice')).toBe('alice');
  });
});

describe('listClaim', () => {
  it('splits a space-delimited scope string', () => {
    expect(listClaim('openid obs:read ops:write')).toEqual(['openid', 'obs:read', 'ops:write']);
  });
  it('passes an array through as strings', () => {
    expect(listClaim(['mcp-gateway', 'x'])).toEqual(['mcp-gateway', 'x']);
  });
  it('returns an empty list for a missing claim', () => {
    expect(listClaim(undefined)).toEqual([]);
  });
});

describe('flattenActChain', () => {
  it('renders a nested act claim oldest → newest', () => {
    // RFC 8693: the OUTER `act` is the most recent actor.
    const act = { sub: GATEWAY, act: { sub: SPECIALIST, act: { sub: COPILOT } } };
    expect(flattenActChain(act)).toEqual(['agent-copilot', 'agent-specialist', 'agentgateway']);
  });
  it('returns an empty chain when act is absent', () => {
    expect(flattenActChain(undefined)).toEqual([]);
  });
});

describe('mayActSub', () => {
  it('reads may_act when it is an object', () => {
    expect(mayActSub({ sub: COPILOT })).toBe('agent-copilot');
  });
  it('reads may_act when Curity serialized it as a JSON string', () => {
    expect(mayActSub(JSON.stringify({ sub: GATEWAY }))).toBe('agentgateway');
  });
  it('is undefined for a terminal token with no may_act', () => {
    expect(mayActSub(undefined)).toBeUndefined();
  });
});

describe('summarizeHop', () => {
  it('extracts the identity-relevant claims from a payload', () => {
    const s = summarizeHop({
      sub: 'alice',
      aud: 'mcp-gateway',
      scope: 'obs:read',
      acr: 'mfa',
      roles: ['sre'],
      act: { sub: COPILOT },
      may_act: { sub: GATEWAY },
      iat: 100,
      exp: 700,
    });
    expect(s).toEqual({
      sub: 'alice',
      aud: ['mcp-gateway'],
      scopes: ['obs:read'],
      acr: 'mfa',
      roles: ['sre'],
      act: ['agent-copilot'],
      mayAct: 'agentgateway',
      iat: 100,
      exp: 700,
    });
  });
});

describe('buildLedger', () => {
  const user = {
    hop: 'user → agent-copilot (inbound)',
    payload: {
      sub: 'alice',
      aud: 'agent-copilot',
      scope: 'openid obs:read ops:write llm:invoke',
      acr: 'mfa',
      may_act: { sub: COPILOT },
    },
  };
  const copilotToGateway = {
    hop: 'agent-copilot → agentgateway',
    payload: {
      sub: 'alice',
      aud: 'mcp-gateway',
      scope: 'obs:read',
      acr: 'mfa',
      act: { sub: COPILOT },
      may_act: { sub: GATEWAY },
    },
  };
  const gatewayToObs = {
    hop: 'agentgateway → mcp-observability',
    payload: {
      sub: 'alice',
      aud: 'mcp-observability',
      scope: 'obs:read',
      acr: 'mfa',
      act: { sub: GATEWAY, act: { sub: COPILOT } },
    },
  };

  it('marks the scopes an exchange dropped, relative to the token it was exchanged from', () => {
    const rows = buildLedger([user, copilotToGateway]);
    expect(rows[1]!.diff.scopesDropped).toEqual(['openid', 'ops:write', 'llm:invoke']);
    expect(rows[1]!.diff.scopesKept).toEqual(['obs:read']);
  });

  it('has no diff for the first hop (nothing to compare against)', () => {
    const rows = buildLedger([user]);
    expect(rows[0]!.parentIndex).toBeUndefined();
    expect(rows[0]!.diff.scopesDropped).toEqual([]);
    expect(rows[0]!.diff.actAppended).toBeUndefined();
  });

  it('identifies the single actor appended to the act chain on each hop', () => {
    const rows = buildLedger([user, copilotToGateway, gatewayToObs]);
    expect(rows[1]!.diff.actAppended).toBe('agent-copilot');
    expect(rows[2]!.diff.actAppended).toBe('agentgateway');
  });

  it('confirms the appended actor is the one the parent token\'s may_act permitted', () => {
    const rows = buildLedger([user, copilotToGateway, gatewayToObs]);
    expect(rows[1]!.diff.mayActHonoured).toBe(true);
    expect(rows[2]!.diff.mayActHonoured).toBe(true);
  });

  it('flags a hop whose actor was NOT the one may_act named', () => {
    const rogue = {
      hop: 'agent-copilot → agentgateway',
      payload: { ...copilotToGateway.payload, act: { sub: SPECIALIST } },
    };
    const rows = buildLedger([user, rogue]);
    expect(rows[1]!.diff.mayActHonoured).toBe(false);
  });

  it('reports may_act as unchecked when the parent carries none', () => {
    const noMayAct = { hop: user.hop, payload: { ...user.payload, may_act: undefined } };
    const rows = buildLedger([noMayAct, copilotToGateway]);
    expect(rows[1]!.diff.mayActHonoured).toBeUndefined();
  });

  it('marks the audience as changed when it differs from the parent', () => {
    const rows = buildLedger([user, copilotToGateway]);
    expect(rows[1]!.diff.audChanged).toBe(true);
  });

  it('picks the parent by act-chain prefix, not by list position, so a second branch diffs against its real origin', () => {
    // Privileged flow: the specialist holds TWO tokens minted from the SAME
    // aud=agent-specialist delegation token. The ops:write hop appears AFTER the
    // whole obs:read branch in the flattened chain, but its parent is still the
    // specialist token — not obs-api's terminal token that precedes it in the list.
    const copilotToSpecialist = {
      hop: 'agent-copilot → agent-specialist',
      payload: {
        sub: 'alice',
        aud: 'agent-specialist',
        scope: 'obs:read ops:write llm:invoke',
        acr: 'mfa',
        act: { sub: COPILOT },
        may_act: { sub: SPECIALIST },
      },
    };
    const specToGatewayRead = {
      hop: 'agent-specialist → agentgateway (obs:read)',
      payload: {
        sub: 'alice',
        aud: 'mcp-gateway',
        scope: 'obs:read',
        acr: 'mfa',
        act: { sub: SPECIALIST, act: { sub: COPILOT } },
        may_act: { sub: GATEWAY },
      },
    };
    const gwToObs = {
      hop: 'agentgateway → mcp-observability',
      payload: {
        sub: 'alice',
        aud: 'mcp-observability',
        scope: 'obs:read',
        acr: 'mfa',
        act: { sub: GATEWAY, act: { sub: SPECIALIST, act: { sub: COPILOT } } },
      },
    };
    const specToGatewayWrite = {
      hop: 'agent-specialist → agentgateway (ops:write)',
      payload: {
        sub: 'alice',
        aud: 'mcp-gateway',
        scope: 'ops:write',
        acr: 'mfa',
        act: { sub: SPECIALIST, act: { sub: COPILOT } },
        may_act: { sub: GATEWAY },
      },
    };
    const rows = buildLedger([user, copilotToSpecialist, specToGatewayRead, gwToObs, specToGatewayWrite]);
    expect(rows[4]!.parentIndex).toBe(1);
    expect(rows[4]!.diff.scopesDropped).toEqual(['obs:read', 'llm:invoke']);
    expect(rows[4]!.diff.scopesKept).toEqual(['ops:write']);
    expect(rows[4]!.diff.actAppended).toBe('agent-specialist');
  });
});
