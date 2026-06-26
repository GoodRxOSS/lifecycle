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

const mockShellPromise = jest.fn();
const mockGetAllConfigs = jest.fn();
const mockProcessSecretRefs = jest.fn();
const mockWaitForSecretSync = jest.fn();
const mockReadNamespacedSecret = jest.fn();
const mockDeleteNamespacedSecret = jest.fn();
const mockDeleteExternalSecret = jest.fn();
const mockCreateOrUpdateNamespace = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('server/lib/shell', () => ({
  shellPromise: (...args: any[]) => mockShellPromise(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    debug: mockLoggerDebug,
    error: mockLoggerError,
    info: jest.fn(),
    warn: jest.fn(),
  })),
  updateLogContext: jest.fn(),
  withLogContext: jest.fn((_ctx, fn) => fn()),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: any[]) => mockGetAllConfigs(...args),
    })),
  },
}));

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

jest.mock('server/lib/kubernetes/externalSecret', () => ({
  deleteExternalSecret: (...args: any[]) => mockDeleteExternalSecret(...args),
}));

jest.mock('server/lib/kubernetes', () => ({
  createOrUpdateNamespace: (...args: any[]) => mockCreateOrUpdateNamespace(...args),
}));

import { codefreshDeploy, codefreshDestroy } from '../cli';

const secretProviders = {
  aws: {
    enabled: true,
    clusterSecretStore: 'aws-secrets',
    refreshInterval: '1h',
    allowedPrefixes: ['repo/example/'],
  },
};

function encoded(value: string) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function createDeploy(overrides: any = {}) {
  const patch = jest.fn().mockResolvedValue(undefined);
  return {
    uuid: 'deploy-uuid',
    branchName: 'feature-branch',
    env: {
      API_TOKEN: '{{aws:repo/example/service:API_TOKEN}}',
    },
    build: {
      uuid: 'build-uuid',
      sha: 'build-sha',
      namespace: 'env-build-uuid',
      commentRuntimeEnv: {},
      enableFullYaml: true,
    },
    service: {
      name: 'service-name',
      deployPipelineId: 'service/deploy',
      deployTrigger: 'deploy-trigger',
      destroyPipelineId: 'service/destroy',
      destroyTrigger: 'destroy-trigger',
      branchName: 'service-branch',
    },
    deployable: {
      name: 'example-service',
      deployPipelineId: 'deployable/deploy',
      deployTrigger: 'deployable-trigger',
      destroyPipelineId: 'deployable/destroy',
      destroyTrigger: 'deployable-destroy-trigger',
      branchName: 'deployable-branch',
    },
    $query: jest.fn(() => ({ patch })),
    ...overrides,
  } as any;
}

