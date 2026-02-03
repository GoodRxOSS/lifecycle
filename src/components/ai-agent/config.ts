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

const API_PATHS = {
  config: '/api/v2/ai/config',
  models: '/api/v2/ai/models',
  messages: (buildUuid: string) => `/api/v2/ai/chat/${buildUuid}/messages`,
  session: (buildUuid: string) => `/api/v2/ai/chat/${buildUuid}/session`,
  chat: (buildUuid: string) => `/api/v2/ai/chat/${buildUuid}`,
} as const;

export function getApiPaths() {
  return API_PATHS;
}

export async function fetchApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  return json.data;
}
