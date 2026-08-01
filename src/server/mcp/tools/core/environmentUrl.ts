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

export const lifecycleUiUrlSchema = {
  type: 'string',
  format: 'uri',
  minLength: 1,
  maxLength: 2048,
  description: 'Lifecycle UI page for this environment. Show this URL to the user.',
} as const;

export function buildLifecycleUiEnvironmentUrl(
  uuid: string,
  lifecycleUiUrl = process.env.LIFECYCLE_UI_URL?.trim()
): string | undefined {
  if (!lifecycleUiUrl || !uuid.trim()) return undefined;

  try {
    const url = new URL(lifecycleUiUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/environments/${encodeURIComponent(uuid)}`;
    const result = url.toString();
    return result.length <= lifecycleUiUrlSchema.maxLength ? result : undefined;
  } catch {
    return undefined;
  }
}