describe('codefresh cli external secret resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShellPromise.mockResolvedValue('codefresh-run-id\n');
    mockGetAllConfigs.mockResolvedValue({ secretProviders });
    mockProcessSecretRefs.mockImplementation(({ secretRefs }) => ({
      secretRefs,
      expectedKeysPerSecret: { 'lfc-example-service-aws': secretRefs.map((ref: any) => ref.envKey) },
      syncTokensPerSecret: { 'lfc-example-service-aws': 'sync-token' },
      warnings: [],
    }));
    mockWaitForSecretSync.mockResolvedValue(undefined);
    mockCreateOrUpdateNamespace.mockResolvedValue(undefined);
    mockDeleteExternalSecret.mockResolvedValue(undefined);
    mockDeleteNamespacedSecret.mockResolvedValue(undefined);
    mockReadNamespacedSecret.mockResolvedValue({
      body: {
        data: {
          API_TOKEN: encoded('resolved-token'),
          CONFIG__credentials__token: encoded('nested-token'),
        },
      },
    });
  });

  test('resolves deploy env secret refs before invoking Codefresh and redacts debug command', async () => {
    const deploy = createDeploy();

    await expect(codefreshDeploy(deploy, deploy.build, deploy.service, deploy.deployable)).resolves.toBe(
      'codefresh-run-id'
    );

    const [command, options] = mockShellPromise.mock.calls[0];
    expect(command).toContain("-v 'API_TOKEN'='resolved-token'");
    expect(mockCreateOrUpdateNamespace).toHaveBeenCalledWith({
      name: 'env-build-uuid',
      buildUUID: 'build-uuid',
      staticEnv: false,
      waitForReady: true,
    });
    expect(options.redactCommand).toContain("-v 'API_TOKEN'='[REDACTED]'");
    expect(options.redactCommand).not.toContain('resolved-token');
    expect(mockLoggerDebug.mock.calls.map(([message]) => message).join('\n')).not.toContain('resolved-token');
  });

  test('shell-quotes resolved secret values before invoking Codefresh', async () => {
    mockReadNamespacedSecret.mockResolvedValue({
      body: {
        data: {
          API_TOKEN: encoded("resolved'token $(echo bad)"),
        },
      },
    });
    const deploy = createDeploy();

    await codefreshDeploy(deploy, deploy.build, deploy.service, deploy.deployable);

    const [command, options] = mockShellPromise.mock.calls[0];
    expect(command).toContain("-v 'API_TOKEN'='resolved'\\''token $(echo bad)'");
    expect(command).not.toContain("resolved'token $(echo bad)");
    expect(options.redactCommand).toContain("-v 'API_TOKEN'='[REDACTED]'");
  });

  test('resolves destroy env secret refs before invoking Codefresh and cleans up synced resources', async () => {
    const deploy = createDeploy({
      env: {},
      build: {
        uuid: 'build-uuid',
        sha: 'build-sha',
        namespace: 'env-build-uuid',
        commentRuntimeEnv: {
          API_TOKEN: '{{aws:repo/example/service:API_TOKEN}}',
        },
        enableFullYaml: false,
      },
    });

    await expect(codefreshDestroy(deploy)).resolves.toBe('codefresh-run-id');

    const [command, options] = mockShellPromise.mock.calls[0];
    expect(command).toContain("codefresh run 'service/destroy' -b 'service-branch'");
    expect(command).toContain("-v 'BUILD_UUID'='build-uuid'");
    expect(command).toContain("-v 'API_TOKEN'='resolved-token'");
    expect(options.redactCommand).toContain("-v 'API_TOKEN'='[REDACTED]'");
    expect(mockDeleteExternalSecret).toHaveBeenCalledWith('service-name-aws-secrets', 'env-build-uuid');
    expect(mockDeleteNamespacedSecret).toHaveBeenCalledWith('service-name-aws-secrets', 'env-build-uuid');
  });

  test('cleans up synced resources when Codefresh destroy fails', async () => {
    mockShellPromise.mockRejectedValueOnce(new Error('destroy failed'));
    const deploy = createDeploy({
      env: {},
      build: {
        uuid: 'build-uuid',
        sha: 'build-sha',
        namespace: 'env-build-uuid',
        commentRuntimeEnv: {
          API_TOKEN: '{{aws:repo/example/service:API_TOKEN}}',
        },
        enableFullYaml: false,
      },
    });

    await expect(codefreshDestroy(deploy)).rejects.toThrow('destroy failed');

    expect(mockDeleteExternalSecret).toHaveBeenCalledWith('service-name-aws-secrets', 'env-build-uuid');
    expect(mockDeleteNamespacedSecret).toHaveBeenCalledWith('service-name-aws-secrets', 'env-build-uuid');
  });

  test('resolves nested object env refs and preserves JSON stringification for Codefresh variables', async () => {
    const deploy = createDeploy({
      env: {
        CONFIG: {
          credentials: {
            token: '{{aws:repo/example/service:API_TOKEN}}',
          },
          mode: 'test',
        },
      },
    });

    await codefreshDeploy(deploy, deploy.build, deploy.service, deploy.deployable);

    const [command, options] = mockShellPromise.mock.calls[0];
    expect(command).toContain(
      `-v 'CONFIG'='${JSON.stringify({ credentials: { token: 'nested-token' }, mode: 'test' })}'`
    );
    expect(options.redactCommand).toContain("-v 'CONFIG'='[REDACTED]'");
  });

  test('preserves no-secret behavior without loading secret provider config', async () => {
    const deploy = createDeploy({
      env: {
        API_URL: 'https://example.invalid',
      },
    });

    await codefreshDeploy(deploy, deploy.build, deploy.service, deploy.deployable);

    expect(mockGetAllConfigs).not.toHaveBeenCalled();
    expect(mockProcessSecretRefs).not.toHaveBeenCalled();
    expect(mockShellPromise.mock.calls[0][0]).toContain("-v 'API_URL'='https://example.invalid'");
  });

  test('fails before invoking Codefresh when a secret provider is missing', async () => {
    mockGetAllConfigs.mockResolvedValue({ secretProviders: undefined });
    const deploy = createDeploy();

    await expect(codefreshDeploy(deploy, deploy.build, deploy.service, deploy.deployable)).rejects.toThrow(
      'external secret providers are not configured'
    );

    expect(mockShellPromise).not.toHaveBeenCalled();
  });
});
