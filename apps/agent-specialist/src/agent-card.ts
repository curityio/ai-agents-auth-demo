import type { AgentCard } from '@a2a-js/sdk';
import type { Config } from './config.js';

/**
 * AgentCard published at /.well-known/agent-card.json. agent-copilot doesn't
 * currently re-fetch this card — it has the URL hard-wired via env — but
 * publishing it keeps the demo aligned with A2A's discoverability model and
 * lets human inspection (curl) show the security expectations.
 */
export function buildAgentCard(cfg: Config): AgentCard {
  return {
    name: 'agent-specialist',
    description:
      'LLM-driven privileged remediation specialist. Accepts an A2A task carrying ' +
      'a Bearer aud=agent-specialist (act.sub=agent-copilot), then autonomously ' +
      'inspects deployments (inspect:read) and remediates them — restart, set image, ' +
      'scale — via mcp-ops (ops:write), with MFA step-up enforced before any write.',
    url: `${cfg.publicBaseUrl}/a2a`,
    version: '0.0.1',
    protocolVersion: '0.3',
    preferredTransport: 'JSONRPC',
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    securitySchemes: {
      bearer: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: `Curity-issued JWT, aud=${cfg.expectedAudience}, act.sub=agent-copilot.`,
      },
    },
    security: [{ bearer: [] }],
    skills: [
      {
        id: 'inspect-deployment',
        name: 'Inspect Deployment',
        description:
          `Read a Deployment's current image, replica count, and ready/updated rollout ` +
          `status in the demo's 'prod' namespace via the inspect tier (inspect:read). ` +
          `Used to plan a remediation and to verify the result afterward.`,
        tags: ['kubernetes', 'inspect', 'read'],
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'restart-deployment',
        name: 'Restart Deployment',
        description:
          `Trigger a rolling restart of a Deployment in the demo's 'prod' namespace ` +
          `via mcp-ops (ops:write). Requires aud=agent-specialist, scope ops:write, ` +
          `act.sub=agent-copilot, and acr=mfa step-up.`,
        tags: ['kubernetes', 'restart', 'privileged'],
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'set-deployment-image',
        name: 'Set Deployment Image',
        description:
          `Update a Deployment's container image to a new version (rolling update) in ` +
          `the demo's 'prod' namespace via mcp-ops (ops:write). Requires ` +
          `aud=agent-specialist, scope ops:write, act.sub=agent-copilot, and acr=mfa step-up.`,
        tags: ['kubernetes', 'image', 'deploy', 'privileged'],
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'scale-deployment',
        name: 'Scale Deployment',
        description:
          `Set the replica count of a Deployment in the demo's 'prod' namespace via ` +
          `mcp-ops (ops:write). Requires aud=agent-specialist, scope ops:write, ` +
          `act.sub=agent-copilot, and acr=mfa step-up.`,
        tags: ['kubernetes', 'scale', 'privileged'],
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['application/json'],
      },
    ],
  };
}
