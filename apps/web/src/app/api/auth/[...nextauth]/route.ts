import { handlers } from '@/auth';

// NOTE: this route deliberately has no logging wrapper. It previously logged the
// full inbound URL to diagnose whether `127.0.0.1` -> `localhost` rewriting
// happened in the browser, the ingress, or server-side. That question is settled
// (see CLAUDE.md fact #1: everything is on `*.localtest.me` precisely because
// Curity's RFC 8252 loopback canonicalization rewrote `127.0.0.1`), and the log
// line wrote the OIDC `code` and `state` query params to stdout on every
// callback — i.e. an authorization code, in plaintext, in `kubectl logs`.
export const { GET, POST } = handlers;
