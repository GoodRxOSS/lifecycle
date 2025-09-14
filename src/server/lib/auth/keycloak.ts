/**
 * Copyright 2025 GoodRx, Inc.
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

import { createRemoteJWKSet, jwtVerify } from 'jose';

const issuer = process.env.KEYCLOAK_ISSUER!;

// Keycloak JWKS endpoint
const JWKS = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));

export async function verifyAccessToken(token: string) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer,
    clockTolerance: 5,
  });
  return payload;
}
