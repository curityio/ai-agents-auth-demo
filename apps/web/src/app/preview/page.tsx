// Dev-only visual preview of the authenticated UI — no Curity, no backend.
// Renders the real AppShell + Chat with seeded mock data so the redesign can be
// reviewed at http://localhost:3000/preview without standing up the cluster.
import { AppShell } from '@/components/app-shell';
import { Chat, type ChatPreview } from '../chat';

const nowSec = Math.floor(Date.now() / 1000);

const PREVIEW: ChatPreview = {
  response: {
    answer:
      'There are 4 pods running in the prod namespace:\n\n• order-service-7d9c8f5b6-2xk4q     Running   1/1\n• order-service-7d9c8f5b6-9pm7r     Running   1/1\n• checkout-service-6b4f9c7d8-lk3wz   Running   1/1\n• inventory-service-5c8d6f4b9-qr8vn  Running   1/1\n\nAll pods are healthy. No restarts in the last 24h.',
    identity: {
      sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot',
      scopes: ['obs:read'],
    },
    steps: [
      {
        toolCalls: [{ name: 'list_pods', args: { namespace: 'prod' } }],
        toolResults: [
          {
            name: 'list_pods',
            result: { count: 4, namespace: 'prod', status: 'all healthy' },
          },
        ],
        finishReason: 'stop',
      },
    ],
  },
  svids: [
    {
      workload: 'web',
      sub: 'spiffe://demo.curity.local/ns/web/sa/web',
      aud: ['https://curity.localtest.me/oauth/v2/oauth-token'],
      iss: 'https://oidc-discovery.demo.curity.local',
      iat: nowSec - 105,
      exp: nowSec + 195,
      ttl_seconds: 195,
    },
    {
      workload: 'agent-copilot',
      sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot',
      aud: ['https://curity.localtest.me/oauth/v2/oauth-token'],
      iss: 'https://oidc-discovery.demo.curity.local',
      iat: nowSec - 20,
      exp: nowSec + 280,
      ttl_seconds: 280,
    },
    {
      workload: 'mcp-observability',
      sub: 'spiffe://demo.curity.local/ns/mcp/sa/mcp-observability',
      aud: ['https://curity.localtest.me/oauth/v2/oauth-token'],
      iss: 'https://oidc-discovery.demo.curity.local',
      iat: nowSec - 172,
      exp: nowSec + 128,
      ttl_seconds: 128,
    },
  ],
  obo: {
    // The real read path, as /api/obo-chain returns it today: the user token,
    // then one exchanged token per hop through agentgateway to obs-api.
    chain: [
      {
        hop: 'user → agent-copilot (inbound)',
        header: { alg: 'RS256', kid: 'curity-1' },
        payload: {
          sub: 'alice',
          aud: 'agent-copilot',
          scope: 'openid obs:read ops:write llm:invoke',
          acr: 'mfa',
          roles: ['sre', 'oncall'],
          may_act: { sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot' },
          iat: nowSec - 60,
          exp: nowSec + 540,
        },
      },
      {
        // The model call: the same delegation narrowed to llm:invoke, the
        // copilot nested into act, and no may_act — a leaf, not a hop.
        hop: 'agent-copilot → agentgateway (/llm)',
        header: { alg: 'RS256', kid: 'curity-1' },
        payload: {
          sub: 'alice',
          aud: 'llm-gateway',
          scope: 'llm:invoke',
          acr: 'mfa',
          roles: ['sre', 'oncall'],
          act: { sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot' },
          iat: nowSec - 40,
          exp: nowSec + 560,
        },
        note: 'Model call — a leaf, not a hop toward the cluster. The LLM provider sits outside the trust domain, so nothing exchanges this token onward.',
      },
      {
        hop: 'agent-copilot → agentgateway (/observability/mcp)',
        header: { alg: 'RS256', kid: 'curity-1' },
        payload: {
          sub: 'alice',
          aud: 'mcp-gateway',
          scope: 'obs:read',
          acr: 'mfa',
          roles: ['sre', 'oncall'],
          act: { sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot' },
          may_act: { sub: 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway' },
          iat: nowSec - 40,
          exp: nowSec + 560,
        },
      },
      {
        hop: 'agentgateway → mcp-observability',
        header: { alg: 'RS256', kid: 'curity-1' },
        payload: {
          sub: 'alice',
          aud: 'mcp-observability',
          scope: 'obs:read',
          acr: 'mfa',
          roles: ['sre', 'oncall'],
          act: {
            sub: 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway',
            act: { sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot' },
          },
          may_act: { sub: 'spiffe://demo.curity.local/ns/mcp/sa/mcp-observability' },
          iat: nowSec - 30,
          exp: nowSec + 570,
        },
      },
      {
        hop: 'mcp-observability → obs-api',
        header: { alg: 'RS256', kid: 'curity-1' },
        payload: {
          sub: 'alice',
          aud: 'obs-api',
          scope: 'obs:read',
          acr: 'mfa',
          roles: ['sre', 'oncall'],
          act: {
            sub: 'spiffe://demo.curity.local/ns/mcp/sa/mcp-observability',
            act: {
              sub: 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway',
              act: { sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot' },
            },
          },
          iat: nowSec - 20,
          exp: nowSec + 580,
        },
      },
    ],
  },
  tools: {
    tiers: [
      {
        tier: 'observability',
        route: '/observability/mcp',
        status: 'ok',
        tools: [
          { name: 'list_pods', description: 'List pods in a namespace' },
          { name: 'get_pod_logs', description: 'Fetch recent logs for a pod' },
          { name: 'get_deployment', description: 'Describe a deployment' },
        ],
      },
      {
        tier: 'ops',
        route: '/ops/mcp',
        status: 'ok',
        tools: [
          { name: 'restart_deployment', description: 'Rollout-restart a deployment' },
          { name: 'scale_deployment', description: 'Set replica count' },
          {
            name: 'set_deployment_image',
            description: 'Set the container image',
            requiredRoles: ['sre'],
            callable: true,
          },
        ],
      },
    ],
  },
};

export default function PreviewPage() {
  return (
    <AppShell signedIn displayName="alice" email="alice@demo.curity.local">
      <Chat preview={PREVIEW} />
    </AppShell>
  );
}
