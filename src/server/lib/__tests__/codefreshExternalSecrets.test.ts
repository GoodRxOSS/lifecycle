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

const mockProcessSecretRefs = jest.fn();
const mockWaitForSecretSync = jest.fn();
const mockReadNamespacedSecret = jest.fn();
const mockDeleteNamespacedSecret = jest.fn();
const mockCreateOrUpdateNamespace = jest.fn();
const mockDeleteExternalSecret = jest.fn();
const mockWarn = jest.fn();

jest.mock('server/services/secretProcessor', () => ({
  SecretProcessor: jest.fn().mockImplementation(() => ({
    processSecretRefs: (...args: any[]) => mockProcessSecretRefs(...args),
    waitForSecretSync: (...args: any[]) => mockWaitForSecretSync(...args),
  })),
}));

jest.mock('@kubernetes/client-node', () => ({
  CoreV1Api: jest.fn(),
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn(() => ({
      readNamespacedSecret: (...args: any[]) => mockReadNamespacedSecret(...args),
      deleteNamespacedSecret: (...args: any[]) => mockDeleteNamespacedSecret(...args),
    })),
  })),
}));

jest.mock('server/lib/kubernetes', () => ({
  createOrUpdateNamespace: (...args: any[]) => mockCreateOrUpdateNamespace(...args),
}));

jest.mock('server/lib/kubernetes/externalSecret', () => ({
  deleteExternalSecret: (...args: any[]) => mockDeleteExternalSecret(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: mockWarn }),
}));

import {
  cleanupCodefreshExternalSecrets,
  hasCodefreshExternalSecretRefs,
  resolveCodefreshExternalSecrets,
} from '../codefreshExternalSecrets';

