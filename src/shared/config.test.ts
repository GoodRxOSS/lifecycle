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

jest.mock('dotenv/config', () => ({}));

describe('shared runtime configuration', () => {
  const originalEnv = process.env;

  const loadConfig = (env: Record<string, string | undefined>) => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: 'postgres://test',
      LIFECYCLE_MODE: 'test',
      ...env,
    };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      }
    }

    let config: typeof import('./config');
    jest.isolateModules(() => {
      config = require('./config');
    });
    return config!;
  };

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  it('uses stable development defaults and versioned queue names', () => {
    const config = loadConfig({
      APP_ENV: undefined,
      APP_DB_PORT: undefined,
      APP_REDIS_PORT: undefined,
      JOB_VERSION: undefined,
      KEYCLOAK_ISSUER: undefined,
      GITHUB_APP_AUTH_CALLBACK: undefined,
      GITHUB_PRIVATE_KEY: undefined,
    });

    expect(config).toMatchObject({
      APP_ENV: 'development',
      IS_PROD: false,
      IS_STG: false,
      IS_DEV: true,
      APP_DB_PORT: 5432,
      APP_REDIS_PORT: 6379,
      GITHUB_PRIVATE_KEY: 'YOUR_VALUE_HERE',
      GITHUB_APP_AUTH_CALLBACK: 'http://localhost/realms/lifecycle/broker/github/endpoint',
    });
    expect(config.QUEUE_NAMES).toMatchObject({
      WEBHOOK_PROCESSING: 'webhook_processing_default',
      BUILD_QUEUE: 'build_queue_default',
      TTL_CLEANUP: 'ttl_cleanup',
      AGENT_RUN_EXECUTE: 'agent_run_execute',
    });
    expect(Object.values(config)).not.toContain(undefined);
  });

  it('uses supplied values, normalizes private-key escapes, and derives the broker callback', () => {
    const config = loadConfig({
      APP_ENV: 'production',
      JOB_VERSION: 'v42',
      APP_DB_PORT: '6543',
      GITHUB_PRIVATE_KEY: 'line-one\\nline-two\\kline-three',
      KEYCLOAK_ISSUER: 'https://auth.example/realms/lifecycle///',
      GITHUB_APP_AUTH_CALLBACK: undefined,
    });

    expect(config.IS_PROD).toBe(true);
    expect(config.IS_STG).toBe(false);
    expect(config.IS_DEV).toBe(false);
    expect(config.APP_DB_PORT).toBe('6543');
    expect(config.GITHUB_PRIVATE_KEY).toBe('line-one\nline-two\nline-three');
    expect(config.GITHUB_APP_AUTH_CALLBACK).toBe('https://auth.example/realms/lifecycle/broker/github/endpoint');
    expect(config.QUEUE_NAMES.WEBHOOK_PROCESSING).toBe('webhook_processing_v42');
  });

  it('lets an explicit GitHub callback override the issuer-derived value', () => {
    const config = loadConfig({
      APP_ENV: 'staging',
      KEYCLOAK_ISSUER: 'https://auth.example/realms/lifecycle',
      GITHUB_APP_AUTH_CALLBACK: 'https://public.example/github/callback',
    });

    expect(config.IS_STG).toBe(true);
    expect(config.IS_DEV).toBe(true);
    expect(config.GITHUB_APP_AUTH_CALLBACK).toBe('https://public.example/github/callback');
  });

  it('throws for a required missing value outside image-build mode', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: undefined,
        BUILD_MODE: undefined,
      })
    ).toThrow("Required config missing: 'DATABASE_URL'");
  });

  it('permits required values to be absent while producing build artifacts', () => {
    const config = loadConfig({
      DATABASE_URL: undefined,
      LIFECYCLE_MODE: undefined,
      BUILD_MODE: 'yes',
    });

    expect(config.DATABASE_URL).toBe('');
    expect(config.LIFECYCLE_MODE).toBe('');
  });
});
