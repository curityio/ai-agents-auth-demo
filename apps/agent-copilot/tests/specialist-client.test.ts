/**
 * Unit tests for callSpecialist — step-up detection and normal success path.
 *
 * Mocking approach: DI seam (_sendMessage optional param on callSpecialist).
 * Rationale: callSpecialist constructs Client internally; vi.mock of the SDK
 * would require patching Client.prototype before module load and would be
 * brittle to SDK internals.  A small optional injection param is the least-invasive
 * seam that keeps the prod path unchanged (default = real Client.sendMessage).
 */
import { describe, it, expect } from 'vitest';
import type { Message, Task } from '@a2a-js/sdk';
import { callSpecialist } from '../src/specialist-client.js';
import type { Config } from '../src/config.js';

// Minimal config — only the fields callSpecialist reads
const cfg = {
  specialistA2aUrl: 'http://specialist.test',
} as unknown as Config;

const baseOpts = {
  cfg,
  bearer: 'test-bearer-token',
  request: { goal: 'restart api-gateway', deployment: 'api-gateway', namespace: 'prod', reason: 'test' },
};

// ── helpers ────────────────────────────────────────────────────────────────

function makeStepUpMessage(): Message {
  return {
    kind: 'message',
    role: 'agent',
    messageId: 'm1',
    parts: [
      {
        kind: 'text',
        text: JSON.stringify({
          code: -33001,
          message: 'step-up required: acr_values=mfa',
          data: {
            acrValues: 'mfa',
            resourceMetadata: 'https://mcp-ops.localtest.me/.well-known/oauth-protected-resource',
            scope: 'ops:write',
          },
        }),
      },
    ],
  };
}

function makeCompletedTask(): Task {
  const agentMsg: Message = {
    kind: 'message',
    role: 'agent',
    messageId: 'msg-agent',
    parts: [{ kind: 'text', text: 'Restart completed successfully.' }],
  };
  return {
    kind: 'task',
    id: 'task-1',
    status: {
      state: 'completed',
      message: agentMsg,
    },
    history: [agentMsg],
  } as unknown as Task;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('callSpecialist — step-up (Message branch)', () => {
  it('returns status:"step-up" with stepUp fields when specialist sends a step-up Message', async () => {
    const result = await callSpecialist({
      ...baseOpts,
      _sendMessage: async () => makeStepUpMessage(),
    });

    expect(result.status).toBe('step-up');
    expect(result.ok).toBe(false);
    expect(result.stepUp).toEqual({
      acrValues: 'mfa',
      resourceMetadata: 'https://mcp-ops.localtest.me/.well-known/oauth-protected-resource',
      scope: 'ops:write',
    });
  });
});

describe('callSpecialist — normal completed Task', () => {
  it('returns ok:true / status:"completed" for a normal completed Task response', async () => {
    const result = await callSpecialist({
      ...baseOpts,
      _sendMessage: async () => makeCompletedTask(),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.stepUp).toBeUndefined();
  });
});

describe('callSpecialist — failure payload must NOT be reported as success', () => {
  function makeErrorMessage(payload: unknown): Message {
    return {
      kind: 'message',
      role: 'agent',
      messageId: 'm-err',
      parts: [{ kind: 'text', text: JSON.stringify(payload) }],
    };
  }

  it('reports ok:false / status:"failed" for an {error:"access_denied"} Message (was masked as completed)', async () => {
    const result = await callSpecialist({
      ...baseOpts,
      _sendMessage: async () =>
        makeErrorMessage({
          error: 'access_denied',
          error_description: "user lacks required role 'sre' for ops:write",
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect((result.result as { error?: string }).error).toBe('access_denied');
  });

  it('reports ok:false for an {ok:false} tool-error Message', async () => {
    const result = await callSpecialist({
      ...baseOpts,
      _sendMessage: async () => makeErrorMessage({ ok: false, mcp_response: 'boom' }),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
  });

  it('still reports ok:true for a genuine {ok:true} success Message', async () => {
    const result = await callSpecialist({
      ...baseOpts,
      _sendMessage: async () => makeErrorMessage({ ok: true, mcp_response: { restarted: true } }),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('completed');
  });
});
