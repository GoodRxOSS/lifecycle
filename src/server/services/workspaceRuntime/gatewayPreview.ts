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

import type { WorkspaceRuntimeEndpoint } from './types';

export const WORKSPACE_GATEWAY_PREVIEW_PATH_PREFIX = '/preview';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readHttpUrl(value: unknown): string | undefined {
  const raw = readString(value);
  if (!raw) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return undefined;
  }

  return parsed.toString();
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === 'string' && entry.trim() ? [[key, entry] as const] : []
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function buildWorkspaceGatewayPreviewEndpoint(
  gatewayEndpoint: WorkspaceRuntimeEndpoint,
  port: number
): WorkspaceRuntimeEndpoint {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Preview port must be an integer between 1 and 65535.');
  }

  const url = new URL(gatewayEndpoint.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Workspace gateway preview endpoint must use http(s) without URL credentials.');
  }
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}${WORKSPACE_GATEWAY_PREVIEW_PATH_PREFIX}/${port}`;
  url.search = '';
  url.hash = '';

  return {
    url: url.toString(),
    ...(gatewayEndpoint.headers ? { headers: gatewayEndpoint.headers } : {}),
  };
}

export function parsePersistedPreviewEndpoint(exposureState: unknown): WorkspaceRuntimeEndpoint | null {
  if (!isRecord(exposureState)) {
    return null;
  }

  const url = readHttpUrl(exposureState.url);
  if (!url) {
    return null;
  }

  const headers = readStringRecord(exposureState.headers);
  return {
    url,
    ...(headers ? { headers } : {}),
  };
}
