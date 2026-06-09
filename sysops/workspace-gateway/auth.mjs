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

import { timingSafeEqual } from 'node:crypto';

export const LIFECYCLE_GATEWAY_TOKEN_HEADER = 'x-lifecycle-gateway-token';

function tokenMatches(presentedToken, expectedToken) {
  if (typeof presentedToken !== 'string') {
    return false;
  }

  const presented = Buffer.from(presentedToken, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  // timingSafeEqual throws on length mismatch; a mismatch must be a 401, never a crash.
  if (presented.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(presented, expected);
}

function readBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') {
    return null;
  }

  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader);
  return match ? match[1] : null;
}

export function isAuthorizedGatewayRequest(authorizationHeader, expectedToken, gatewayTokenHeader) {
  if (!expectedToken) {
    return true;
  }

  return tokenMatches(readBearerToken(authorizationHeader), expectedToken) || tokenMatches(gatewayTokenHeader, expectedToken);
}

/** No-op when no token is configured (Kubernetes rollback safety: unset env ⇒ no enforcement). */
export function createGatewayAuthMiddleware(expectedToken) {
  if (!expectedToken) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    if (
      !isAuthorizedGatewayRequest(
        req.headers?.authorization,
        expectedToken,
        req.headers?.[LIFECYCLE_GATEWAY_TOKEN_HEADER]
      )
    ) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  };
}
