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

import { buildWorkspaceGatewayPreviewEndpoint, parsePersistedPreviewEndpoint } from '../gatewayPreview';

describe('gatewayPreview', () => {
  it('builds a workspace gateway preview endpoint without leaking query or hash from the gateway URL', () => {
    expect(
      buildWorkspaceGatewayPreviewEndpoint(
        {
          url: 'https://gateway.example.test/base/?token=secret#fragment',
          headers: { 'x-lifecycle-gateway-token': 'token-1' },
        },
        3000
      )
    ).toEqual({
      url: 'https://gateway.example.test/base/preview/3000',
      headers: { 'x-lifecycle-gateway-token': 'token-1' },
    });
  });

  it('rejects invalid preview ports', () => {
    expect(() => buildWorkspaceGatewayPreviewEndpoint({ url: 'https://gateway.example.test' }, 0)).toThrow(
      /Preview port/
    );
    expect(() => buildWorkspaceGatewayPreviewEndpoint({ url: 'https://gateway.example.test' }, 65536)).toThrow(
      /Preview port/
    );
    expect(() => buildWorkspaceGatewayPreviewEndpoint({ url: 'ssh://gateway.example.test' }, 3000)).toThrow(
      /http\(s\)/
    );
    expect(() => buildWorkspaceGatewayPreviewEndpoint({ url: 'https://user:pass@gateway.example.test' }, 3000)).toThrow(
      /http\(s\)/
    );
  });

  it('parses persisted exposure endpoint state and ignores non-string headers', () => {
    expect(
      parsePersistedPreviewEndpoint({
        url: 'http://gateway.internal/preview/3000',
        headers: {
          'x-lifecycle-gateway-token': 'token-1',
          'x-bad': 123,
        },
      })
    ).toEqual({
      url: 'http://gateway.internal/preview/3000',
      headers: { 'x-lifecycle-gateway-token': 'token-1' },
    });
  });

  it('returns null for invalid persisted exposure state', () => {
    expect(parsePersistedPreviewEndpoint({ headers: { h: 'v' } })).toBeNull();
    expect(parsePersistedPreviewEndpoint({ url: 'ssh://gateway.internal/preview/3000' })).toBeNull();
    expect(parsePersistedPreviewEndpoint({ url: 'https://token@gateway.internal/preview/3000' })).toBeNull();
    expect(parsePersistedPreviewEndpoint({ url: 'not a url' })).toBeNull();
    expect(parsePersistedPreviewEndpoint(null)).toBeNull();
  });
});