describe('resolveCodefreshExternalSecrets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadNamespacedSecret.mockReset();
    mockDeleteNamespacedSecret.mockReset().mockResolvedValue(undefined);
    mockDeleteExternalSecret.mockReset().mockResolvedValue(undefined);
    mockProcessSecretRefs.mockReset().mockImplementation(({ secretRefs }) => ({
      secretRefs,
      expectedKeysPerSecret: { 'lfc-example-service-aws': secretRefs.map((ref: any) => ref.envKey) },
      syncTokensPerSecret: { 'lfc-example-service-aws': 'sync-token' },
      warnings: [],
    }));
    mockWaitForSecretSync.mockReset().mockResolvedValue(undefined);
    mockCreateOrUpdateNamespace.mockReset().mockResolvedValue(undefined);
  });

  test('detects secret references recursively without treating ordinary values as secrets', () => {
    expect(
      hasCodefreshExternalSecretRefs({
        PLAIN: 'value',
        BOOLEAN: true,
        EMPTY: null,
        NESTED: { list: ['value', { token: '{{vault:path/to/secret:key}}' }] },
      })
    ).toBe(true);
    expect(hasCodefreshExternalSecretRefs({ PLAIN: 'value', ARRAY: [1, false, null], OBJECT: { key: 'value' } })).toBe(
      false
    );
  });

  test('returns the original environment without provider calls when it has no secret references', async () => {
    const env = { PLAIN: 'value', NESTED: { enabled: true } };

    const result = await resolveCodefreshExternalSecrets({ env, secretProviders: undefined });

    expect(result.env).toBe(env);
    expect(result.secretEnvKeys).toEqual(new Set());
    expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    expect(mockProcessSecretRefs).not.toHaveBeenCalled();
  });

  test('requires provider configuration and identifies each affected top-level key once', async () => {
    await expect(
      resolveCodefreshExternalSecrets({
        env: {
          CONFIG: ['{{aws:repo/example:first}}', '{{aws:repo/example:second}}'],
          TOKEN: '{{gcp:projects/example/secrets/token:latest}}',
        },
        serviceName: 'example-service',
        namespace: 'env-build-uuid',
        buildUuid: 'build-uuid',
        secretProviders: undefined,
      })
    ).rejects.toThrow(
      'Codefresh secret resolution failed for env keys [CONFIG, TOKEN]: external secret providers are not configured.'
    );
    expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
  });

  test.each([
    [{ namespace: 'env-build-uuid', serviceName: undefined }, 'service name and namespace are required'],
    [{ namespace: undefined, serviceName: 'example-service' }, 'service name and namespace are required'],
    [{ namespace: 'env-build-uuid', serviceName: 'example-service', buildUuid: undefined }, 'build UUID is required'],
  ])('rejects incomplete resolution context %p', async (context, message) => {
    await expect(
      resolveCodefreshExternalSecrets({
        env: { API_TOKEN: '{{aws:repo/example/service:API_TOKEN}}' },
        buildUuid: 'buildUuid' in context ? context.buildUuid : 'build-uuid',
        secretProviders: { aws: { enabled: true } },
        ...context,
      } as any)
    ).rejects.toThrow(message);
    expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    expect(mockProcessSecretRefs).not.toHaveBeenCalled();
  });

  test('resolves top-level, object, and array references without mutating the input', async () => {
    const env = {
      API_TOKEN: '{{aws:repo/example/service:API_TOKEN}}',
      CONFIG: {
        'database url': '{{gcp:projects/example/secrets/database:latest}}',
        values: ['plain', '{{aws:repo/example/service:PASSWORD}}'],
      },
      ENABLED: true,
    };
    mockReadNamespacedSecret
      .mockResolvedValueOnce({
        body: {
          data: {
            API_TOKEN: Buffer.from('resolved-token').toString('base64'),
            CONFIG__values__1: Buffer.from('resolved-password').toString('base64'),
          },
        },
      })
      .mockResolvedValueOnce({
        body: {
          data: {
            CONFIG__database_url: Buffer.from('postgres://database').toString('base64'),
          },
        },
      });

    const result = await resolveCodefreshExternalSecrets({
      env,
      serviceName: 'example-service',
      namespace: 'env-build-uuid',
      buildUuid: 'build-uuid',
      staticEnv: true,
      secretProviders: {
        aws: { enabled: true, secretSyncTimeout: 2 },
        gcp: { enabled: true, secretSyncTimeout: 5 },
      },
    } as any);

    expect(mockCreateOrUpdateNamespace).toHaveBeenCalledWith({
      name: 'env-build-uuid',
      buildUUID: 'build-uuid',
      staticEnv: true,
      waitForReady: true,
    });
    expect(mockProcessSecretRefs).toHaveBeenCalledWith({
      secretRefs: [
        expect.objectContaining({ provider: 'aws', envKey: 'API_TOKEN' }),
        expect.objectContaining({ provider: 'gcp', envKey: 'CONFIG__database_url' }),
        expect.objectContaining({ provider: 'aws', envKey: 'CONFIG__values__1' }),
      ],
      serviceName: 'example-service',
      namespace: 'env-build-uuid',
      buildUuid: 'build-uuid',
      strict: true,
    });
    expect(mockWaitForSecretSync).toHaveBeenCalledWith(expect.any(Object), 'env-build-uuid', 5_000, expect.any(Object));
    expect(mockReadNamespacedSecret).toHaveBeenNthCalledWith(1, 'example-service-aws-secrets', 'env-build-uuid');
    expect(mockReadNamespacedSecret).toHaveBeenNthCalledWith(2, 'example-service-gcp-secrets', 'env-build-uuid');
    expect(result).toEqual({
      env: {
        API_TOKEN: 'resolved-token',
        CONFIG: {
          'database url': 'postgres://database',
          values: ['plain', 'resolved-password'],
        },
        ENABLED: true,
      },
      secretEnvKeys: new Set(['API_TOKEN', 'CONFIG']),
    });
    expect(env.CONFIG['database url']).toBe('{{gcp:projects/example/secrets/database:latest}}');
    expect(env.CONFIG.values[1]).toBe('{{aws:repo/example/service:PASSWORD}}');
  });

  test('uses default namespace and secret-sync timing and stops on processor warnings', async () => {
    mockProcessSecretRefs.mockResolvedValueOnce({
      expectedKeysPerSecret: {},
      syncTokensPerSecret: {},
      warnings: ['provider rejected the path', 'second warning'],
    });

    await expect(
      resolveCodefreshExternalSecrets({
        env: { API_TOKEN: '{{aws:repo/example/service:API_TOKEN}}' },
        serviceName: 'example-service',
        namespace: 'env-build-uuid',
        buildUuid: 'build-uuid',
        secretProviders: { aws: { enabled: true } },
      } as any)
    ).rejects.toThrow('Codefresh secret resolution failed: provider rejected the path second warning');

    expect(mockCreateOrUpdateNamespace).toHaveBeenCalledWith(
      expect.objectContaining({ staticEnv: false, waitForReady: true })
    );
    expect(mockWaitForSecretSync).not.toHaveBeenCalled();
    expect(mockReadNamespacedSecret).not.toHaveBeenCalled();
  });

  test('uses the default 60-second sync timeout when providers do not override it', async () => {
    mockReadNamespacedSecret.mockResolvedValue({
      body: { data: { API_TOKEN: Buffer.from('resolved').toString('base64') } },
    });

    await resolveCodefreshExternalSecrets({
      env: { API_TOKEN: '{{aws:repo/example/service:API_TOKEN}}' },
      serviceName: 'example-service',
      namespace: 'env-build-uuid',
      buildUuid: 'build-uuid',
      secretProviders: { aws: { enabled: true } },
    } as any);

    expect(mockWaitForSecretSync).toHaveBeenCalledWith(
      expect.any(Object),
      'env-build-uuid',
      60_000,
      expect.any(Object)
    );
  });

  test('fails when the synced Kubernetes secret is missing the expected key', async () => {
    mockReadNamespacedSecret.mockResolvedValue({
      body: {
        data: {},
      },
    });

    await expect(
      resolveCodefreshExternalSecrets({
        env: {
          API_TOKEN: '{{aws:repo/example/service:API_TOKEN}}',
        },
        serviceName: 'example-service',
        namespace: 'env-build-uuid',
        buildUuid: 'build-uuid',
        secretProviders: {
          aws: {
            enabled: true,
            clusterSecretStore: 'aws-secrets',
            refreshInterval: '1h',
          },
        },
      })
    ).rejects.toThrow("synced Kubernetes secret is missing key 'API_TOKEN'");
  });
});

