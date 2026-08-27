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

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('server/models/Deploy');
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: jest.fn().mockResolvedValue({}),
    })),
  },
}));
jest.mock('server/services/secretProcessor');
jest.mock('server/lib/kubernetes/externalSecret', () => {
  const actual = jest.requireActual('server/lib/kubernetes/externalSecret');
  return {
    ...actual,
    deleteExternalSecret: jest.fn().mockResolvedValue(undefined),
  };
});
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => mockLogger),
}));

const mockDeleteSecret = jest.fn().mockResolvedValue(undefined);

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockReturnValue({
        deleteNamespacedSecret: mockDeleteSecret,
      }),
    })),
  };
});

import * as k8s from '@kubernetes/client-node';
import Deploy from 'server/models/Deploy';
import GlobalConfigService from 'server/services/globalConfig';
import { SecretProcessor } from 'server/services/secretProcessor';
import { deleteExternalSecret } from 'server/lib/kubernetes/externalSecret';
import {
  applyForwardedAgentEnvSecrets,
  cleanupForwardedAgentEnvSecrets,
  getForwardedAgentEnvSecretServiceName,
  planForwardedAgentEnv,
  resolveForwardedAgentEnv,
} from '../forwardedEnv';

const mockDeployQuery = {
  whereIn: jest.fn().mockReturnThis(),
  select: jest.fn(),
};
(Deploy.query as jest.Mock) = jest.fn().mockReturnValue(mockDeployQuery);

