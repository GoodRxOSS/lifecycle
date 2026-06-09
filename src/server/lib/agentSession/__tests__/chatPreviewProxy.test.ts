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
import {
  buildProxyHeaders,
  buildRemoteTargetUrl,
  parseCookieHeader,
  PREVIEW_PROXY_BLOCKED_QUERY_PARAMS,
  rewritePreviewResponseHeader,
  stripPreviewBootstrapParams,
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
  it('parses malformed cookie values without throwing', () => {
    expect(parseCookieHeader('ok=hello%20world; bad=%E0%A4%A; empty=')).toEqual({
      ok: 'hello world',
      bad: '%E0%A4%A',
      empty: '',
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
});
