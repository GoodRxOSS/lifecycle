/**
 * Copyright 2026 GoodRx, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { IncomingMessage } from 'http';

const mockBuildChatPreviewResolverUrl = jest.fn();
const mockGetChatPreviewGrantMaxAgeSeconds = jest.fn();

jest.mock('../chatPreviewFactory', () => ({
  buildChatPreviewResolverUrl: (...args: any[]) => mockBuildChatPreviewResolverUrl(...args),
}));

jest.mock('../chatPreviewGrant', () => ({
  getChatPreviewGrantMaxAgeSeconds: (...args: any[]) => mockGetChatPreviewGrantMaxAgeSeconds(...args),
}));

import {
  appendForwardQuery,
  buildChatPreviewAuthRedirectUrl,
  buildChatPreviewCookie,
  buildPreviewPublicOrigin,
  buildProxyHeaders,
  buildRemoteTargetUrl,
  mergeProxyExtraHeaders,
  parseCookieHeader,
  PREVIEW_PROXY_BLOCKED_QUERY_PARAMS,
  rewritePreviewResponseHeader,
  safeDecodeURIComponent,
  setHeaderCaseInsensitive,
  stripPreviewBootstrapParams,
  stripQueryParamsFromRequestUrl,
} from '../chatPreviewProxy';

function request(headers: IncomingMessage['headers']): IncomingMessage {
  return {
    headers,
    socket: {
      remoteAddress: '203.0.113.7',
    },
  } as IncomingMessage;
}

describe('chatPreviewProxy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildChatPreviewResolverUrl.mockReturnValue('https://lifecycle.example/preview/session-1/3000/');
    mockGetChatPreviewGrantMaxAgeSeconds.mockReturnValue(120);
  });

  it('decodes valid URI components and rejects malformed encodings', () => {
    expect(safeDecodeURIComponent('hello%20world')).toBe('hello world');
    expect(safeDecodeURIComponent('%E0%A4%A')).toBeNull();
  });

  it('parses malformed cookie values without throwing', () => {
    expect(parseCookieHeader('ok=hello%20world; bad=%E0%A4%A; empty=')).toEqual({
      ok: 'hello world',
      bad: '%E0%A4%A',
      empty: '',
    });
  });

  it('ignores malformed cookie entries and supports repeated cookie header lines', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader(['first=one', 'invalid-entry; =missing-key; second=two=parts'])).toEqual({
      first: 'one',
      second: 'two=parts',
    });
  });

  it('strips preview bootstrap credentials before proxying to a remote target', () => {
    const target = buildRemoteTargetUrl(
      'https://provider.example/base/',
      '/nested/path',
      {
        token: 'user-token',
        grant: 'opaque-grant',
        previewHost: '3000--slug.preview.example',
        keep: 'yes',
        repeated: ['one', 'two'],
      },
      { isWebSocket: true, blockedQueryParams: PREVIEW_PROXY_BLOCKED_QUERY_PARAMS }
    );

    expect(target.toString()).toBe('wss://provider.example/base/nested/path?keep=yes&repeated=one&repeated=two');
  });

  it('strips preview bootstrap credentials from browser-visible redirect locations', () => {
    expect(stripPreviewBootstrapParams('/app?token=user&grant=grant&previewHost=host&keep=yes')).toBe('/app?keep=yes');
    expect(stripQueryParamsFromRequestUrl(undefined, ['token'])).toBe('/');
  });

  it('builds the authentication redirect without forwarding bootstrap credentials', () => {
    const redirect = buildChatPreviewAuthRedirectUrl(
      {
        sessionId: 'session-1',
        port: 3000,
        forwardPath: 'nested/page',
        previewHost: '3000--slug.preview.example',
        previewSlug: 'slug',
      },
      {
        token: 'user-token',
        grant: 'old-grant',
        previewHost: 'attacker.example',
        keep: ['one', 'two'],
      }
    );

    expect(mockBuildChatPreviewResolverUrl).toHaveBeenCalledWith({ sessionUuid: 'session-1', port: 3000 });
    expect(redirect).toBe(
      'https://lifecycle.example/preview/session-1/3000/nested/page?keep=one&keep=two&previewHost=3000--slug.preview.example'
    );
  });

  it('keeps the resolver path unchanged for a root preview redirect', () => {
    const redirect = buildChatPreviewAuthRedirectUrl(
      {
        sessionId: 'session-1',
        port: 3000,
        forwardPath: '/',
        previewHost: '3000--slug.preview.example',
        previewSlug: 'slug',
      },
      {}
    );

    expect(redirect).toBe('https://lifecycle.example/preview/session-1/3000/?previewHost=3000--slug.preview.example');

    expect(
      buildChatPreviewAuthRedirectUrl(
        {
          sessionId: 'session-1',
          port: 3000,
          forwardPath: '/absolute',
          previewHost: '3000--slug.preview.example',
          previewSlug: 'slug',
        },
        {}
      )
    ).toBe('https://lifecycle.example/preview/session-1/3000/absolute?previewHost=3000--slug.preview.example');
  });

  it('builds scoped cookies with finite lifetime and secure transport attributes', () => {
    mockGetChatPreviewGrantMaxAgeSeconds.mockReturnValue(90);

    expect(buildChatPreviewCookie(request({ 'x-forwarded-proto': 'https' }), 'grant with spaces')).toBe(
      'lfc_chat_preview_auth=grant%20with%20spaces; Path=/; Max-Age=90; HttpOnly; SameSite=Lax; Secure'
    );
  });

  it('omits lifetime and secure attributes when the grant is unreadable over HTTP', () => {
    mockGetChatPreviewGrantMaxAgeSeconds.mockReturnValue(null);

    expect(buildChatPreviewCookie(request({}), 'invalid-grant')).toBe(
      'lfc_chat_preview_auth=invalid-grant; Path=/; HttpOnly; SameSite=Lax'
    );
  });

  it('recognizes an encrypted socket as a secure cookie request', () => {
    const encryptedRequest = request({});
    (encryptedRequest.socket as IncomingMessage['socket'] & { encrypted: boolean }).encrypted = true;

    expect(buildChatPreviewCookie(encryptedRequest, 'grant')).toContain('; Secure');
  });

  it('strips browser credentials and preserves proxy-owned forwarding headers over provider metadata', () => {
    const headers = buildProxyHeaders(
      request({
        host: '3000--slug.preview.example',
        cookie: 'next-auth.session-token=user',
        authorization: 'Bearer user-token',
        referer: 'https://app.example/new/session',
        origin: 'https://app.example',
        'x-forwarded-proto': 'https',
      }),
      new URL('https://provider.example/preview'),
      '',
      {
        Cookie: 'provider-cookie=bad',
        Origin: 'https://evil.example',
        'X-Forwarded-Host': 'evil.example',
        'X-Forwarded-Proto': 'http',
        'X-Forwarded-Prefix': '/evil',
        'X-Forwarded-For': '198.51.100.9',
        'X-Provider-Token': 'provider-secret',
      },
      false,
      true
    );

    expect(headers).toMatchObject({
      host: 'provider.example',
      'x-forwarded-host': '3000--slug.preview.example',
      'x-forwarded-proto': 'https',
      'x-forwarded-prefix': '',
      'x-forwarded-for': '203.0.113.7',
      'X-Provider-Token': 'provider-secret',
    });
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toEqual(
      expect.arrayContaining(['cookie', 'authorization', 'referer', 'referrer', 'origin'])
    );
  });

  it('filters unsafe provider metadata and replaces safe headers case-insensitively', () => {
    const headers = { 'X-Provider-Token': 'old', Existing: 'preserved' };

    mergeProxyExtraHeaders(headers, {
      'x-provider-token': 'new',
      Connection: 'close',
      'Content-Length': '999',
      Cookie: 'secret=value',
      'X-Real-IP': '198.51.100.1',
      '': 'ignored',
    });

    expect(headers).toEqual({ Existing: 'preserved', 'x-provider-token': 'new' });
    expect(Object.keys(headers)).toHaveLength(2);
  });

  it('sets a header with exactly one casing and leaves absent extra metadata unchanged', () => {
    const headers = { Authorization: 'old', authorization: 'duplicate' };

    setHeaderCaseInsensitive(headers, 'AUTHORIZATION', 'new');
    mergeProxyExtraHeaders(headers);

    expect(headers).toEqual({ AUTHORIZATION: 'new' });
  });

  it('uses target and socket fallbacks while retaining WebSocket upgrade headers', () => {
    const previewRequest = request({ connection: 'Upgrade', upgrade: 'websocket' });
    (previewRequest.socket as IncomingMessage['socket'] & { encrypted: boolean }).encrypted = true;

    const headers = buildProxyHeaders(
      previewRequest,
      new URL('https://provider.example/preview'),
      '/preview/session',
      undefined,
      true
    );

    expect(headers).toMatchObject({
      host: 'provider.example',
      'x-forwarded-host': 'provider.example',
      'x-forwarded-proto': 'https',
      'x-forwarded-prefix': '/preview/session',
      connection: 'Upgrade',
      upgrade: 'websocket',
    });

    expect(buildProxyHeaders(request({}), new URL('http://provider.example/'), '')).toMatchObject({
      host: 'provider.example',
      'x-forwarded-host': 'provider.example',
      'x-forwarded-proto': 'http',
    });
  });

  it('appends non-blocked query values and preserves existing target query parameters', () => {
    const target = new URL('https://provider.example/path?existing=yes');

    appendForwardQuery(target, { omitted: undefined, blocked: 'no', single: 'one', repeated: ['a', 'b'] }, ['BLOCKED']);

    expect(target.toString()).toBe('https://provider.example/path?existing=yes&single=one&repeated=a&repeated=b');
  });

  it('keeps HTTP transport and normalizes a relative forward path', () => {
    expect(buildRemoteTargetUrl('http://provider.example/base/', 'nested', {}, { isWebSocket: false }).toString()).toBe(
      'http://provider.example/base/nested'
    );
    expect(buildRemoteTargetUrl('http://provider.example/', '/', {}, { isWebSocket: true }).toString()).toBe(
      'ws://provider.example/'
    );
  });

  it('builds public origins from forwarded protocol, socket security, and host availability', () => {
    expect(buildPreviewPublicOrigin(request({ host: 'preview.example', 'x-forwarded-proto': 'http' }))).toBe(
      'http://preview.example'
    );

    const encryptedRequest = request({ host: 'secure.preview.example' });
    (encryptedRequest.socket as IncomingMessage['socket'] & { encrypted: boolean }).encrypted = true;
    expect(buildPreviewPublicOrigin(encryptedRequest)).toBe('https://secure.preview.example');
    expect(buildPreviewPublicOrigin(request({ host: 'plain.preview.example' }))).toBe('http://plain.preview.example');
    expect(buildPreviewPublicOrigin(request({}))).toBeNull();
  });

  it('rewrites upstream same-origin redirect headers to the public preview origin', () => {
    const targetUrl = new URL('https://provider.example/base/app');
    const previewRequest = request({
      host: '3000--slug.preview.example',
      'x-forwarded-proto': 'https',
    });

    expect(rewritePreviewResponseHeader('location', '/login?next=%2F', targetUrl, previewRequest, '')).toBe(
      'https://3000--slug.preview.example/login?next=%2F'
    );
    expect(
      rewritePreviewResponseHeader(
        'content-location',
        'https://provider.example/dashboard',
        targetUrl,
        previewRequest,
        ''
      )
    ).toBe('https://3000--slug.preview.example/dashboard');
    expect(rewritePreviewResponseHeader('refresh', '0;url="/next"', targetUrl, previewRequest, '')).toBe(
      '0;url="https://3000--slug.preview.example/next"'
    );
    expect(rewritePreviewResponseHeader('location', 'https://external.example/', targetUrl, previewRequest, '')).toBe(
      'https://external.example/'
    );
  });

  it('preserves malformed redirects, redirects without a public host, and unrelated headers', () => {
    const targetUrl = new URL('https://provider.example/base/app');

    expect(
      rewritePreviewResponseHeader('location', 'http://[', targetUrl, request({ host: 'preview.example' }), '/preview')
    ).toBe('http://[');
    expect(rewritePreviewResponseHeader('location', '/login', targetUrl, request({}), '/preview')).toBe('/login');
    expect(rewritePreviewResponseHeader('cache-control', 'private', targetUrl, request({}), '/preview')).toBe(
      'private'
    );
  });

  it('rewrites prefixed redirect paths and unquoted refresh targets', () => {
    const targetUrl = new URL('https://provider.example/base/app');
    const previewRequest = request({ host: 'preview.example', 'x-forwarded-proto': 'https' });

    expect(rewritePreviewResponseHeader('location', '/login?next=home#form', targetUrl, previewRequest, '/p/')).toBe(
      'https://preview.example/p/login?next=home#form'
    );
    expect(rewritePreviewResponseHeader('refresh', '5; url=/next', targetUrl, previewRequest, '/p')).toBe(
      '5; url=https://preview.example/p/next'
    );
    expect(rewritePreviewResponseHeader('refresh', '5', targetUrl, previewRequest, '/p')).toBe('5');
  });
});
