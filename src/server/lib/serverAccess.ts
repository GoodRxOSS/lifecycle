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

// Shared with Edge middleware: keep this module free of Node-only imports.
type AuthenticationEnvironment = { APP_ENV?: string; ENABLE_AUTH?: string };

export const AUTHENTICATION_UNAVAILABLE = {
  code: 'authentication_unavailable',
  message: 'Authentication is not configured on this server.',
} as const;

export function isLocalAuthDisabled(
  environment: AuthenticationEnvironment = { APP_ENV: process.env.APP_ENV, ENABLE_AUTH: process.env.ENABLE_AUTH }
): boolean {
  return ['dev', 'development'].includes(environment.APP_ENV || '') && environment.ENABLE_AUTH !== 'true';
}

export function isInteractiveAuthUnavailable(
  environment: AuthenticationEnvironment = { APP_ENV: process.env.APP_ENV, ENABLE_AUTH: process.env.ENABLE_AUTH }
): boolean {
  return environment.ENABLE_AUTH !== 'true' && !isLocalAuthDisabled(environment);
}

export function canServeLogs(mode: string | undefined): boolean {
  return (
    ['web', 'gateway', 'all'].includes(mode || '') && (process.env.ENABLE_AUTH === 'true' || isLocalAuthDisabled())
  );
}

export function isWorkerProbe(method: string | undefined, pathname: string | null | undefined): boolean {
  return method === 'GET' && (pathname === '/api/health' || pathname === '/api/jobs');
}

export function isLogHttpPath(pathname: string | null | undefined): boolean {
  let path: string;
  try {
    path = new URL(
      decodeURIComponent(pathname || '')
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/'),
      'http://lifecycle.invalid'
    ).pathname
      .replace(/\/+$/, '')
      .toLowerCase();
  } catch {
    return true;
  }
  return (
    path === '/api/logs/stream' ||
    path === '/api/v2/logs/stream-tickets' ||
    /^\/api\/v1\/builds\/[^/]+\/services\/[^/]+\/(logs|buildlogs|deploylogs)(\/[^/]+)?$/.test(path) ||
    /^\/api\/v1\/builds\/[^/]+\/jobs\/[^/]+\/logs$/.test(path) ||
    /^\/api\/v2\/builds\/[^/]+\/services\/[^/]+\/(build-jobs|deploy-jobs)(\/[^/]+)?$/.test(path)
  );
}
