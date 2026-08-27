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

const mockAvailableEnvironmentVariablesForBuild = jest.fn();
const mockBuildEnvironmentVariablesConstructor = jest.fn();

jest.mock('server/lib/buildEnvVariables', () => ({
  BuildEnvironmentVariables: jest.fn().mockImplementation((database) => {
    mockBuildEnvironmentVariablesConstructor(database);
    return {
      availableEnvironmentVariablesForBuild: (...args: unknown[]) => mockAvailableEnvironmentVariablesForBuild(...args),
    };
  }),
}));

jest.mock('server/models', () => ({}));

jest.mock('shared/config', () => ({
  APP_HOST: 'https://api.lifecycle.example',
  LIFECYCLE_UI_URL: 'https://lifecycle.example',
}));

const {
  createBannerVars,
  ingressBannerSnippet,
  renderTemplate,
  scaffoldHelmSecretRefs,
  serializeHelmEnvArray,
  serializeHelmEnvMap,
} = require('../utils') as typeof import('../utils');

describe('Helm utility behavior', () => {
  beforeEach(() => {
    mockAvailableEnvironmentVariablesForBuild.mockReset();
    mockBuildEnvironmentVariablesConstructor.mockReset();
  });

  describe('renderTemplate', () => {
    const database = { name: 'build-database' };
    const mockKnex = jest.fn(() => database);
    const build = {
      $knex: mockKnex,
    } as unknown as Parameters<typeof renderTemplate>[0];

    beforeEach(() => {
      mockKnex.mockClear();
      mockAvailableEnvironmentVariablesForBuild.mockResolvedValue({
        IMAGE_TAG: 'release-7',
        SERVICE_NAME: 'payments',
      });
    });

    it('renders each value, preserves separators and secret refs, and restores hyphens', async () => {
      await expect(
        renderTemplate(build, [
          'image.tag={{IMAGE_TAG}}',
          'service-name={{SERVICE_NAME}}',
          'credential={{aws:repo/example:API-KEY}}',
        ])
      ).resolves.toEqual(['image.tag=release-7', 'service-name=payments', 'credential={{aws:repo/example:API-KEY}}']);

      expect(mockKnex).toHaveBeenCalledTimes(1);
      expect(mockBuildEnvironmentVariablesConstructor).toHaveBeenCalledWith(database);
      expect(mockAvailableEnvironmentVariablesForBuild).toHaveBeenCalledWith(build);
    });

    it('preserves the current empty-value result when values are omitted', async () => {
      await expect(renderTemplate(build)).resolves.toEqual(['']);

      expect(mockAvailableEnvironmentVariablesForBuild).toHaveBeenCalledWith(build);
    });

    it('propagates environment-resolution failures without attempting a partial result', async () => {
      const resolutionError = new Error('environment lookup failed');
      mockAvailableEnvironmentVariablesForBuild.mockRejectedValueOnce(resolutionError);

      await expect(renderTemplate(build, ['image.tag={{IMAGE_TAG}}'])).rejects.toBe(resolutionError);
    });
  });

  describe('scaffoldHelmSecretRefs', () => {
    it('returns the original environment map when it contains no secret refs', () => {
      const env = {
        ENABLED: true,
        PLAIN_TEXT: 'value',
        RETRIES: 3,
      };

      expect(scaffoldHelmSecretRefs(env, 'payments', 'buildkit')).toBe(env);
    });

    it('scaffolds native-build secret refs while preserving ordinary and non-string values', () => {
      const env = {
        API_KEY: '{{aws:repo/payments:API_KEY}}',
        ENABLED: true,
        PLAIN_TEXT: 'value',
        RETRIES: 3,
      };

      expect(scaffoldHelmSecretRefs(env, 'payments-api', 'kaniko')).toEqual({
        API_KEY: {
          valueFrom: {
            secretKeyRef: {
              name: 'payments-api-aws-secrets',
              key: 'API_KEY',
            },
          },
        },
        ENABLED: true,
        PLAIN_TEXT: 'value',
        RETRIES: 3,
      });
    });

    it('does not scaffold refs without a service name or native build engine', () => {
      const env = { API_KEY: '{{aws:repo/payments:API_KEY}}' };

      expect(scaffoldHelmSecretRefs(env, undefined, 'buildkit')).toBe(env);
      expect(scaffoldHelmSecretRefs(env, 'payments', 'docker')).toBe(env);
      expect(scaffoldHelmSecretRefs(undefined, 'payments', 'buildkit')).toEqual({});
    });
  });

  describe('environment serialization', () => {
    it('serializes nested maps, arrays, scalars and nulls with transformed keys', () => {
      const keyTransform = jest.fn((key: string) => key.toLowerCase());

      expect(
        serializeHelmEnvMap(
          {
            COUNT: 3,
            ENABLED: false,
            ITEMS: ['first', 2, false, null, { name: 'last' }],
            NESTED: { path: 'api', retries: 2, skipped: null },
            NIL: null,
            TEXT: 'hello world',
          },
          'app.env',
          { keyTransform, quoteStringValues: true }
        )
      ).toEqual([
        'app.env.count=3',
        'app.env.enabled=false',
        'app.env.items[0]="first"',
        'app.env.items[1]=2',
        'app.env.items[2]=false',
        'app.env.items[4].name="last"',
        'app.env.nested.path="api"',
        'app.env.nested.retries=2',
        'app.env.text="hello world"',
      ]);
      expect(keyTransform).toHaveBeenCalledTimes(6);
    });

    it('returns no map values or transformations for an absent environment', () => {
      const keyTransform = jest.fn((key: string) => key);

      expect(serializeHelmEnvMap(undefined, 'app.env', { keyTransform })).toEqual([]);
      expect(keyTransform).not.toHaveBeenCalled();
    });

    it('serializes array entries while retaining names for null and object values', () => {
      expect(
        serializeHelmEnvArray(
          {
            TEXT: 'hello',
            COUNT: 2,
            ENABLED: false,
            NIL: null,
            SECRET: { valueFrom: { secretKeyRef: { name: 'app-secret', key: 'SECRET' } } },
          },
          'app.env',
          { quoteStringValues: true }
        )
      ).toEqual([
        'app.env[0].name=TEXT',
        'app.env[0].value="hello"',
        'app.env[1].name=COUNT',
        'app.env[1].value=2',
        'app.env[2].name=ENABLED',
        'app.env[2].value=false',
        'app.env[3].name=NIL',
        'app.env[4].name=SECRET',
        'app.env[4].value="[object Object]"',
      ]);
    });

    it('preserves the native array-format stringification of scaffolded secret refs', () => {
      const scaffolded = scaffoldHelmSecretRefs({ API_KEY: '{{aws:repo/payments:API_KEY}}' }, 'payments', 'buildkit');

      expect(serializeHelmEnvArray(scaffolded, 'app.env')).toEqual([
        'app.env[0].name=API_KEY',
        'app.env[0].value=[object Object]',
      ]);
    });

    it('returns no array values for an absent environment', () => {
      expect(serializeHelmEnvArray(null, 'app.env')).toEqual([]);
    });
  });

  describe('banner generation', () => {
    const deploy = {
      branchName: 'feature/banner',
      build: {
        createdAt: '2026-08-27T12:00:00.000Z',
        pullRequest: {
          fullName: 'goodrx/lifecycle',
          githubLogin: 'octocat',
          pullRequestNumber: 42,
        },
        uuid: 'environment-123',
      },
      buildLogs: 'https://logs.example/build-123',
      deployable: { name: 'payments' },
      sha: 'abc123',
      status: 'deployed',
    } as unknown as Parameters<typeof createBannerVars>[1];

    it('normalizes banner labels, optional URLs, and deployment metadata', () => {
      expect(
        createBannerVars(
          [
            { label: 'SHA', value: 'abc123' },
            { label: 'Docs', value: 'Open', url: 'https://docs.example' },
            { label: 'Optional', value: 'No link', url: '' },
          ],
          deploy
        )
      ).toBe(
        'window.LFC_BANNER = [{"label":"sha","value":"abc123"},{"label":"docs","value":"Open","url":"https://docs.example"},{"label":"optional","value":"No link"}];\n' +
          'window.LFC_UUID = "environment-123";\n' +
          'window.LFC_SERVICE_NAME = "payments";\n' +
          'window.LFC_BASE_URL = "https://api.lifecycle.example";\n' +
          'window.LFC_DEPLOY_STATUS = "deployed";\n' +
          'window.LFC_CREATED_AT = "2026-08-27T12:00:00.000Z";\n' +
          'window.LFC_DASHBOARD_URL = "https://lifecycle.example/environments/environment-123";'
      );
    });

    it('includes pull-request and build links in the ingress snippet', () => {
      const result = ingressBannerSnippet(deploy);
      const snippet = result.metadata.annotations['nginx.ingress.kubernetes.io/configuration-snippet'];

      expect(snippet).toContain('proxy_set_header Accept-Encoding "";');
      expect(snippet).toContain(
        '<script type="text/javascript" src="https://api.lifecycle.example/utils/0-banner.js" defer></script>'
      );
      expect(snippet).toContain('{"label":"pr owner","value":"octocat"}');
      expect(snippet).toContain('{"label":"pr","value":"42","url":"https://github.com/goodrx/lifecycle/pull/42"}');
      expect(snippet).toContain('{"label":"build","value":"Logs","url":"https://logs.example/build-123"}');
    });
  });
});
