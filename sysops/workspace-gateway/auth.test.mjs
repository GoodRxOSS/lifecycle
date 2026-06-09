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

import test from 'node:test';
import assert from 'node:assert/strict';
import { LIFECYCLE_GATEWAY_TOKEN_HEADER, createGatewayAuthMiddleware, isAuthorizedGatewayRequest } from './auth.mjs';

const TOKEN = 'a'.repeat(64);

test('isAuthorizedGatewayRequest allows everything when no token is configured', () => {
  assert.equal(isAuthorizedGatewayRequest(undefined, ''), true);
  assert.equal(isAuthorizedGatewayRequest('Bearer whatever', ''), true);
  assert.equal(isAuthorizedGatewayRequest(undefined, undefined), true);
});

test('isAuthorizedGatewayRequest accepts the exact bearer token (scheme case-insensitive)', () => {
  assert.equal(isAuthorizedGatewayRequest(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(isAuthorizedGatewayRequest(`bearer ${TOKEN}`, TOKEN), true);
  assert.equal(isAuthorizedGatewayRequest(`Bearer  ${TOKEN}`, TOKEN), true);
});

test('isAuthorizedGatewayRequest accepts the proxy-safe gateway token header', () => {
  assert.equal(isAuthorizedGatewayRequest(undefined, TOKEN, TOKEN), true);
  assert.equal(isAuthorizedGatewayRequest(`Bearer ${'b'.repeat(64)}`, TOKEN, TOKEN), true);
});

test('isAuthorizedGatewayRequest rejects missing, malformed, and non-bearer credentials', () => {
  assert.equal(isAuthorizedGatewayRequest(undefined, TOKEN), false);
  assert.equal(isAuthorizedGatewayRequest('', TOKEN), false);
  assert.equal(isAuthorizedGatewayRequest(TOKEN, TOKEN), false);
  assert.equal(isAuthorizedGatewayRequest(`Basic ${TOKEN}`, TOKEN), false);
  assert.equal(isAuthorizedGatewayRequest('Bearer', TOKEN), false);
  assert.equal(isAuthorizedGatewayRequest(`Bearer ${TOKEN} extra`, TOKEN), false);
});

test('isAuthorizedGatewayRequest rejects length mismatches without throwing (timingSafeEqual pre-check)', () => {
  assert.doesNotThrow(() => {
    assert.equal(isAuthorizedGatewayRequest('Bearer short', TOKEN), false);
    assert.equal(isAuthorizedGatewayRequest(`Bearer ${TOKEN}${TOKEN}`, TOKEN), false);
  });
});

test('isAuthorizedGatewayRequest rejects an equal-length wrong token', () => {
  assert.equal(isAuthorizedGatewayRequest(`Bearer ${'b'.repeat(64)}`, TOKEN), false);
  assert.equal(isAuthorizedGatewayRequest(undefined, TOKEN, 'b'.repeat(64)), false);
});

function runMiddleware(middleware, headersOrAuthorization) {
  let statusCode = null;
  let body = null;
  let nextCalled = false;
  const req = {
    headers:
      headersOrAuthorization === undefined
        ? {}
        : typeof headersOrAuthorization === 'string'
        ? { authorization: headersOrAuthorization }
        : headersOrAuthorization,
  };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { statusCode, body, nextCalled };
}

test('middleware passes through when no token is configured', () => {
  const result = runMiddleware(createGatewayAuthMiddleware(''), undefined);
  assert.deepEqual(result, { statusCode: null, body: null, nextCalled: true });
});

test('middleware responds 401 JSON for unauthenticated requests and never calls next', () => {
  const middleware = createGatewayAuthMiddleware(TOKEN);

  for (const authorization of [undefined, 'Bearer wrong-length', `Bearer ${'b'.repeat(64)}`]) {
    const result = runMiddleware(middleware, authorization);
    assert.equal(result.statusCode, 401);
    assert.deepEqual(result.body, { error: 'Unauthorized' });
    assert.equal(result.nextCalled, false);
  }
});

test('middleware calls next for the correct bearer token', () => {
  const result = runMiddleware(createGatewayAuthMiddleware(TOKEN), `Bearer ${TOKEN}`);
  assert.deepEqual(result, { statusCode: null, body: null, nextCalled: true });
});

test('middleware calls next for the correct proxy-safe gateway token header', () => {
  const result = runMiddleware(createGatewayAuthMiddleware(TOKEN), { [LIFECYCLE_GATEWAY_TOKEN_HEADER]: TOKEN });
  assert.deepEqual(result, { statusCode: null, body: null, nextCalled: true });
});
