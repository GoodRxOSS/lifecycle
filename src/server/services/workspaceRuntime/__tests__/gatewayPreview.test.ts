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

import {
  buildWorkspaceGatewayPreviewEndpoint,
  parsePersistedPreviewEndpoint,
  resolvePersistedPreviewEndpointWithAuth,
} from '../gatewayPreview';

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

  it('parses the persisted endpoint URL and never trusts persisted headers', () => {
    expect(
      parsePersistedPreviewEndpoint({
        url: 'http://gateway.internal/preview/3000',
        headers: {
          'x-lifecycle-gateway-token': 'legacy-plaintext-token',
        },
      })
    ).toEqual({
      url: 'http://gateway.internal/preview/3000',
    });
  });

  it('returns null for invalid persisted exposure state', () => {
    expect(parsePersistedPreviewEndpoint({ headers: { h: 'v' } })).toBeNull();
    expect(parsePersistedPreviewEndpoint({ url: 'ssh://gateway.internal/preview/3000' })).toBeNull();
    expect(parsePersistedPreviewEndpoint({ url: 'https://token@gateway.internal/preview/3000' })).toBeNull();
    expect(parsePersistedPreviewEndpoint({ url: 'not a url' })).toBeNull();
    expect(parsePersistedPreviewEndpoint(null)).toBeNull();
  });

  it('merges freshly resolved gateway auth headers onto the persisted endpoint', async () => {
    await expect(
      resolvePersistedPreviewEndpointWithAuth({ url: 'http://gateway.internal/preview/3000' }, async () => ({
        url: 'http://gateway.internal',
        headers: { 'x-lifecycle-gateway-token': 'fresh-token' },
      }))
    ).resolves.toEqual({
      url: 'http://gateway.internal/preview/3000',
      headers: { 'x-lifecycle-gateway-token': 'fresh-token' },
    });
  });

  it('degrades to the persisted headerless endpoint when auth resolution throws', async () => {
    await expect(
      resolvePersistedPreviewEndpointWithAuth({ url: 'http://gateway.internal/preview/3000' }, () =>
        Promise.reject(new Error('Unsupported state or unable to authenticate data'))
      )
    ).resolves.toEqual({ url: 'http://gateway.internal/preview/3000' });
  });

  it('returns null when the persisted exposure state is unusable regardless of auth resolution', async () => {
    const resolveGatewayEndpoint = jest.fn();
    await expect(resolvePersistedPreviewEndpointWithAuth(null, resolveGatewayEndpoint)).resolves.toBeNull();
    expect(resolveGatewayEndpoint).not.toHaveBeenCalled();
  });
});
