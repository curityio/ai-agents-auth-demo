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
      ttl_seconds: 195,
    },
    {
      workload: 'agent-copilot',
      sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot',
      aud: ['https://curity.localtest.me/oauth/v2/oauth-token'],
      iss: 'https://oidc-discovery.demo.curity.local',
      ttl_seconds: 280,
    },
    {
      workload: 'mcp-observability',
      sub: 'spiffe://demo.curity.local/ns/mcp/sa/mcp-observability',
      aud: ['https://curity.localtest.me/oauth/v2/oauth-token'],
      iss: 'https://oidc-discovery.demo.curity.local',
      ttl_seconds: 128,
    },
  ],
  obo: {
    chain: [
      {
        hop: 'user → web',
        header: { alg: 'RS256', kid: 'curity-1' },
        payload: {
          sub: 'alice',
          scope: 'openid obs:read',
          iat: nowSec - 60,
          exp: nowSec + 540,
        },
      },
      {
        hop: 'web → agent-copilot',
        header: { alg: 'RS256', kid: 'curity-1' },
        payload: {
          sub: 'alice',
          scope: 'obs:read',
          act: { sub: 'spiffe://demo.curity.local/ns/web/sa/web' },
          iat: nowSec - 40,
          exp: nowSec + 260,
        },
      },
      {
        hop: 'agent-copilot → mcp-observability',
        header: { alg: 'RS256', kid: 'curity-1' },
        payload: {
          sub: 'alice',
          scope: 'obs:read',
          act: {
            sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot',
            act: { sub: 'spiffe://demo.curity.local/ns/web/sa/web' },
          },
          iat: nowSec - 20,
          exp: nowSec + 110,
        },
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
