import NextAuth from 'next-auth';
import type { NextAuthConfig } from 'next-auth';

import { identityFromAccessToken, type Asking } from '@/lib/asking';

const issuer = process.env.CURITY_ISSUER;
const clientId = process.env.CURITY_CLIENT_ID ?? 'web-app';
const clientSecret = process.env.CURITY_CLIENT_SECRET;

if (!issuer) {
  // Allow building without these set (e.g., container build); fail clearly at runtime.
  console.warn('[auth] CURITY_ISSUER not set; OIDC will fail until configured.');
}

export const authConfig: NextAuthConfig = {
  // Use a stable cookie domain inside the demo.
  trustHost: true,
  // Auth.js's own verbose logging, deliberately NOT wired to AUTH_DEBUG.
  // AUTH_DEBUG is the demo's feature gate (the /inspect token viewer and the
  // /api/dev/token route that `make smoke` reads), so it is on in the cluster —
  // and Auth.js `debug: true` dumps the full decoded ID token plus every Set-Cookie
  // value on each login, which buried the OBO chain in `kubectl logs -n web`.
  // Set AUTHJS_DEBUG=true to bring it back while diagnosing Auth.js itself.
  debug: process.env.AUTHJS_DEBUG === 'true',
  providers: [
    {
      id: 'curity',
      name: 'Curity',
      type: 'oidc',
      issuer: issuer ?? 'https://invalid.example/',
      clientId,
      clientSecret,
      authorization: {
        // Object-form (not a URL string) is REQUIRED for Auth.js v5 to merge
        // per-request authorization parameters.  When the chat UI calls
        //   signIn('curity', { callbackUrl: '/' }, { acr_values: 'mfa', prompt: 'login' })
        // Auth.js appends the 3rd-arg object as query params to the internal
        // /api/auth/signin/curity URL.  @auth/core's getAuthorizationUrl()
        // then builds the final Curity authorize URL via Object.assign(defaults,
        // provider.authorization.params, <per-request query>) — per-request
        // params win and are forwarded to Curity.  Step-up overrides acr_values
        // and prompt per-request (e.g. acr_values=mfa, prompt=login).
        params: {
          scope: 'openid obs:read llm:invoke',
          // Least-privilege: request read-only observability + the unprivileged
          // LLM-egress scope at login (both are non-MFA). The user consents to
          // llm:invoke so agents can exchange it to aud=llm-gateway on their
          // behalf. ops:write is obtained on-demand via RFC 9470 step-up (MFA).
          acr_values: 'html-form',
          prompt: 'consent',
        },
      },
      // Curity returns the standard set; rely on discovery.
      checks: ['pkce', 'state'],
    },
  ],
  session: { strategy: 'jwt' },
  callbacks: {
    async jwt({ token, account, profile }) {
      // (The former `auth.jwt.account` log answered "did Curity return an
      // access_token at all?" during initial client setup. /api/whoami reports
      // the same thing on demand, so it is no longer worth a line per login.)

      // Stash the Curity access token on the session JWT so server routes
      // can forward it to the agent. NEVER expose to the browser.
      if (account?.access_token) {
        token.accessToken = account.access_token;
        token.tokenType = account.token_type ?? 'Bearer';
        token.expiresAt = account.expires_at;
      }
      if (profile?.sub) token.sub = profile.sub;
      return token;
    },
    async session({ session, token }) {
      // Expose only what the browser needs (NOT the access token).
      if (token.sub) session.user = { ...session.user, id: token.sub };
      // The claims the next request will carry (sub/roles/acr) — decoded here
      // so the Ask card can state them before Send. Not the token itself.
      session.asking = identityFromAccessToken(token.accessToken);
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

declare module 'next-auth/jwt' {
  interface JWT {
    accessToken?: string;
    tokenType?: string;
    expiresAt?: number;
  }
}

declare module 'next-auth' {
  interface User {
    id?: string;
  }
  interface Session {
    asking?: Asking;
  }
}
