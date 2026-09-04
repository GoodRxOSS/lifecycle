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

var mockK8sReadSecret: jest.Mock;
var mockLoadFromDefault: jest.Mock;
var mockMakeApiClient: jest.Mock;
var mockLoggerInfo: jest.Mock;
var mockLoggerWarn: jest.Mock;
var mockLoggerDebug: jest.Mock;
var mockUuid: jest.Mock;

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  mockK8sReadSecret = jest.fn();
  mockLoadFromDefault = jest.fn();
  mockMakeApiClient = jest.fn(() => ({ readNamespacedSecret: mockK8sReadSecret }));
  return {
    ...actual,
    KubeConfig: jest.fn(() => ({
      loadFromDefault: mockLoadFromDefault,
      makeApiClient: mockMakeApiClient,
    })),
  };
});

jest.mock('uuid', () => {
  mockUuid = jest.fn(() => 'generated-sync-token');
  return { v4: mockUuid };
});

jest.mock('server/lib/kubernetes/externalSecret', () => ({
  applyExternalSecret: jest.fn().mockResolvedValue(undefined),
  generateExternalSecretManifest: jest.requireActual('server/lib/kubernetes/externalSecret')
    .generateExternalSecretManifest,
  generateSecretName: jest.requireActual('server/lib/kubernetes/externalSecret').generateSecretName,
  groupSecretRefsByProvider: jest.requireActual('server/lib/kubernetes/externalSecret').groupSecretRefsByProvider,
  TARGET_SECRET_SYNC_TOKEN_ANNOTATION: jest.requireActual('server/lib/kubernetes/externalSecret')
    .TARGET_SECRET_SYNC_TOKEN_ANNOTATION,
}));

jest.mock('server/lib/logger', () => {
  mockLoggerInfo = jest.fn();
  mockLoggerWarn = jest.fn();
  mockLoggerDebug = jest.fn();
  return {
    getLogger: () => ({
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: jest.fn(),
      debug: mockLoggerDebug,
    }),
  };
});

import { SecretProcessor } from '../secretProcessor';
import { TARGET_SECRET_SYNC_TOKEN_ANNOTATION } from 'server/lib/kubernetes/externalSecret';
import { SecretProvidersConfig } from 'server/services/types/globalConfig';

