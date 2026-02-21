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
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
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

import Deploy from 'server/models/Deploy';
import GlobalConfigService from 'server/services/globalConfig';
import { SecretProcessor } from 'server/services/secretProcessor';
import { deleteExternalSecret } from 'server/lib/kubernetes/externalSecret';
import {
  cleanupForwardedAgentEnvSecrets,
  getForwardedAgentEnvSecretServiceName,
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
        secretNames: [],
        warnings: [],
      }),
      waitForSecretSync: jest.fn().mockResolvedValue(undefined),
    }));
    mockDeleteSecret.mockResolvedValue(undefined);
  });

  it('returns empty forwarded env when no services are selected', async () => {
    const result = await resolveForwardedAgentEnv([], 'test-ns', 'session-123');

    expect(result).toEqual({
      env: {},
      secretRefs: [],
      secretProviders: [],
      secretServiceName: 'agent-env-session-123',
    });
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

  it('throws when selected services resolve the same forwarded key to different values', async () => {
    mockDeployQuery.select.mockResolvedValue([
      { id: 10, env: { PRIVATE_REGISTRY_TOKEN: 'token-one' } },
      { id: 11, env: { PRIVATE_REGISTRY_TOKEN: 'token-two' } },
    ]);

    await expect(
      resolveForwardedAgentEnv(
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
        'test-ns',
        'session-123'
      )
    ).rejects.toThrow('Agent env forwarding conflict for PRIVATE_REGISTRY_TOKEN');
  });

  it('processes secret refs through the configured secret providers', async () => {
    mockDeployQuery.select.mockResolvedValue([
      {
        id: 10,
        env: {
          PRIVATE_REGISTRY_TOKEN: '{{aws:apps/sample:npmToken}}',
        },
      },
    ]);

    const processEnvSecrets = jest.fn().mockResolvedValue({
      secretRefs: [
        {
          envKey: 'PRIVATE_REGISTRY_TOKEN',
          provider: 'aws',
          path: 'apps/sample',
          key: 'npmToken',
        },
      ],
      secretNames: ['agent-env-session-123-aws-secrets'],
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
      'session-123',
      'build-123'
    );

    expect(processEnvSecrets).toHaveBeenCalledWith({
      env: { PRIVATE_REGISTRY_TOKEN: '{{aws:apps/sample:npmToken}}' },
      serviceName: 'agent-env-session-123',
      namespace: 'test-ns',
      buildUuid: 'build-123',
    });
    expect(waitForSecretSync).toHaveBeenCalledWith(['agent-env-session-123-aws-secrets'], 'test-ns', 30000);
    expect(result.secretProviders).toEqual(['aws']);
  });

  it('throws when secret refs are forwarded without configured secret providers', async () => {
    mockDeployQuery.select.mockResolvedValue([
      {
        id: 10,
        env: {
          PRIVATE_REGISTRY_TOKEN: '{{aws:apps/sample:npmToken}}',
        },
      },
    ]);

    await expect(
      resolveForwardedAgentEnv(
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
      )
    ).rejects.toThrow('requires configured secret providers');
  });

  it('cleans up session-scoped ExternalSecrets and synced Secrets for forwarded env', async () => {
    await cleanupForwardedAgentEnvSecrets('test-ns', 'session-123', ['aws', 'gcp']);

    expect(deleteExternalSecret).toHaveBeenCalledWith('agent-env-session-123-aws-secrets', 'test-ns');
    expect(deleteExternalSecret).toHaveBeenCalledWith('agent-env-session-123-gcp-secrets', 'test-ns');
    expect(mockDeleteSecret).toHaveBeenCalledWith('agent-env-session-123-aws-secrets', 'test-ns');
    expect(mockDeleteSecret).toHaveBeenCalledWith('agent-env-session-123-gcp-secrets', 'test-ns');
  });

  it('derives a stable secret service name from the session uuid', () => {
    expect(getForwardedAgentEnvSecretServiceName('session-123')).toBe('agent-env-session-123');
  });
});
