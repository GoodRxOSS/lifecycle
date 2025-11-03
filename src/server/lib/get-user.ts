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

import type { NextRequest } from 'next/server';
import type { JWTPayload } from 'jose';

const decode = <T = JWTPayload>(raw: string | null): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64url' as BufferEncoding).toString('utf8')) as T;
  } catch {
    return null;
  }
};

export function getUser(req: NextRequest): JWTPayload | null {
  const raw = req.headers.get('x-user');
  return decode<JWTPayload>(raw);
}