describe('SecretProcessor', () => {
  const secretProviders: SecretProvidersConfig = {
    aws: {
      enabled: true,
      clusterSecretStore: 'aws-secretsmanager',
      refreshInterval: '1h',
    },
    gcp: {
      enabled: false,
      clusterSecretStore: 'gcp-sm',
      refreshInterval: '1h',
    },
  };

  let processor: SecretProcessor;

  beforeEach(() => {
    processor = new SecretProcessor(secretProviders);
    jest.clearAllMocks();
    mockK8sReadSecret.mockReset();
    mockUuid.mockReturnValue('generated-sync-token');
  });

  afterEach(() => {
    if (jest.isMockFunction(Date.now)) {
      (Date.now as jest.Mock).mockRestore();
    }
  });

  describe('waitForSecretSync', () => {
    it('creates and reuses one Kubernetes client across sync checks', async () => {
      mockK8sReadSecret.mockResolvedValue({
        body: { data: { API_TOKEN: 'dmFsdWU=' } },
      });

      await processor.waitForSecretSync({ 'first-secret': ['API_TOKEN'] }, 'test-ns', 5000);
      await processor.waitForSecretSync({ 'second-secret': ['API_TOKEN'] }, 'test-ns', 5000);

      expect(mockLoadFromDefault).toHaveBeenCalledTimes(1);
      expect(mockMakeApiClient).toHaveBeenCalledTimes(1);
      expect(mockK8sReadSecret.mock.calls).toEqual([
        ['first-secret', 'test-ns'],
        ['second-secret', 'test-ns'],
      ]);
      expect(mockLoggerInfo).toHaveBeenCalledTimes(2);
    });

    it('resolves when secret contains expected keys', async () => {
      const mockReadNamespacedSecret = jest.fn().mockResolvedValue({
        body: {
          data: { API_TOKEN: 'dmFsdWU=' },
        },
      });

      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });

      await expect(
        processor.waitForSecretSync({ 'my-secret': ['API_TOKEN'] }, 'test-ns', 5000)
      ).resolves.toBeUndefined();

      expect(mockReadNamespacedSecret).toHaveBeenCalledWith('my-secret', 'test-ns');
    });

    it('treats empty secret values as present keys', async () => {
      const mockReadNamespacedSecret = jest.fn().mockResolvedValue({
        body: {
          data: { EMPTY_TOKEN: '' },
        },
      });

      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });

      await expect(
        processor.waitForSecretSync({ 'my-secret': ['EMPTY_TOKEN'] }, 'test-ns', 5000)
      ).resolves.toBeUndefined();
    });

    it('throws error on timeout when secret does not exist', async () => {
      const mockReadNamespacedSecret = jest.fn().mockRejectedValue({ statusCode: 404 });

      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });
      jest.spyOn(processor as any, 'sleep').mockResolvedValue(undefined);
      jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1001);

      await expect(processor.waitForSecretSync({ 'my-secret': ['API_TOKEN'] }, 'test-ns', 1000)).rejects.toThrow(
        /Secret sync timeout.*missing keys=\[API_TOKEN\]/
      );
    });

    it('throws with missing keys listed when Secret data is empty', async () => {
      const mockReadNamespacedSecret = jest.fn().mockResolvedValue({
        body: { data: null },
      });

      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });
      jest.spyOn(processor as any, 'sleep').mockResolvedValue(undefined);
      jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1001);

      await expect(processor.waitForSecretSync({ 'my-secret': ['API_TOKEN'] }, 'test-ns', 1000)).rejects.toThrow(
        /Secret sync timeout.*missing keys=\[API_TOKEN\]/
      );
    });

    it('waits until an existing secret contains newly requested keys', async () => {
      const mockReadNamespacedSecret = jest
        .fn()
        .mockResolvedValueOnce({
          body: { data: { EXISTING_TOKEN: 'b2xk' } },
        })
        .mockResolvedValueOnce({
          body: { data: { EXISTING_TOKEN: 'b2xk', NEW_TOKEN: 'bmV3' } },
        });

      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });
      jest.spyOn(processor as any, 'sleep').mockResolvedValue(undefined);

      await expect(
        processor.waitForSecretSync({ 'sample-service-aws-secrets': ['EXISTING_TOKEN', 'NEW_TOKEN'] }, 'test-ns', 5000)
      ).resolves.toBeUndefined();

      expect(mockReadNamespacedSecret).toHaveBeenCalledTimes(2);
    });

    it('waits for the polling interval before reading a partial secret again', async () => {
      jest.useFakeTimers({ now: Date.parse('2026-08-27T12:00:00.000Z') });
      const mockReadNamespacedSecret = jest
        .fn()
        .mockResolvedValueOnce({ body: { data: {} } })
        .mockResolvedValueOnce({ body: { data: { API_TOKEN: 'dmFsdWU=' } } });
      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });

      try {
        const sync = processor.waitForSecretSync({ 'my-secret': ['API_TOKEN'] }, 'test-ns', 5000);
        await Promise.resolve();
        await Promise.resolve();
        expect(mockReadNamespacedSecret).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(999);
        expect(mockReadNamespacedSecret).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1);
        await expect(sync).resolves.toBeUndefined();
        expect(mockReadNamespacedSecret).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('waits until the secret has the expected sync token', async () => {
      const mockReadNamespacedSecret = jest
        .fn()
        .mockResolvedValueOnce({
          body: {
            data: { API_TOKEN: 'b2xk' },
            metadata: {
              annotations: {
                [TARGET_SECRET_SYNC_TOKEN_ANNOTATION]: 'old-token',
              },
            },
          },
        })
        .mockResolvedValueOnce({
          body: {
            data: { API_TOKEN: 'bmV3' },
            metadata: {
              annotations: {
                [TARGET_SECRET_SYNC_TOKEN_ANNOTATION]: 'new-token',
              },
            },
          },
        });

      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });
      jest.spyOn(processor as any, 'sleep').mockResolvedValue(undefined);

      await expect(
        processor.waitForSecretSync({ 'my-secret': ['API_TOKEN'] }, 'test-ns', 5000, {
          'my-secret': 'new-token',
        })
      ).resolves.toBeUndefined();

      expect(mockReadNamespacedSecret).toHaveBeenCalledTimes(2);
    });

    it('uses the default timeout and identifies an unobserved sync token', async () => {
      const mockReadNamespacedSecret = jest.fn().mockResolvedValue({
        body: { data: { API_TOKEN: 'dmFsdWU=' }, metadata: { annotations: {} } },
      });
      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });
      jest.spyOn(processor as any, 'sleep').mockResolvedValue(undefined);
      jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(60_001);

      await expect(
        processor.waitForSecretSync({ 'my-secret': ['API_TOKEN'] }, 'test-ns', undefined, {
          'my-secret': 'expected-token',
        })
      ).rejects.toThrow('Secret sync timeout: my-secret missing keys=[] sync token not observed after 60000ms');
    });

    it('reports only missing keys when the expected sync token was observed', async () => {
      const mockReadNamespacedSecret = jest.fn().mockResolvedValue({
        body: {
          data: {},
          metadata: {
            annotations: { [TARGET_SECRET_SYNC_TOKEN_ANNOTATION]: 'expected-token' },
          },
        },
      });
      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });
      jest.spyOn(processor as any, 'sleep').mockResolvedValue(undefined);
      jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1001);

      await expect(
        processor.waitForSecretSync({ 'my-secret': ['API_TOKEN'] }, 'test-ns', 1000, {
          'my-secret': 'expected-token',
        })
      ).rejects.toThrow('Secret sync timeout: my-secret missing keys=[API_TOKEN] after 1000ms');
    });

    it('propagates Kubernetes read failures other than not found without sleeping', async () => {
      const error = { statusCode: 403, message: 'forbidden' };
      const mockReadNamespacedSecret = jest.fn().mockRejectedValue(error);
      const sleep = jest.spyOn(processor as any, 'sleep').mockResolvedValue(undefined);
      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });

      await expect(processor.waitForSecretSync({ 'my-secret': ['API_TOKEN'] }, 'test-ns', 5000)).rejects.toBe(error);

      expect(sleep).not.toHaveBeenCalled();
    });

    it('waits through not found and partial keys until all requested keys land', async () => {
      const mockReadNamespacedSecret = jest
        .fn()
        .mockRejectedValueOnce({ statusCode: 404 })
        .mockResolvedValueOnce({
          body: { data: { FIRST_TOKEN: 'Zmlyc3Q=' } },
        })
        .mockResolvedValueOnce({
          body: { data: { FIRST_TOKEN: 'Zmlyc3Q=', SECOND_TOKEN: 'c2Vjb25k' } },
        });

      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });
      jest.spyOn(processor as any, 'sleep').mockResolvedValue(undefined);

      await processor.waitForSecretSync(
        { 'sample-service-aws-secrets': ['FIRST_TOKEN', 'SECOND_TOKEN'] },
        'test-ns',
        5000
      );

      expect(mockReadNamespacedSecret).toHaveBeenCalledTimes(3);
    });

    it('waits until the last requested key lands', async () => {
      const mockReadNamespacedSecret = jest
        .fn()
        .mockResolvedValueOnce({
          body: { data: { FIRST_TOKEN: 'Zmlyc3Q=' } },
        })
        .mockResolvedValueOnce({
          body: { data: { FIRST_TOKEN: 'Zmlyc3Q=', SECOND_TOKEN: 'c2Vjb25k' } },
        })
        .mockResolvedValueOnce({
          body: {
            data: {
              FIRST_TOKEN: 'Zmlyc3Q=',
              SECOND_TOKEN: 'c2Vjb25k',
              THIRD_TOKEN: 'dGhpcmQ=',
            },
          },
        });

      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });
      jest.spyOn(processor as any, 'sleep').mockResolvedValue(undefined);

      await processor.waitForSecretSync(
        { 'sample-service-aws-secrets': ['FIRST_TOKEN', 'SECOND_TOKEN', 'THIRD_TOKEN'] },
        'test-ns',
        5000
      );

      expect(mockReadNamespacedSecret).toHaveBeenCalledTimes(3);
    });

    it('waits for multiple secrets', async () => {
      const mockReadNamespacedSecret = jest.fn().mockResolvedValue({
        body: { data: { key: 'dmFsdWU=' } },
      });

      jest.spyOn(processor as any, 'getK8sClient').mockReturnValue({
        readNamespacedSecret: mockReadNamespacedSecret,
      });

      await processor.waitForSecretSync({ 'secret-1': ['key'], 'secret-2': ['key'] }, 'test-ns', 5000);

      expect(mockReadNamespacedSecret).toHaveBeenCalledWith('secret-1', 'test-ns');
      expect(mockReadNamespacedSecret).toHaveBeenCalledWith('secret-2', 'test-ns');
    });
  });

  describe('processEnvSecrets', () => {
    it('processes explicit env, init, and Helm refs with one sync token', async () => {
      const result = await processor.processSecretRefs({
        secretRefs: [
          { envKey: 'APP_TOKEN', provider: 'aws', path: 'myapp/app', key: 'APP_TOKEN' },
          { envKey: 'INIT_TOKEN', provider: 'aws', path: 'myapp/init', key: 'INIT_TOKEN' },
          { envKey: 'helm.auth.password.abc123', provider: 'aws', path: 'myapp/db', key: 'POSTGRES_PASSWORD' },
        ],
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
        buildUuid: 'abc123',
        syncToken: 'sync-123',
        strict: true,
      });

      expect(result.expectedKeysPerSecret).toEqual({
        'api-server-aws-secrets': ['APP_TOKEN', 'INIT_TOKEN', 'helm.auth.password.abc123'],
      });
      expect(result.syncTokensPerSecret).toEqual({
        'api-server-aws-secrets': 'sync-123',
      });
      expect(result.warnings).toEqual([]);
      expect(mockUuid).not.toHaveBeenCalled();
    });

    it('deduplicates identical references before generating the ExternalSecret', async () => {
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');
      const ref = { envKey: 'APP_TOKEN', provider: 'aws', path: 'myapp/app', key: 'token' };

      const result = await processor.processSecretRefs({
        secretRefs: [ref, { ...ref }],
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
        syncToken: 'sync-123',
      });

      expect(result.secretRefs).toEqual([ref]);
      expect(result.expectedKeysPerSecret).toEqual({ 'api-server-aws-secrets': ['APP_TOKEN'] });
      expect(result.warnings).toEqual([]);
      expect(applyExternalSecret).toHaveBeenCalledTimes(1);
    });

    it('keeps the first reference and warns when one environment key has conflicting remote refs', async () => {
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');
      const first = { envKey: 'APP_TOKEN', provider: 'aws', path: 'myapp/first', key: 'token' };

      const result = await processor.processSecretRefs({
        secretRefs: [first, { envKey: 'APP_TOKEN', provider: 'aws', path: 'myapp/second', key: 'token' }],
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
      });

      expect(result.secretRefs).toEqual([first]);
      expect(result.warnings).toEqual(['Secret reference APP_TOKEN has conflicting remote refs']);
      expect(mockLoggerWarn).toHaveBeenCalledWith('Secret reference APP_TOKEN has conflicting remote refs');
      expect(applyExternalSecret).toHaveBeenCalledTimes(1);
    });

    it('rejects conflicting references in strict mode before applying anything', async () => {
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');

      await expect(
        processor.processSecretRefs({
          secretRefs: [
            { envKey: 'APP_TOKEN', provider: 'aws', path: 'myapp/first', key: 'token' },
            { envKey: 'APP_TOKEN', provider: 'aws', path: 'myapp/second', key: 'token' },
          ],
          serviceName: 'api-server',
          namespace: 'lfc-abc123',
          strict: true,
        })
      ).rejects.toThrow('Secret reference APP_TOKEN has conflicting remote refs');

      expect(applyExternalSecret).not.toHaveBeenCalled();
    });

    it('throws for invalid refs in strict mode', async () => {
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');

      await expect(
        processor.processSecretRefs({
          secretRefs: [{ envKey: 'HELM_SECRET', provider: 'gcp', path: 'path', key: 'key' }],
          serviceName: 'api-server',
          namespace: 'lfc-abc123',
          strict: true,
        })
      ).rejects.toThrow("Secret provider 'gcp' is disabled");

      expect(applyExternalSecret).not.toHaveBeenCalled();
    });

    it('warns for an unconfigured processor and renders a missing remote property clearly', async () => {
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');
      const unconfiguredProcessor = new SecretProcessor(undefined);

      const result = await unconfiguredProcessor.processSecretRefs({
        secretRefs: [{ envKey: 'WHOLE_SECRET', provider: 'aws', path: 'myapp/config' }],
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
      });

      expect(result).toEqual({
        secretRefs: [],
        expectedKeysPerSecret: {},
        syncTokensPerSecret: {},
        warnings: ["Secret reference WHOLE_SECRET={{aws:myapp/config:}} skipped: Secret provider 'aws' not configured"],
      });
      expect(applyExternalSecret).not.toHaveBeenCalled();
    });

    it('extracts and validates secret references', async () => {
      const env = {
        DB_PASSWORD: '{{aws:myapp/db:password}}',
        APP_ENV: 'production',
      };

      const result = await processor.processEnvSecrets({
        env,
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
        buildUuid: 'abc123',
      });

      expect(result.secretRefs).toHaveLength(1);
      expect(result.secretRefs[0].envKey).toBe('DB_PASSWORD');
      expect(result.expectedKeysPerSecret).toEqual({
        'api-server-aws-secrets': ['DB_PASSWORD'],
      });
      expect(result.warnings).toHaveLength(0);
    });

    it('returns warning for disabled provider', async () => {
      const env = {
        GCP_SECRET: '{{gcp:path:key}}',
      };

      const result = await processor.processEnvSecrets({
        env,
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
      });

      expect(result.secretRefs).toHaveLength(0);
      expect(result.expectedKeysPerSecret).toEqual({});
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('disabled');
    });

    it('returns warning for unconfigured provider', async () => {
      const limitedConfig: SecretProvidersConfig = {
        aws: { enabled: true, clusterSecretStore: 'aws-sm', refreshInterval: '1h' },
      };
      const limitedProcessor = new SecretProcessor(limitedConfig);

      const env = {
        GCP_SECRET: '{{gcp:path:key}}',
      };

      const result = await limitedProcessor.processEnvSecrets({
        env,
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
      });

      expect(result.secretRefs).toHaveLength(0);
      expect(result.expectedKeysPerSecret).toEqual({});
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('not configured');
    });

    it('creates ExternalSecrets for valid refs', async () => {
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');

      const env = {
        DB_PASSWORD: '{{aws:myapp/db:password}}',
        DB_USER: '{{aws:myapp/db:username}}',
      };

      await processor.processEnvSecrets({
        env,
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
        buildUuid: 'abc123',
        syncToken: 'sync-123',
      });

      expect(applyExternalSecret).toHaveBeenCalledTimes(1);
      expect(applyExternalSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'api-server-aws-secrets',
            annotations: {
              'force-sync': 'sync-123',
            },
          }),
          spec: expect.objectContaining({
            target: expect.objectContaining({
              deletionPolicy: 'Merge',
              template: {
                metadata: expect.objectContaining({
                  annotations: {
                    [TARGET_SECRET_SYNC_TOKEN_ANNOTATION]: 'sync-123',
                  },
                }),
              },
            }),
          }),
        }),
        'lfc-abc123'
      );
    });

    it('creates separate ExternalSecrets for multiple providers', async () => {
      const multiProviderConfig: SecretProvidersConfig = {
        aws: { enabled: true, clusterSecretStore: 'aws-sm', refreshInterval: '1h' },
        gcp: { enabled: true, clusterSecretStore: 'gcp-sm', refreshInterval: '1h' },
      };
      const multiProcessor = new SecretProcessor(multiProviderConfig);
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');

      const env = {
        AWS_SECRET: '{{aws:path:key}}',
        GCP_SECRET: '{{gcp:path:key}}',
      };

      await multiProcessor.processEnvSecrets({
        env,
        serviceName: 'api-server',
        namespace: 'ns',
      });

      expect(applyExternalSecret).toHaveBeenCalledTimes(2);
    });

    it('handles empty env', async () => {
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');
      const result = await processor.processEnvSecrets({
        env: {},
        serviceName: 'api-server',
        namespace: 'ns',
      });

      expect(result.secretRefs).toHaveLength(0);
      expect(result.expectedKeysPerSecret).toEqual({});
      expect(result.warnings).toHaveLength(0);
      expect(applyExternalSecret).not.toHaveBeenCalled();
    });

    it('returns warning when ExternalSecret apply fails', async () => {
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');
      applyExternalSecret.mockRejectedValueOnce(new Error('kubectl failed'));

      const env = {
        DB_PASSWORD: '{{aws:myapp/db:password}}',
      };

      const result = await processor.processEnvSecrets({
        env,
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
      });

      expect(result.secretRefs).toHaveLength(1);
      expect(result.expectedKeysPerSecret).toEqual({});
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Failed to apply ExternalSecret');
    });

    it('formats an apply rejection with no error value without losing the warning', async () => {
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');
      applyExternalSecret.mockRejectedValueOnce(undefined);

      const result = await processor.processSecretRefs({
        secretRefs: [{ envKey: 'DB_PASSWORD', provider: 'aws', path: 'myapp/db', key: 'password' }],
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
      });

      expect(result.expectedKeysPerSecret).toEqual({});
      expect(result.syncTokensPerSecret).toEqual({});
      expect(result.warnings).toEqual(['Failed to apply ExternalSecret for api-server: undefined']);
    });

    it('continues to later providers after a non-strict apply failure and uses stderr in the warning', async () => {
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');
      applyExternalSecret.mockRejectedValueOnce({ stderr: 'kubectl connection refused' }).mockResolvedValueOnce();
      const multiProcessor = new SecretProcessor({
        aws: { enabled: true, clusterSecretStore: 'aws-sm', refreshInterval: '1h' },
        gcp: { enabled: true, clusterSecretStore: 'gcp-sm', refreshInterval: '1h' },
      });

      const result = await multiProcessor.processSecretRefs({
        secretRefs: [
          { envKey: 'AWS_SECRET', provider: 'aws', path: 'aws/path', key: 'value' },
          { envKey: 'GCP_SECRET', provider: 'gcp', path: 'gcp/path', key: 'value' },
        ],
        serviceName: 'api-server',
        namespace: 'lfc-abc123',
        syncToken: 'sync-123',
      });

      expect(result.secretRefs).toHaveLength(2);
      expect(result.expectedKeysPerSecret).toEqual({ 'api-server-gcp-secrets': ['GCP_SECRET'] });
      expect(result.syncTokensPerSecret).toEqual({ 'api-server-gcp-secrets': 'sync-123' });
      expect(result.warnings).toEqual(['Failed to apply ExternalSecret for api-server: kubectl connection refused']);
      expect(applyExternalSecret).toHaveBeenCalledTimes(2);
    });

    it('stops immediately when an ExternalSecret apply rejects in strict mode', async () => {
      const { applyExternalSecret } = require('server/lib/kubernetes/externalSecret');
      applyExternalSecret.mockRejectedValueOnce('apply interrupted');
      const multiProcessor = new SecretProcessor({
        aws: { enabled: true, clusterSecretStore: 'aws-sm', refreshInterval: '1h' },
        gcp: { enabled: true, clusterSecretStore: 'gcp-sm', refreshInterval: '1h' },
      });

      await expect(
        multiProcessor.processSecretRefs({
          secretRefs: [
            { envKey: 'AWS_SECRET', provider: 'aws', path: 'aws/path', key: 'value' },
            { envKey: 'GCP_SECRET', provider: 'gcp', path: 'gcp/path', key: 'value' },
          ],
          serviceName: 'api-server',
          namespace: 'lfc-abc123',
          strict: true,
        })
      ).rejects.toThrow('Failed to apply ExternalSecret for api-server: apply interrupted');

      expect(applyExternalSecret).toHaveBeenCalledTimes(1);
    });

    it('returns expected keys by secret for mounting', async () => {
      const env = {
        AWS_SECRET: '{{aws:path:key}}',
        GCP_SECRET: '{{gcp:path:key}}',
      };

      const multiProcessor = new SecretProcessor({
        aws: { enabled: true, clusterSecretStore: 'aws-sm', refreshInterval: '1h' },
        gcp: { enabled: true, clusterSecretStore: 'gcp-sm', refreshInterval: '1h' },
      });

      const result = await multiProcessor.processEnvSecrets({
        env,
        serviceName: 'api-server',
        namespace: 'ns',
      });

      expect(result.expectedKeysPerSecret).toEqual({
        'api-server-aws-secrets': ['AWS_SECRET'],
        'api-server-gcp-secrets': ['GCP_SECRET'],
      });
      expect(result.syncTokensPerSecret).toEqual({
        'api-server-aws-secrets': 'generated-sync-token',
        'api-server-gcp-secrets': 'generated-sync-token',
      });
      expect(mockUuid).toHaveBeenCalledTimes(1);
    });
  });
});
