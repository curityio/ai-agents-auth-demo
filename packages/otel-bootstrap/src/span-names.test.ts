import { describe, it, expect, vi } from 'vitest';
import { outboundSpanName, inboundSpanName, undiciRequestHook, httpRequestHook } from './span-names.js';

const fakeSpan = () => ({ updateName: vi.fn() });

describe('outboundSpanName', () => {
  it('is METHOD /path — the path alone tells the hops apart here, and the host stays in server.address', () => {
    expect(outboundSpanName('POST', 'https://mcp-gateway.localtest.me', '/inspect/mcp'))
      .toBe('POST /inspect/mcp');
  });
  it('does not put the host or port in the name', () => {
    expect(outboundSpanName('POST', 'http://agentgateway.mcp.svc.cluster.local:8080', '/llm/chat/completions'))
      .toBe('POST /llm/chat/completions');
  });
  it('drops the query string (it can carry parameters and inflates cardinality)', () => {
    expect(outboundSpanName('GET', 'http://inspect-api.apis.svc.cluster.local:8084', '/pods?namespace=prod'))
      .toBe('GET /pods');
  });
  it('still yields METHOD /path when the origin is not a URL', () => {
    expect(outboundSpanName('POST', 'not a url', '/x?y=1')).toBe('POST /x');
  });
});

describe('inboundSpanName', () => {
  it('is METHOD /path', () => {
    expect(inboundSpanName('POST', '/chat')).toBe('POST /chat');
  });
  it('drops the query string', () => {
    expect(inboundSpanName('GET', '/pods?namespace=prod')).toBe('GET /pods');
  });
});

describe('undiciRequestHook', () => {
  it('renames the fetch client span from the undici request', () => {
    const span = fakeSpan();
    undiciRequestHook(span as never, { method: 'GET', origin: 'https://curity.localtest.me', path: '/.well-known/oauth-authorization-server/oauth/v2/oauth-anonymous' } as never);
    expect(span.updateName).toHaveBeenCalledWith('GET /.well-known/oauth-authorization-server/oauth/v2/oauth-anonymous');
  });
});

describe('httpRequestHook', () => {
  it('names an INCOMING request (IncomingMessage: method + url) by its path', () => {
    const span = fakeSpan();
    httpRequestHook(span as never, { method: 'POST', url: '/chat?x=1', headers: {} } as never);
    expect(span.updateName).toHaveBeenCalledWith('POST /chat');
  });
  it('names an OUTGOING request (ClientRequest: host + path) by its path', () => {
    const span = fakeSpan();
    httpRequestHook(span as never, { method: 'POST', protocol: 'https:', host: 'curity.localtest.me', path: '/oauth/v2/oauth-token?x=1' } as never);
    expect(span.updateName).toHaveBeenCalledWith('POST /oauth/v2/oauth-token');
  });
  it('leaves the span alone when it cannot tell what it is looking at', () => {
    const span = fakeSpan();
    httpRequestHook(span as never, {} as never);
    expect(span.updateName).not.toHaveBeenCalled();
  });
});