describe('forwardedEnv', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Deploy.query as jest.Mock) = jest.fn().mockReturnValue(mockDeployQuery);
    mockDeployQuery.whereIn.mockReturnThis();
    mockDeployQuery.select.mockResolvedValue([]);
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({}),
    });
    (SecretProcessor as unknown as jest.Mock).mockImplementation(() => ({
      processEnvSecrets: jest.fn().mockResolvedValue({
        secretRefs: [],
        expectedKeysPerSecret: {},
        syncTokensPerSecret: {},
        warnings: [],
      }),
      waitForSecretSync: jest.fn().mockResolvedValue(undefined),
    }));
    mockDeleteSecret.mockResolvedValue(undefined);
  });

  it('returns empty forwarded env when no services are selected', async () => {
    const result = await planForwardedAgentEnv(undefined, 'session-123');

    expect(result).toEqual({
      env: {},
      secretRefs: [],
      secretProviders: [],
      secretServiceName: 'agent-env-session-123',
    });
    expect(Deploy.query).not.toHaveBeenCalled();
    expect(SecretProcessor).not.toHaveBeenCalled();
  });

  it('returns empty forwarded env and a stable service name when services do not request forwarding', async () => {
    const result = await planForwardedAgentEnv(
      [
        {
          name: 'web',
          deployId: 10,
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
          },
        },
      ],
      'session-123'
    );

    expect(result).toEqual({
      env: {},
      secretRefs: [],
      secretProviders: [],
      secretServiceName: 'agent-env-session-123',
    });
    expect(Deploy.query).not.toHaveBeenCalled();
    expect(SecretProcessor).not.toHaveBeenCalled();
  });

  it('collects allowlisted env vars from selected deploys', async () => {
    mockDeployQuery.select.mockResolvedValue([
      {
        id: 10,
        env: {
          PRIVATE_REGISTRY_TOKEN: 'plain-token',
          TURBO_TOKEN: 'turbo-token',
        },
      },
    ]);

    const result = await planForwardedAgentEnv(
      [
        {
          name: 'web',
          deployId: 10,
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
            forwardEnvVarsToAgent: ['PRIVATE_REGISTRY_TOKEN'],
          },
        },
      ],
      'session-123'
    );

    expect(result).toEqual({
      env: {
        PRIVATE_REGISTRY_TOKEN: 'plain-token',
      },
      secretRefs: [],
      secretProviders: [],
      secretServiceName: 'agent-env-session-123',
    });
    expect(SecretProcessor).not.toHaveBeenCalled();
  });

  it('rejects a forwarded key that is absent from the selected deploy environment', async () => {
    mockDeployQuery.select.mockResolvedValue([{ id: 10, env: {} }]);

    await expect(
      planForwardedAgentEnv(
        [
          {
            name: 'web',
            deployId: 10,
            devConfig: {
              image: 'node:20',
              command: 'pnpm dev',
              forwardEnvVarsToAgent: ['PRIVATE_REGISTRY_TOKEN'],
            },
          },
        ],
        'session-123'
      )
    ).rejects.toThrow('Agent env forwarding key PRIVATE_REGISTRY_TOKEN is not defined for service web.');
  });

  it('rejects a forwarded key whose deploy value is not scalar', async () => {
    mockDeployQuery.select.mockResolvedValue([
      {
        id: 10,
        env: { PRIVATE_REGISTRY_TOKEN: { value: 'nested-token' } },
      },
    ]);

    await expect(
      planForwardedAgentEnv(
        [
          {
            name: 'web',
            deployId: 10,
            devConfig: {
              image: 'node:20',
              command: 'pnpm dev',
              forwardEnvVarsToAgent: ['PRIVATE_REGISTRY_TOKEN'],
            },
          },
        ],
        'session-123'
      )
    ).rejects.toThrow(
      'Agent env forwarding key PRIVATE_REGISTRY_TOKEN for service web must resolve to a scalar value.'
    );
  });

  it('stringifies numeric and boolean deploy env scalars for pod forwarding', async () => {
    mockDeployQuery.select.mockResolvedValue([
      {
        id: 10,
        env: { APP_PORT: 3000, FEATURE_ENABLED: false },
      },
    ]);

    const result = await planForwardedAgentEnv(
      [
        {
          name: 'web',
          deployId: 10,
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
            forwardEnvVarsToAgent: ['APP_PORT', 'FEATURE_ENABLED'],
          },
        },
      ],
      'session-123'
    );

    expect(result.env).toEqual({ APP_PORT: '3000', FEATURE_ENABLED: 'false' });
  });

  it('rejects a stale selected service whose deploy row no longer exists', async () => {
    mockDeployQuery.select.mockResolvedValue([]);

    await expect(
      planForwardedAgentEnv(
        [
          {
            name: 'web',
            deployId: 404,
            devConfig: {
              image: 'node:20',
              command: 'pnpm dev',
              forwardEnvVarsToAgent: ['PRIVATE_REGISTRY_TOKEN'],
            },
          },
        ],
        'session-123'
      )
    ).rejects.toThrow('Selected deploy 404 was not found for service web.');
  });

  it('throws when selected services resolve the same forwarded key to different values', async () => {
    mockDeployQuery.select.mockResolvedValue([
      { id: 10, env: { PRIVATE_REGISTRY_TOKEN: 'token-one' } },
      { id: 11, env: { PRIVATE_REGISTRY_TOKEN: 'token-two' } },
    ]);

    await expect(
      planForwardedAgentEnv(
        [
          {
            name: 'web',
            deployId: 10,
            devConfig: {
              image: 'node:20',
              command: 'pnpm dev',
              forwardEnvVarsToAgent: ['PRIVATE_REGISTRY_TOKEN'],
            },
          },
          {
            name: 'api',
            deployId: 11,
            devConfig: {
              image: 'node:20',
              command: 'pnpm dev',
              forwardEnvVarsToAgent: ['PRIVATE_REGISTRY_TOKEN'],
            },
          },
        ],
        'session-123'
      )
    ).rejects.toThrow('Agent env forwarding conflict for PRIVATE_REGISTRY_TOKEN');
    expect(SecretProcessor).not.toHaveBeenCalled();
  });

  it('plans native secret refs without applying ExternalSecrets', async () => {
    mockDeployQuery.select.mockResolvedValue([
      {
        id: 10,
        env: {
          PRIVATE_REGISTRY_TOKEN: '{{aws:apps/sample:npmToken}}',
        },
      },
    ]);

    const result = await planForwardedAgentEnv(
      [
        {
          name: 'web',
          deployId: 10,
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
            forwardEnvVarsToAgent: ['PRIVATE_REGISTRY_TOKEN'],
          },
        },
      ],
      'session-123'
    );

    expect(result).toEqual({
      env: {
        PRIVATE_REGISTRY_TOKEN: '{{aws:apps/sample:npmToken}}',
      },
      secretRefs: [
        {
          envKey: 'PRIVATE_REGISTRY_TOKEN',
          provider: 'aws',
          path: 'apps/sample',
          key: 'npmToken',
        },
      ],
      secretProviders: ['aws'],
      secretServiceName: 'agent-env-session-123',
    });
    expect(SecretProcessor).not.toHaveBeenCalled();
  });

  it('applies secret refs through the configured secret providers', async () => {
    const processEnvSecrets = jest.fn().mockResolvedValue({
      secretRefs: [
        {
          envKey: 'PRIVATE_REGISTRY_TOKEN',
          provider: 'aws',
          path: 'apps/sample',
          key: 'npmToken',
        },
      ],
      expectedKeysPerSecret: {
        'agent-env-session-123-aws-secrets': ['PRIVATE_REGISTRY_TOKEN'],
      },
      syncTokensPerSecret: {
        'agent-env-session-123-aws-secrets': 'sync-123',
      },
      warnings: [],
    });
    const waitForSecretSync = jest.fn().mockResolvedValue(undefined);
    (SecretProcessor as unknown as jest.Mock).mockImplementation(() => ({
      processEnvSecrets,
      waitForSecretSync,
    }));
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({
        secretProviders: {
          aws: {
            enabled: true,
            clusterSecretStore: 'aws-secrets',
            refreshInterval: '1m',
            secretSyncTimeout: 30,
          },
        },
      }),
    });

    const result = await applyForwardedAgentEnvSecrets({
      namespace: 'test-ns',
      buildUuid: 'build-123',
      plan: {
        env: {
          PRIVATE_REGISTRY_TOKEN: '{{aws:apps/sample:npmToken}}',
        },
        secretRefs: [
          {
            envKey: 'PRIVATE_REGISTRY_TOKEN',
            provider: 'aws',
            path: 'apps/sample',
            key: 'npmToken',
          },
        ],
        secretProviders: ['aws'],
        secretServiceName: 'agent-env-session-123',
      },
    });

    expect(processEnvSecrets).toHaveBeenCalledWith({
      env: { PRIVATE_REGISTRY_TOKEN: '{{aws:apps/sample:npmToken}}' },
      serviceName: 'agent-env-session-123',
      namespace: 'test-ns',
      buildUuid: 'build-123',
    });
    expect(waitForSecretSync).toHaveBeenCalledWith(
      { 'agent-env-session-123-aws-secrets': ['PRIVATE_REGISTRY_TOKEN'] },
      'test-ns',
      30000,
      { 'agent-env-session-123-aws-secrets': 'sync-123' }
    );
    expect(result.secretProviders).toEqual(['aws']);
  });

  it('rejects secret materialization warnings before waiting for sync', async () => {
    const processEnvSecrets = jest.fn().mockResolvedValue({
      secretRefs: [],
      expectedKeysPerSecret: {},
      syncTokensPerSecret: {},
      warnings: ['AWS secret apps/sample did not expose npmToken.', 'No secret was created.'],
    });
    const waitForSecretSync = jest.fn();
    (SecretProcessor as unknown as jest.Mock).mockImplementation(() => ({
      processEnvSecrets,
      waitForSecretSync,
    }));
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({
        secretProviders: {
          aws: {
            enabled: true,
            clusterSecretStore: 'aws-secrets',
            refreshInterval: '1m',
          },
        },
      }),
    });

    await expect(
      applyForwardedAgentEnvSecrets({
        namespace: 'test-ns',
        plan: {
          env: { PRIVATE_REGISTRY_TOKEN: '{{aws:apps/sample:npmToken}}' },
          secretRefs: [
            {
              envKey: 'PRIVATE_REGISTRY_TOKEN',
              provider: 'aws',
              path: 'apps/sample',
              key: 'npmToken',
            },
          ],
          secretProviders: ['aws'],
          secretServiceName: 'agent-env-session-123',
        },
      })
    ).rejects.toThrow('AWS secret apps/sample did not expose npmToken. No secret was created.');
    expect(waitForSecretSync).not.toHaveBeenCalled();
  });

  it('uses the default sync timeout when configured providers do not override it', async () => {
    const processEnvSecrets = jest.fn().mockResolvedValue({
      secretRefs: [
        {
          envKey: 'PRIVATE_REGISTRY_TOKEN',
          provider: 'aws',
          path: 'apps/sample',
          key: 'npmToken',
        },
      ],
      expectedKeysPerSecret: {
        'agent-env-session-123-aws-secrets': ['PRIVATE_REGISTRY_TOKEN'],
      },
      syncTokensPerSecret: {
        'agent-env-session-123-aws-secrets': 'sync-123',
      },
      warnings: [],
    });
    const waitForSecretSync = jest.fn().mockResolvedValue(undefined);
    (SecretProcessor as unknown as jest.Mock).mockImplementation(() => ({
      processEnvSecrets,
      waitForSecretSync,
    }));
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: jest.fn().mockResolvedValue({
        secretProviders: {
          aws: {
            enabled: true,
            clusterSecretStore: 'aws-secrets',
            refreshInterval: '1m',
          },
        },
      }),
    });

    await applyForwardedAgentEnvSecrets({
      namespace: 'test-ns',
      plan: {
        env: { PRIVATE_REGISTRY_TOKEN: '{{aws:apps/sample:npmToken}}' },
        secretRefs: [
          {
            envKey: 'PRIVATE_REGISTRY_TOKEN',
            provider: 'aws',
            path: 'apps/sample',
            key: 'npmToken',
          },
        ],
        secretProviders: ['aws'],
        secretServiceName: 'agent-env-session-123',
      },
    });

    expect(waitForSecretSync).toHaveBeenCalledWith(
      { 'agent-env-session-123-aws-secrets': ['PRIVATE_REGISTRY_TOKEN'] },
      'test-ns',
      60000,
      { 'agent-env-session-123-aws-secrets': 'sync-123' }
    );
  });

  it('skips ExternalSecret application when the plan has no native secret refs', async () => {
    const result = await applyForwardedAgentEnvSecrets({
      namespace: 'test-ns',
      buildUuid: 'build-123',
      plan: {
        env: {
          PRIVATE_REGISTRY_TOKEN: 'plain-token',
        },
        secretRefs: [],
        secretProviders: [],
        secretServiceName: 'agent-env-session-123',
      },
    });

    expect(result).toEqual({
      env: {
        PRIVATE_REGISTRY_TOKEN: 'plain-token',
      },
      secretRefs: [],
      secretProviders: [],
      secretServiceName: 'agent-env-session-123',
    });
    expect(SecretProcessor).not.toHaveBeenCalled();
  });

  it('throws when secret refs are forwarded without configured secret providers', async () => {
    await expect(
      applyForwardedAgentEnvSecrets({
        namespace: 'test-ns',
        plan: {
          env: {
            PRIVATE_REGISTRY_TOKEN: '{{aws:apps/sample:npmToken}}',
          },
          secretRefs: [
            {
              envKey: 'PRIVATE_REGISTRY_TOKEN',
              provider: 'aws',
              path: 'apps/sample',
              key: 'npmToken',
            },
          ],
          secretProviders: ['aws'],
          secretServiceName: 'agent-env-session-123',
        },
      })
    ).rejects.toThrow('requires configured secret providers');
  });

  it('preserves resolveForwardedAgentEnv compatibility', async () => {
    mockDeployQuery.select.mockResolvedValue([
      {
        id: 10,
        env: {
          PRIVATE_REGISTRY_TOKEN: 'plain-token',
        },
      },
    ]);

    const result = await resolveForwardedAgentEnv(
      [
        {
          name: 'web',
          deployId: 10,
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
            forwardEnvVarsToAgent: ['PRIVATE_REGISTRY_TOKEN'],
          },
        },
      ],
      'test-ns',
      'session-123'
    );

    expect(result).toEqual({
      env: {
        PRIVATE_REGISTRY_TOKEN: 'plain-token',
      },
      secretRefs: [],
      secretProviders: [],
      secretServiceName: 'agent-env-session-123',
    });
  });

  it('cleans up session-scoped ExternalSecrets and synced Secrets for forwarded env', async () => {
    await cleanupForwardedAgentEnvSecrets('test-ns', 'session-123', ['aws', 'aws', '', 'gcp']);

    expect(deleteExternalSecret).toHaveBeenCalledWith('agent-env-session-123-aws-secrets', 'test-ns');
    expect(deleteExternalSecret).toHaveBeenCalledWith('agent-env-session-123-gcp-secrets', 'test-ns');
    expect(deleteExternalSecret).toHaveBeenCalledTimes(2);
    expect(mockDeleteSecret).toHaveBeenCalledWith('agent-env-session-123-aws-secrets', 'test-ns');
    expect(mockDeleteSecret).toHaveBeenCalledWith('agent-env-session-123-gcp-secrets', 'test-ns');
    expect(mockDeleteSecret).toHaveBeenCalledTimes(2);
  });

  it('does not create a Kubernetes client when there are no forwarded secret providers to clean up', async () => {
    await cleanupForwardedAgentEnvSecrets('test-ns', 'session-123', undefined);

    expect(deleteExternalSecret).not.toHaveBeenCalled();
    expect(mockDeleteSecret).not.toHaveBeenCalled();
  });

  it('treats an already-deleted synced Secret as successful cleanup', async () => {
    const notFound = new k8s.HttpError({ statusCode: 404 } as any, 'not found', 404);
    mockDeleteSecret.mockRejectedValueOnce(notFound);

    await expect(cleanupForwardedAgentEnvSecrets('test-ns', 'session-123', ['aws'])).resolves.toBeUndefined();

    expect(deleteExternalSecret).toHaveBeenCalledWith('agent-env-session-123-aws-secrets', 'test-ns');
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('logs a synced Secret deletion failure and continues cleaning later providers', async () => {
    const deleteError = new Error('Kubernetes unavailable');
    mockDeleteSecret.mockRejectedValueOnce(deleteError).mockResolvedValueOnce(undefined);

    await expect(cleanupForwardedAgentEnvSecrets('test-ns', 'session-123', ['aws', 'gcp'])).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      {
        error: deleteError,
        namespace: 'test-ns',
        secretName: 'agent-env-session-123-aws-secrets',
      },
      'Secret: cleanup failed type=forwarded_agent_env name=agent-env-session-123-aws-secrets namespace=test-ns'
    );
    expect(deleteExternalSecret).toHaveBeenCalledWith('agent-env-session-123-gcp-secrets', 'test-ns');
    expect(mockDeleteSecret).toHaveBeenNthCalledWith(2, 'agent-env-session-123-gcp-secrets', 'test-ns');
  });

  it('derives a stable secret service name from the session uuid', () => {
    expect(getForwardedAgentEnvSecretServiceName('session-123')).toBe('agent-env-session-123');
  });
});
