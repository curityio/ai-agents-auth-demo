import { handlers } from '@/auth';

// Debug wrapper (AUTH_DEBUG=true): logs the URL + Host header the pod actually
// sees, to tell whether 127.0.0.1 -> localhost rewriting happens in the browser,
// the ingress, or somewhere server-side.
function logIncoming(label: string, request: Request) {
  if (process.env.AUTH_DEBUG !== 'true') return;
  try {
    const u = new URL(request.url);
    console.log(
      JSON.stringify({
        tag: 'auth.incoming',
        label,
        url: request.url,
        'url.host': u.host,
        'url.search': u.search,
        'header.host': request.headers.get('host'),
        'header.x-forwarded-host': request.headers.get('x-forwarded-host'),
        'header.x-forwarded-proto': request.headers.get('x-forwarded-proto'),
      }),
    );
  } catch (e) {
    console.log('auth.incoming.log_error', String(e));
  }
}

export const GET: typeof handlers.GET = async (request) => {
  logIncoming('GET', request);
  return handlers.GET(request);
};

export const POST: typeof handlers.POST = async (request) => {
  logIncoming('POST', request);
  return handlers.POST(request);
};
