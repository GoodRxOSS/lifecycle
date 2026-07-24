/**
 * Copyright 2026 Lifecycle contributors
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

import { resolvePublicScheme, toPublicHref } from './publicHref';

describe('public hrefs', () => {
  describe('resolvePublicScheme', () => {
    test.each([
      [{ http: 'services.example.com', publicScheme: 'http' as const }, 'http'],
      [{ http: '127.0.0.1.nip.io', publicScheme: 'https' as const }, 'https'],
    ])('prefers the explicit public scheme in %p', (domainDefaults, expected) => {
      expect(resolvePublicScheme(domainDefaults)).toBe(expected);
    });

    test('uses HTTP for the exact documented local domain', () => {
      expect(resolvePublicScheme({ http: '127.0.0.1.nip.io' })).toBe('http');
    });

    test.each([
      undefined,
      null,
      {},
      { http: 'service.127.0.0.1.nip.io' },
      { http: '127.0.0.1.nip.io.' },
      { http: 'localhost' },
    ])('defaults non-local or missing config %p to HTTPS', (domainDefaults) => {
      expect(resolvePublicScheme(domainDefaults)).toBe('https');
    });
  });

  describe('toPublicHref', () => {
    test('builds an HTTP href for the local domain without mutating the host', () => {
      expect(toPublicHref('web-calm-waterfall-156345.127.0.0.1.nip.io', { http: '127.0.0.1.nip.io' })).toBe(
        'http://web-calm-waterfall-156345.127.0.0.1.nip.io'
      );
    });

    test('keeps custom hosts on HTTPS when the default local ingress uses HTTP', () => {
      expect(toPublicHref('web-calm-waterfall-156345.0env.com', { http: '127.0.0.1.nip.io' })).toBe(
        'https://web-calm-waterfall-156345.0env.com'
      );
    });

    test('builds an HTTPS href by default', () => {
      expect(toPublicHref('web.example.com')).toBe('https://web.example.com');
    });

    test.each(['http://external.example.com/path', 'HTTPS://external.example.com/path'])(
      'passes through the absolute URL %s',
      (publicUrl) => {
        expect(toPublicHref(publicUrl, { http: '127.0.0.1.nip.io', publicScheme: 'https' })).toBe(publicUrl);
      }
    );

    test.each([undefined, null, '', '   '])('returns null for an empty public URL %p', (publicUrl) => {
      expect(toPublicHref(publicUrl)).toBeNull();
    });
  });
});