describe('cleanupCodefreshExternalSecrets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteNamespacedSecret.mockReset().mockResolvedValue(undefined);
    mockDeleteExternalSecret.mockReset().mockResolvedValue(undefined);
  });

  test.each([
    [{ env: { PLAIN: 'value' }, serviceName: 'example-service', namespace: 'env-build-uuid' }],
    [{ env: { TOKEN: '{{aws:path:key}}' }, serviceName: undefined, namespace: 'env-build-uuid' }],
    [{ env: { TOKEN: '{{aws:path:key}}' }, serviceName: 'example-service', namespace: undefined }],
  ])('does nothing when cleanup context has no actionable secret %p', async (options) => {
    await cleanupCodefreshExternalSecrets(options);
    expect(mockDeleteExternalSecret).not.toHaveBeenCalled();
    expect(mockDeleteNamespacedSecret).not.toHaveBeenCalled();
  });

  test('deletes one external and synced secret per referenced provider', async () => {
    await cleanupCodefreshExternalSecrets({
      env: {
        FIRST: '{{aws:path:first}}',
        SECOND: ['{{aws:path:second}}', '{{gcp:path:third}}'],
      },
      serviceName: 'example-service',
      namespace: 'env-build-uuid',
    });

    expect(mockDeleteExternalSecret.mock.calls).toEqual([
      ['example-service-aws-secrets', 'env-build-uuid'],
      ['example-service-gcp-secrets', 'env-build-uuid'],
    ]);
    expect(mockDeleteNamespacedSecret.mock.calls).toEqual([
      ['example-service-aws-secrets', 'env-build-uuid'],
      ['example-service-gcp-secrets', 'env-build-uuid'],
    ]);
  });

  test('contains Kubernetes Secret deletion failures and continues with other providers', async () => {
    const deletionError = new Error('already deleted');
    mockDeleteNamespacedSecret.mockRejectedValueOnce(deletionError).mockResolvedValueOnce(undefined);

    await cleanupCodefreshExternalSecrets({
      env: { FIRST: '{{aws:path:first}}', SECOND: '{{gcp:path:second}}' },
      serviceName: 'example-service',
      namespace: 'env-build-uuid',
    });

    expect(mockWarn).toHaveBeenCalledWith('Codefresh secret cleanup failed name=example-service-aws-secrets');
    expect(mockDeleteExternalSecret).toHaveBeenCalledTimes(2);
    expect(mockDeleteNamespacedSecret).toHaveBeenCalledTimes(2);
  });

  test('propagates external-secret deletion failure before deleting the synced Secret', async () => {
    const deletionError = new Error('external secret API unavailable');
    mockDeleteExternalSecret.mockRejectedValueOnce(deletionError);

    await expect(
      cleanupCodefreshExternalSecrets({
        env: { TOKEN: '{{aws:path:key}}' },
        serviceName: 'example-service',
        namespace: 'env-build-uuid',
      })
    ).rejects.toBe(deletionError);
    expect(mockDeleteNamespacedSecret).not.toHaveBeenCalled();
  });
});
