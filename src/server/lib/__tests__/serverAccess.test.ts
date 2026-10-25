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

import {
  canServeLogs,
  isInteractiveAuthUnavailable,
  isLocalAuthDisabled,
  isLogHttpPath,
  isWorkerProbe,
} from '../serverAccess';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('server access boundaries', () => {
  it.each(['web', 'gateway', 'all'])('permits protected log service in %s mode', (mode) => {
    process.env.ENABLE_AUTH = 'true';
    process.env.APP_ENV = 'production';
    expect(canServeLogs(mode)).toBe(true);
  });

  it.each(['job', 'unknown', undefined])('denies log service in %s mode even with authentication', (mode) => {
    process.env.ENABLE_AUTH = 'true';
    expect(canServeLogs(mode)).toBe(false);
  });

  it.each(['production', 'staging', undefined])('does not treat APP_ENV=%s as local development', (environment) => {
    delete process.env.ENABLE_AUTH;
    if (environment === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = environment;
    expect(isLocalAuthDisabled()).toBe(false);
    expect(canServeLogs('web')).toBe(false);
  });

  it.each(['dev', 'development'])('allows auth-disabled logs in explicit %s mode', (environment) => {
    process.env.APP_ENV = environment;
    delete process.env.ENABLE_AUTH;
    expect(isLocalAuthDisabled()).toBe(true);
    expect(canServeLogs('all')).toBe(true);
    expect(canServeLogs('job')).toBe(false);
  });

  it.each(['/api/health', '/api/jobs'])('permits the exact GET probe %s', (path) => {
    expect(isWorkerProbe('GET', path)).toBe(true);
    expect(isWorkerProbe('POST', path)).toBe(false);
    expect(isWorkerProbe('HEAD', path)).toBe(false);
    expect(isWorkerProbe('GET', `${path}/`)).toBe(false);
  });

  it.each([
    '/api/logs/stream',
    '/api/v2/logs/stream-tickets',
    '/api/v1/builds/a/services/b/logs',
    '/api/v1/builds/a/services/b/logs/job',
    '/api/v1/builds/a/services/b/buildLogs',
    '/api/v1/builds/a/services/b/buildLogs/job',
    '/api/v1/builds/a/services/b/deployLogs',
    '/api/v1/builds/a/services/b/deployLogs/job',
    '/api/v1/builds/a/jobs/job/logs',
    '/api/v2/builds/a/services/b/build-jobs',
    '/api/v2/builds/a/services/b/build-jobs/job',
    '/api/v2/builds/a/services/b/deploy-jobs',
    '/api/v2/builds/a/services/b/deploy-jobs/job',
    '/api/v2/%6cogs/stream-tickets',
    '//api//v2/logs/stream-tickets/',
    '/api/v2/other/../logs/stream-tickets',
    '/api/v2/other/%2e%2e/logs/stream-tickets',
  ])('recognizes the direct log route %s', (path) => {
    expect(isLogHttpPath(path)).toBe(true);
  });

  it.each(['/api/health', '/api/jobs', '/api/webhooks/github', '/', '/setup', '/api/v2/builds'])(
    'preserves non-log route %s',
    (path) => {
      expect(isLogHttpPath(path)).toBe(false);
    }
  );
});

describe('interactive authentication policy', () => {
  it.each(['production', 'staging', undefined])('requires enabled auth outside explicit local mode: %s', (APP_ENV) => {
    for (const ENABLE_AUTH of [undefined, '', 'false', 'TRUE', '1']) {
      expect(isInteractiveAuthUnavailable({ APP_ENV, ENABLE_AUTH })).toBe(true);
    }
    expect(isInteractiveAuthUnavailable({ APP_ENV, ENABLE_AUTH: 'true' })).toBe(false);
  });

  it.each(['dev', 'development'])('preserves local development access in %s', (APP_ENV) => {
    expect(isInteractiveAuthUnavailable({ APP_ENV })).toBe(false);
    expect(isInteractiveAuthUnavailable({ APP_ENV, ENABLE_AUTH: 'false' })).toBe(false);
    expect(isInteractiveAuthUnavailable({ APP_ENV, ENABLE_AUTH: 'true' })).toBe(false);
  });
});
