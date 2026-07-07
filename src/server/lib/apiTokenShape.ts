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

// Import-free so the Edge middleware can share it with the Node verifier.
export const API_TOKEN_PATTERN = /^lfc_(pat_|svc_)?[a-f0-9]{40}$/;

/** Bearer scheme is case-insensitive (RFC 7235); the key itself is not. */
export function bearerApiKey(header: string | null): string | null {
  const token = header?.match(/^bearer\s+(.+)$/i)?.[1].trim() ?? null;
  return token && API_TOKEN_PATTERN.test(token) ? token : null;
}
