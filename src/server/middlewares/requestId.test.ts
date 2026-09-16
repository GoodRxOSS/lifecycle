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

import { NextRequest, NextResponse } from 'next/server';
import { requestIdMiddleware } from './requestId';

const UUID = '12345678-1234-4123-8123-123456789abc';

describe('requestIdMiddleware', () => {
  beforeEach(() => {
    jest.spyOn(crypto, 'randomUUID').mockReturnValue(UUID);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['pads a short v2 resource', 'http://localhost/api/v2/ai', 'ai**'],
    ['keeps a four-character v2 resource', 'http://localhost/api/v2/sites', 'site'],
    ['truncates a long v2 resource', 'http://localhost/api/v2/repositories', 'repo'],
    ['ignores trailing slashes', 'http://localhost/api/v2/builds///', 'buil'],
    ['uses the generic prefix for v1', 'http://localhost/api/v1/builds', '****'],
    ['uses the generic prefix when v2 has no resource', 'http://localhost/api/v2/', '****'],
  ])('%s', async (_name, url, expectedPrefix) => {
    const next = jest.fn().mockResolvedValue(NextResponse.next());

    const response = await requestIdMiddleware(new NextRequest(url), next);

    const expectedRequestId = `${expectedPrefix}_${UUID}`;
    const forwardedRequest = next.mock.calls[0][0] as NextRequest;
    expect(next).toHaveBeenCalledTimes(1);
    expect(forwardedRequest.headers.get('x-request-id')).toBe(expectedRequestId);
    expect(response.headers.get('x-request-id')).toBe(expectedRequestId);
  });

  it('replaces an untrusted incoming request id on both request and response', async () => {
    const downstreamResponse = NextResponse.next();
    downstreamResponse.headers.set('x-request-id', 'downstream-value');
    const next = jest.fn().mockResolvedValue(downstreamResponse);
    const request = new NextRequest('http://localhost/api/v2/tokens', {
      headers: { 'x-request-id': 'caller-value' },
    });

    const response = await requestIdMiddleware(request, next);

    expect((next.mock.calls[0][0] as NextRequest).headers.get('x-request-id')).toBe(`toke_${UUID}`);
    expect(response.headers.get('x-request-id')).toBe(`toke_${UUID}`);
  });

  it.each(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'])('preserves native %s request semantics', async (method) => {
    const body = ['GET', 'HEAD'].includes(method) ? undefined : '{"action":"payload"}';
    const request = new NextRequest('https://example.test/api/v2/sites/browser/mint', {
      method,
      body,
      headers: { 'content-type': 'application/json' },
    });
    const next = jest.fn().mockResolvedValue(NextResponse.next());
    await requestIdMiddleware(request, next);
    const forwarded = next.mock.calls[0][0] as NextRequest;
    expect(forwarded.method).toBe(method);
    expect(await forwarded.text()).toBe(body || '');
    expect(forwarded.headers.get('content-type')).toBe('application/json');
  });

  it('preserves a POST arriving from the installed Edge Request constructor realm', async () => {
    // NextRequest's constructor branches on instanceof Request. Node-only probes
    // miss Edge instances that otherwise silently become GET without a body.
    const { EdgeRuntime } = require('next/dist/compiled/edge-runtime');
    const runtime = new EdgeRuntime();
    const body = '{"action":"cross-realm-payload"}';
    const foreignRequest = new runtime.context.Request('https://example.test/api/v2/sites/browser/mint', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    });
    expect(foreignRequest instanceof Request).toBe(false);
    const next = jest.fn().mockResolvedValue(NextResponse.next());
    await requestIdMiddleware(foreignRequest as NextRequest, next);
    const forwarded = next.mock.calls[0][0] as NextRequest;
    expect(forwarded.method).toBe('POST');
    expect(await forwarded.text()).toBe(body);
    expect(forwarded.headers.get('content-type')).toBe('application/json');
  });
});
