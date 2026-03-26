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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';

mockRedisClient();

jest.mock('server/models/AgentSession');
jest.mock('server/models/Build');
jest.mock('server/models/Deploy');
jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/lib/agentSession/pvcFactory');
jest.mock('server/lib/agentSession/apiKeySecretFactory');
jest.mock('server/lib/agentSession/podFactory');
jest.mock('server/lib/agentSession/editorServiceFactory');
jest.mock('server/lib/agentSession/serviceAccountFactory');
jest.mock('server/lib/agentSession/gvisorCheck');
jest.mock('server/lib/agentSession/configSeeder');
jest.mock('server/lib/agentSession/devModeManager');
jest.mock('server/lib/agentSession/forwardedEnv');
jest.mock('server/lib/kubernetes/networkPolicyFactory');
jest.mock('server/services/userApiKey');
jest.mock('server/lib/nativeHelm/helm', () => ({
  deployHelm: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('server/lib/deploymentManager/deploymentManager', () => ({
  DeploymentManager: jest.fn().mockImplementation(() => ({
    deploy: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('uuid', () => ({ v4: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }));

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockReturnValue({
        createNamespacedNetworkPolicy: jest.fn().mockResolvedValue({}),
      }),
    })),
  };
});

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  })),
  withLogContext: jest.fn((_ctx, fn) => fn()),
  withSpan: jest.fn((_name, fn) => fn()),
  extractContextForQueue: jest.fn(() => ({})),
  LogStage: {},
}));

jest.mock('server/services/build', () => {
  const deleteQueueAdd = jest.fn().mockResolvedValue(undefined);
  const deleteBuild = jest.fn().mockResolvedValue(undefined);

  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      deleteQueue: {
        add: deleteQueueAdd,
      },
      deleteBuild,
    })),
    __mocked: {
      deleteQueueAdd,
      deleteBuild,
    },
  };
});

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: jest.fn().mockResolvedValue({
        lifecycleDefaults: {
          defaultUUID: 'sample-env-0',
          defaultPublicUrl: 'sample-env.example.test',
        },
      }),
      getOrgChartName: jest.fn().mockResolvedValue('org-chart'),
      getGithubAppName: jest.fn().mockResolvedValue('sample-lifecycle-app'),
    })),
  },
}));

import AgentSessionService, { CreateSessionOptions } from 'server/services/agentSession';
import AgentSession from 'server/models/AgentSession';
import Build from 'server/models/Build';
import Deploy from 'server/models/Deploy';
import { createAgentPvc, deleteAgentPvc } from 'server/lib/agentSession/pvcFactory';
import { createAgentApiKeySecret, deleteAgentApiKeySecret } from 'server/lib/agentSession/apiKeySecretFactory';
import { createAgentPod, deleteAgentPod } from 'server/lib/agentSession/podFactory';
import { createAgentEditorService, deleteAgentEditorService } from 'server/lib/agentSession/editorServiceFactory';
import { ensureAgentSessionServiceAccount } from 'server/lib/agentSession/serviceAccountFactory';
import { isGvisorAvailable } from 'server/lib/agentSession/gvisorCheck';
import { DevModeManager } from 'server/lib/agentSession/devModeManager';
import { cleanupForwardedAgentEnvSecrets, resolveForwardedAgentEnv } from 'server/lib/agentSession/forwardedEnv';
import UserApiKeyService from 'server/services/userApiKey';
import RedisClient from 'server/lib/redisClient';
import { deployHelm } from 'server/lib/nativeHelm/helm';
import { DeploymentManager } from 'server/lib/deploymentManager/deploymentManager';
import BuildServiceModule from 'server/services/build';

const mockRedis = {
  setex: jest.fn().mockResolvedValue('OK'),
  get: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(1),
};

const mockedBuildServiceModule = jest.requireMock('server/services/build').__mocked as {
  deleteQueueAdd: jest.Mock;
  deleteBuild: jest.Mock;
};

jest.spyOn(RedisClient, 'getInstance').mockReturnValue({
  getRedis: () => mockRedis as any,
  getRedlock: () => ({} as any),
  getConnection: () => ({} as any),
  close: jest.fn(),
} as any);

const mockEnableDevMode = jest.fn().mockResolvedValue({
  deployment: {
    deploymentName: 'service',
    containerName: 'service',
    replicas: null,
    image: 'node:20',
    command: null,
    workingDir: null,
    env: null,
    volumeMounts: null,
    volumes: null,
    nodeSelector: null,
  },
  service: null,
});
const mockDisableDevMode = jest.fn().mockResolvedValue(undefined);
(DevModeManager as jest.Mock).mockImplementation(() => ({
  enableDevMode: mockEnableDevMode,
  disableDevMode: mockDisableDevMode,
}));

(isGvisorAvailable as jest.Mock).mockResolvedValue(false);
(createAgentPvc as jest.Mock).mockResolvedValue({});
(createAgentApiKeySecret as jest.Mock).mockResolvedValue({});
(createAgentPod as jest.Mock).mockResolvedValue({ spec: { nodeName: 'agent-node-a' } });
(createAgentEditorService as jest.Mock).mockResolvedValue({});
(ensureAgentSessionServiceAccount as jest.Mock).mockResolvedValue('agent-sa');
(deleteAgentPod as jest.Mock).mockResolvedValue(undefined);
(deleteAgentPvc as jest.Mock).mockResolvedValue(undefined);
(deleteAgentApiKeySecret as jest.Mock).mockResolvedValue(undefined);
(deleteAgentEditorService as jest.Mock).mockResolvedValue(undefined);
(deployHelm as jest.Mock).mockResolvedValue(undefined);

const mockSessionQuery = {
  where: jest.fn().mockReturnThis(),
  whereIn: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  first: jest.fn(),
  findOne: jest.fn(),
  select: jest.fn(),
  findById: jest.fn().mockReturnThis(),
  patch: jest.fn().mockResolvedValue(1),
  insert: jest.fn().mockResolvedValue({}),
  insertAndFetch: jest.fn(),
};
(AgentSession.query as jest.Mock) = jest.fn().mockReturnValue(mockSessionQuery);

const mockDeployQuery = {
  where: jest.fn().mockReturnThis(),
  whereIn: jest.fn().mockReturnThis(),
  findById: jest.fn().mockReturnThis(),
  patch: jest.fn().mockResolvedValue(1),
  withGraphFetched: jest.fn().mockResolvedValue([]),
};
(Deploy.query as jest.Mock) = jest.fn().mockReturnValue(mockDeployQuery);

const baseOpts: CreateSessionOptions = {
  userId: 'user-123',
  namespace: 'test-ns',
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'feature/test',
  agentImage: 'lifecycle-agent:latest',
  editorImage: 'codercom/code-server:4.98.2',
};

describe('AgentSessionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue(mockSessionQuery);
    (Deploy.query as jest.Mock) = jest.fn().mockReturnValue(mockDeployQuery);
    mockSessionQuery.where.mockReturnThis();
    mockSessionQuery.whereIn.mockReturnThis();
    mockSessionQuery.orderBy.mockReturnThis();
    mockSessionQuery.first.mockResolvedValue(null);
    mockSessionQuery.findOne.mockResolvedValue(null);
    mockSessionQuery.select.mockResolvedValue({ id: 123 });
    mockSessionQuery.findById.mockReturnThis();
    mockSessionQuery.patch.mockResolvedValue(1);
    mockSessionQuery.insert.mockResolvedValue({});
    mockSessionQuery.insertAndFetch.mockResolvedValue({
      id: 123,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: null,
      podName: 'agent-aaaaaaaa',
      namespace: 'test-ns',
      pvcName: 'agent-pvc-aaaaaaaa',
      model: 'claude-sonnet-4-6',
      buildKind: 'environment',
      status: 'starting',
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
    });
    mockDeployQuery.where.mockReturnThis();
    mockDeployQuery.whereIn.mockReturnThis();
    mockDeployQuery.findById.mockReturnThis();
    mockDeployQuery.patch.mockResolvedValue(1);
    mockDeployQuery.withGraphFetched.mockResolvedValue([]);
    (UserApiKeyService.getDecryptedKey as jest.Mock) = jest.fn().mockResolvedValue('sk-ant-test-key');

    jest.spyOn(RedisClient, 'getInstance').mockReturnValue({
      getRedis: () => mockRedis as any,
      getRedlock: () => ({} as any),
      getConnection: () => ({} as any),
      close: jest.fn(),
    } as any);

    mockRedis.setex.mockResolvedValue('OK');
    mockRedis.get.mockResolvedValue(null);
    mockRedis.del.mockResolvedValue(1);
    mockEnableDevMode.mockResolvedValue({
      deployment: {
        deploymentName: 'service',
        containerName: 'service',
        replicas: null,
        image: 'node:20',
        command: null,
        workingDir: null,
        env: null,
        volumeMounts: null,
        volumes: null,
        nodeSelector: null,
      },
      service: null,
    });
    mockDisableDevMode.mockResolvedValue(undefined);
    (isGvisorAvailable as jest.Mock).mockResolvedValue(false);
    (createAgentPvc as jest.Mock).mockResolvedValue({});
    (createAgentApiKeySecret as jest.Mock).mockResolvedValue({});
    (createAgentPod as jest.Mock).mockResolvedValue({ spec: { nodeName: 'agent-node-a' } });
    (createAgentEditorService as jest.Mock).mockResolvedValue({});
    (ensureAgentSessionServiceAccount as jest.Mock).mockResolvedValue('agent-sa');
    (deleteAgentPod as jest.Mock).mockResolvedValue(undefined);
    (deleteAgentPvc as jest.Mock).mockResolvedValue(undefined);
    (deleteAgentApiKeySecret as jest.Mock).mockResolvedValue(undefined);
    (deleteAgentEditorService as jest.Mock).mockResolvedValue(undefined);
    (deployHelm as jest.Mock).mockResolvedValue(undefined);
    (DeploymentManager as jest.Mock).mockImplementation(() => ({
      deploy: jest.fn().mockResolvedValue(undefined),
    }));
    mockedBuildServiceModule.deleteQueueAdd.mockResolvedValue(undefined);
    mockedBuildServiceModule.deleteBuild.mockResolvedValue(undefined);
    (resolveForwardedAgentEnv as jest.Mock).mockResolvedValue({
      env: {},
      secretRefs: [],
      secretProviders: [],
      secretServiceName: 'agent-env-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    (cleanupForwardedAgentEnvSecrets as jest.Mock).mockResolvedValue(undefined);
  });

  describe('createSession', () => {
    it('throws an active environment session error when another user already owns the environment session', async () => {
      const conflictingOpts: CreateSessionOptions = {
        ...baseOpts,
        buildUuid: 'build-123',
      };

      const insertAndFetch = jest.fn().mockRejectedValue({
        code: '23505',
        constraint: 'agent_sessions_active_environment_build_unique',
      });
      const activeSessionQuery = {
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          id: 77,
          uuid: 'sess-existing',
          userId: 'other-user',
          ownerGithubUsername: 'other-dev',
          status: 'active',
        }),
      };

      (AgentSession.query as jest.Mock) = jest
        .fn()
        .mockReturnValueOnce({
          insertAndFetch,
        })
        .mockReturnValueOnce(activeSessionQuery);

      await expect(AgentSessionService.createSession(conflictingOpts)).rejects.toThrow(
        'An active environment session is already running for this environment by other-dev. Fork the environment into a sandbox instead.'
      );
    });

    it('throws API_KEY_REQUIRED when no API key found', async () => {
      (UserApiKeyService.getDecryptedKey as jest.Mock).mockResolvedValue(null);

      await expect(AgentSessionService.createSession(baseOpts)).rejects.toThrow('API_KEY_REQUIRED');
    });

    it('creates PVC, pod, network policy, and session record', async () => {
      const session = await AgentSessionService.createSession(baseOpts);

      expect(createAgentPvc).toHaveBeenCalledWith('test-ns', 'agent-pvc-aaaaaaaa', '10Gi', undefined);
      expect(ensureAgentSessionServiceAccount).toHaveBeenCalledWith('test-ns');
      expect(createAgentApiKeySecret).toHaveBeenCalledWith(
        'test-ns',
        'agent-secret-aaaaaaaa',
        'sk-ant-test-key',
        undefined,
        undefined,
        {}
      );
      expect(createAgentPod).toHaveBeenCalledWith(
        expect.objectContaining({
          podName: 'agent-aaaaaaaa',
          namespace: 'test-ns',
          pvcName: 'agent-pvc-aaaaaaaa',
          image: 'lifecycle-agent:latest',
          apiKeySecretName: 'agent-secret-aaaaaaaa',
          serviceAccountName: 'agent-sa',
          hasGitHubToken: false,
          model: 'claude-sonnet-4-6',
          claudePermissions: {
            allow: ['Bash(*)', 'Read(*)', 'Write(*)', 'Edit(*)', 'Glob(*)', 'Grep(*)'],
            deny: [],
          },
          claudeCommitAttribution: 'Generated with (sample-lifecycle-app)',
          claudePrAttribution: 'Generated with (sample-lifecycle-app)',
        })
      );
      expect(createAgentEditorService).toHaveBeenCalledWith('test-ns', 'agent-aaaaaaaa', undefined);
      expect(mockSessionQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userId: 'user-123',
          ownerGithubUsername: null,
          buildKind: 'environment',
          status: 'starting',
          devModeSnapshots: {},
        })
      );
      expect(mockSessionQuery.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'active',
        })
      );
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        7200,
        expect.any(String)
      );
      expect(session.status).toBe('active');
    });

    it('passes resolved agent-session resources through to pod creation when provided', async () => {
      const optsWithResources: CreateSessionOptions = {
        ...baseOpts,
        resources: {
          agent: {
            requests: {
              cpu: '900m',
              memory: '2Gi',
            },
            limits: {
              cpu: '3',
              memory: '6Gi',
            },
          },
          editor: {
            requests: {
              cpu: '400m',
              memory: '768Mi',
            },
            limits: {
              cpu: '1500m',
              memory: '2Gi',
            },
          },
        },
      };

      await AgentSessionService.createSession(optsWithResources);

      expect(createAgentPod).toHaveBeenCalledWith(
        expect.objectContaining({
          resources: optsWithResources.resources,
        })
      );
    });

    it('passes resolved agent-session readiness through to pod creation when provided', async () => {
      const optsWithReadiness: CreateSessionOptions = {
        ...baseOpts,
        readiness: {
          timeoutMs: 120000,
          pollMs: 500,
        },
      };

      await AgentSessionService.createSession(optsWithReadiness);

      expect(createAgentPod).toHaveBeenCalledWith(
        expect.objectContaining({
          readiness: optsWithReadiness.readiness,
        })
      );
    });

    it('passes forwarded service env through to the agent pod when configured', async () => {
      (resolveForwardedAgentEnv as jest.Mock).mockResolvedValue({
        env: { PRIVATE_REGISTRY_TOKEN: 'plain-token' },
        secretRefs: [],
        secretProviders: [],
        secretServiceName: 'agent-env-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      });

      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        services: [
          {
            name: 'web',
            deployId: 1,
            devConfig: {
              image: 'node:20',
              command: 'pnpm dev',
              forwardEnvVarsToAgent: ['PRIVATE_REGISTRY_TOKEN'],
            },
          },
        ],
      };

      await AgentSessionService.createSession(optsWithServices);

      expect(createAgentApiKeySecret).toHaveBeenCalledWith(
        'test-ns',
        'agent-secret-aaaaaaaa',
        'sk-ant-test-key',
        undefined,
        undefined,
        {
          PRIVATE_REGISTRY_TOKEN: 'plain-token',
        }
      );
      expect(createAgentPod).toHaveBeenCalledWith(
        expect.objectContaining({
          forwardedAgentEnv: { PRIVATE_REGISTRY_TOKEN: 'plain-token' },
          forwardedAgentSecretRefs: [],
          forwardedAgentSecretServiceName: 'agent-env-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        })
      );
    });

    it('passes user identity through to pod creation when provided', async () => {
      const optsWithIdentity: CreateSessionOptions = {
        ...baseOpts,
        userIdentity: {
          userId: 'user-123',
          githubUsername: 'sample-user',
          preferredUsername: 'sample-user',
          email: 'sample-user@example.com',
          firstName: 'Sample',
          lastName: 'User',
          displayName: 'Sample User',
          gitUserName: 'Sample User',
          gitUserEmail: 'sample-user@example.com',
        },
      };

      await AgentSessionService.createSession(optsWithIdentity);

      expect(mockSessionQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerGithubUsername: 'sample-user',
        })
      );
      expect(createAgentPod).toHaveBeenCalledWith(
        expect.objectContaining({
          userIdentity: expect.objectContaining({
            githubUsername: 'sample-user',
            gitUserName: 'Sample User',
            gitUserEmail: 'sample-user@example.com',
          }),
        })
      );
    });

    it('writes the GitHub token into the per-session secret when provided', async () => {
      const optsWithGitHubToken: CreateSessionOptions = {
        ...baseOpts,
        githubToken: 'gho_test_token',
      };

      await AgentSessionService.createSession(optsWithGitHubToken);

      expect(createAgentApiKeySecret).toHaveBeenCalledWith(
        'test-ns',
        'agent-secret-aaaaaaaa',
        'sk-ant-test-key',
        'gho_test_token',
        undefined,
        {}
      );
      expect(createAgentPod).toHaveBeenCalledWith(
        expect.objectContaining({
          hasGitHubToken: true,
        })
      );
    });

    it('enables dev mode for each specified service', async () => {
      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        services: [
          {
            name: 'web',
            deployId: 1,
            resourceName: 'web-build-uuid',
            devConfig: { image: 'node:20', command: 'pnpm dev' },
          },
          {
            name: 'api',
            deployId: 2,
            resourceName: 'api-build-uuid',
            devConfig: { image: 'node:20', command: 'pnpm start' },
          },
        ],
      };

      await AgentSessionService.createSession(optsWithServices);

      expect(mockEnableDevMode).toHaveBeenCalledTimes(2);
      expect(mockEnableDevMode).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentName: 'web-build-uuid',
          serviceName: 'web-build-uuid',
          namespace: 'test-ns',
          requiredNodeName: 'agent-node-a',
        })
      );
      expect(mockEnableDevMode).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentName: 'api-build-uuid',
          serviceName: 'api-build-uuid',
          namespace: 'test-ns',
          requiredNodeName: 'agent-node-a',
        })
      );
      expect(mockSessionQuery.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          devModeSnapshots: expect.objectContaining({
            '1': expect.any(Object),
            '2': expect.any(Object),
          }),
        })
      );
    });

    it('renders dev env templates with the shared build env renderer before enabling dev mode', async () => {
      const buildContext = {
        uuid: 'sample-build-123',
        namespace: 'sample-ns',
        enableFullYaml: true,
        enabledFeatures: [],
        pullRequest: {
          pullRequestNumber: 42,
          branchName: 'feature/sample-change',
          fullName: 'sample-org/sample-repo',
        },
        deploys: [
          {
            active: true,
            publicUrl: 'sample-service-sample-env.example.test',
            deployable: {
              name: 'sample-service',
              type: 'github',
              buildUUID: 'sample-build-123',
            },
          },
        ],
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      };

      (Build.query as jest.Mock) = jest
        .fn()
        .mockReturnValueOnce({
          findOne: jest.fn().mockReturnValue({
            withGraphFetched: jest.fn().mockResolvedValue(buildContext),
          }),
        })
        .mockReturnValueOnce({
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockResolvedValue({ namespace: 'static-env-ns' }),
          }),
        });

      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        buildUuid: 'sample-build-123',
        services: [
          {
            name: 'sample-service',
            deployId: 1,
            devConfig: {
              image: 'node:20',
              command: 'pnpm dev',
              env: {
                ASSET_PREFIX: 'https://{{sample-service_publicUrl}}',
              },
            },
          },
        ],
      };

      await AgentSessionService.createSession(optsWithServices);

      expect(buildContext.$fetchGraph).toHaveBeenCalledWith('[deploys.[service, deployable], pullRequest]');
      expect(mockEnableDevMode).toHaveBeenCalledWith(
        expect.objectContaining({
          devConfig: expect.objectContaining({
            env: {
              ASSET_PREFIX: 'https://sample-service-sample-env.example.test',
            },
          }),
        })
      );
    });

    it('runs install commands for all selected services during workspace init', async () => {
      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        services: [
          {
            name: 'web',
            deployId: 1,
            resourceName: 'web-build-uuid',
            devConfig: {
              image: 'node:20',
              command: 'pnpm dev',
              installCommand: 'cd /workspace/web && pnpm install',
            },
          },
          {
            name: 'api',
            deployId: 2,
            resourceName: 'api-build-uuid',
            devConfig: {
              image: 'node:20',
              command: 'pnpm start',
              installCommand: 'cd /workspace/api && pnpm install',
            },
          },
        ],
      };

      await AgentSessionService.createSession(optsWithServices);

      expect(createAgentPod).toHaveBeenCalledWith(
        expect.objectContaining({
          installCommand: 'cd /workspace/web && pnpm install\n\ncd /workspace/api && pnpm install',
        })
      );
    });

    it('rolls back on pod creation failure', async () => {
      (createAgentPod as jest.Mock).mockRejectedValue(new Error('pod creation failed'));

      await expect(AgentSessionService.createSession(baseOpts)).rejects.toThrow('pod creation failed');

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'lifecycle:agent:session:startup-failure:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        3600,
        expect.any(String)
      );
      expect(deleteAgentEditorService).not.toHaveBeenCalled();
      expect(deleteAgentPod).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();
      expect(deleteAgentApiKeySecret).not.toHaveBeenCalled();
      expect(cleanupForwardedAgentEnvSecrets).not.toHaveBeenCalled();
      expect(mockSessionQuery.patch).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });

    it('reverts deploy records and restores non-helm deploys on failure after dev mode', async () => {
      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        services: [{ name: 'web', deployId: 1, devConfig: { image: 'node:20', command: 'pnpm dev' } }],
      };

      mockSessionQuery.patch.mockRejectedValueOnce(new Error('snapshot persist failed')).mockResolvedValue(1);

      const deployManagerDeploy = jest.fn().mockResolvedValue(undefined);
      (DeploymentManager as jest.Mock).mockImplementation(() => ({
        deploy: deployManagerDeploy,
      }));

      const revertDeploys = [
        {
          id: 1,
          uuid: 'deploy-1',
          build: { namespace: 'test-ns' },
          deployable: { name: 'web', type: 'github', deploymentDependsOn: [] },
        },
      ];
      mockDeployQuery.withGraphFetched.mockResolvedValue(revertDeploys);

      await expect(AgentSessionService.createSession(optsWithServices)).rejects.toThrow('snapshot persist failed');

      expect(DeploymentManager).toHaveBeenCalledWith(revertDeploys);
      expect(deployManagerDeploy).toHaveBeenCalled();
      expect(mockDisableDevMode).toHaveBeenCalledTimes(2);
      expect(mockDisableDevMode).toHaveBeenNthCalledWith(
        1,
        'test-ns',
        'deploy-1',
        'deploy-1',
        expect.objectContaining({
          deployment: expect.objectContaining({
            deploymentName: 'service',
          }),
        })
      );
      expect(mockDisableDevMode).toHaveBeenNthCalledWith(
        2,
        'test-ns',
        'deploy-1',
        'deploy-1',
        expect.objectContaining({
          deployment: expect.objectContaining({
            deploymentName: 'service',
          }),
        })
      );
      expect(mockDisableDevMode.mock.invocationCallOrder[0]).toBeLessThan(
        deployManagerDeploy.mock.invocationCallOrder[0]
      );
    });

    it('retains failed agent resources while deploy restore finishes during rollback', async () => {
      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        services: [{ name: 'web', deployId: 1, devConfig: { image: 'node:20', command: 'pnpm dev' } }],
      };

      let releaseDeploy!: () => void;
      const deployManagerDeploy = jest.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseDeploy = resolve;
          })
      );
      (DeploymentManager as jest.Mock).mockImplementation(() => ({
        deploy: deployManagerDeploy,
      }));

      mockSessionQuery.patch.mockRejectedValueOnce(new Error('snapshot persist failed')).mockResolvedValue(1);

      const revertDeploys = [
        {
          id: 1,
          uuid: 'deploy-1',
          build: { namespace: 'test-ns' },
          deployable: { name: 'web', type: 'github', deploymentDependsOn: [] },
        },
      ];
      mockDeployQuery.withGraphFetched.mockResolvedValue(revertDeploys);

      const rollbackPromise = AgentSessionService.createSession(optsWithServices);
      await new Promise((resolve) => setImmediate(resolve));

      expect(deleteAgentPod).not.toHaveBeenCalled();
      expect(deleteAgentEditorService).not.toHaveBeenCalled();
      expect(deleteAgentApiKeySecret).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();

      releaseDeploy();
      await expect(rollbackPromise).rejects.toThrow('snapshot persist failed');
      expect(deleteAgentPod).not.toHaveBeenCalled();
      expect(deleteAgentEditorService).not.toHaveBeenCalled();
      expect(deleteAgentApiKeySecret).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();
    });
  });

  describe('endSession', () => {
    it('throws if session not found', async () => {
      (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue(null),
      });

      await expect(AgentSessionService.endSession('nonexistent')).rejects.toThrow('Session not found or already ended');
    });

    it('throws if session already ended', async () => {
      (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue({ id: 1, uuid: 'sess-1', status: 'ended' }),
      });

      await expect(AgentSessionService.endSession('sess-1')).rejects.toThrow('Session not found or already ended');
    });

    it('ends session, triggers deploy restore, deletes pod and pvc, updates DB and Redis', async () => {
      const activeSession = {
        id: 1,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        namespace: 'test-ns',
        podName: 'agent-sess1',
        pvcName: 'agent-pvc-sess1',
        forwardedAgentSecretProviders: ['aws'],
        devModeSnapshots: {
          '10': {
            deployment: {
              deploymentName: 'deploy-10',
              containerName: 'web',
              replicas: null,
              image: 'node:20',
              command: null,
              workingDir: null,
              env: null,
              volumeMounts: null,
              volumes: null,
              nodeSelector: null,
            },
            service: null,
          },
        },
      };

      const patchMock = jest.fn().mockResolvedValue(1);

      let agentQueryCount = 0;
      (AgentSession.query as jest.Mock) = jest.fn().mockImplementation(() => {
        agentQueryCount++;
        if (agentQueryCount === 1) {
          return { findOne: jest.fn().mockResolvedValue(activeSession) };
        }
        return { findById: jest.fn().mockReturnValue({ patch: patchMock }) };
      });

      const deployManagerDeploy = jest.fn().mockResolvedValue(undefined);
      (DeploymentManager as jest.Mock).mockImplementation(() => ({
        deploy: deployManagerDeploy,
      }));

      const devModeDeploys = [
        {
          id: 10,
          uuid: 'deploy-10',
          build: { namespace: 'test-ns' },
          deployable: { name: 'web', type: 'github', deploymentDependsOn: [] },
        },
      ];
      let deployQueryCount = 0;
      (Deploy.query as jest.Mock) = jest.fn().mockImplementation(() => {
        deployQueryCount++;
        if (deployQueryCount === 1) {
          return {
            where: jest.fn().mockReturnValue({
              withGraphFetched: jest.fn().mockResolvedValue(devModeDeploys),
            }),
          };
        }
        return { findById: jest.fn().mockReturnValue({ patch: jest.fn().mockResolvedValue(1) }) };
      });

      await AgentSessionService.endSession('sess-1');

      expect(DeploymentManager).toHaveBeenCalledWith(devModeDeploys);
      expect(deployManagerDeploy).toHaveBeenCalled();
      expect(mockDisableDevMode).toHaveBeenCalledTimes(1);
      expect(mockDisableDevMode).toHaveBeenCalledWith(
        'test-ns',
        'deploy-10',
        'deploy-10',
        activeSession.devModeSnapshots['10']
      );
      expect(mockDisableDevMode.mock.invocationCallOrder[0]).toBeLessThan(
        deployManagerDeploy.mock.invocationCallOrder[0]
      );
      expect(deleteAgentEditorService).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteAgentPod).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteAgentPvc).toHaveBeenCalledWith('test-ns', 'agent-pvc-sess1');
      expect(deleteAgentApiKeySecret).toHaveBeenCalledWith('test-ns', 'agent-secret-aaaaaaaa');
      expect(cleanupForwardedAgentEnvSecrets).toHaveBeenCalledWith('test-ns', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', [
        'aws',
      ]);
      expect(patchMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'ended', devModeSnapshots: {} }));
      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('cleans up a failed session when explicitly ended', async () => {
      const failedSession = {
        id: 1,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'error',
        namespace: 'test-ns',
        podName: 'agent-sess1',
        pvcName: 'agent-pvc-sess1',
        forwardedAgentSecretProviders: ['aws'],
        devModeSnapshots: {},
        buildUuid: null,
      };
      (AgentSession.query as jest.Mock) = jest
        .fn()
        .mockReturnValueOnce({
          findOne: jest.fn().mockResolvedValue(failedSession),
        })
        .mockReturnValueOnce({
          findById: jest.fn().mockReturnValue({
            patch: mockSessionQuery.patch,
          }),
        });

      await AgentSessionService.endSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      expect(deleteAgentEditorService).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteAgentPod).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteAgentApiKeySecret).toHaveBeenCalledWith('test-ns', 'agent-secret-aaaaaaaa');
      expect(cleanupForwardedAgentEnvSecrets).toHaveBeenCalledWith('test-ns', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', [
        'aws',
      ]);
      expect(deleteAgentPvc).toHaveBeenCalledWith('test-ns', 'agent-pvc-sess1');
      expect(mockSessionQuery.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ended',
          endedAt: expect.any(String),
        })
      );
    });

    it('returns after cleanup and restore trigger without waiting for redeploy to finish', async () => {
      const activeSession = {
        id: 1,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        namespace: 'test-ns',
        podName: 'agent-sess1',
        pvcName: 'agent-pvc-sess1',
        devModeSnapshots: {
          '10': {
            deployment: {
              deploymentName: 'deploy-10',
              containerName: 'web',
              replicas: null,
              image: 'node:20',
              command: null,
              workingDir: null,
              env: null,
              volumeMounts: null,
              volumes: null,
              nodeSelector: null,
            },
            service: null,
          },
        },
      };

      const patchMock = jest.fn().mockResolvedValue(1);

      let agentQueryCount = 0;
      (AgentSession.query as jest.Mock) = jest.fn().mockImplementation(() => {
        agentQueryCount++;
        if (agentQueryCount === 1) {
          return { findOne: jest.fn().mockResolvedValue(activeSession) };
        }
        return { findById: jest.fn().mockReturnValue({ patch: patchMock }) };
      });

      let releaseDeploy!: () => void;
      const deployManagerDeploy = jest.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseDeploy = resolve;
          })
      );
      (DeploymentManager as jest.Mock).mockImplementation(() => ({
        deploy: deployManagerDeploy,
      }));

      const devModeDeploys = [
        {
          id: 10,
          uuid: 'deploy-10',
          build: { namespace: 'test-ns' },
          deployable: { name: 'web', type: 'github', deploymentDependsOn: [] },
        },
      ];
      let deployQueryCount = 0;
      (Deploy.query as jest.Mock) = jest.fn().mockImplementation(() => {
        deployQueryCount++;
        if (deployQueryCount === 1) {
          return {
            where: jest.fn().mockReturnValue({
              withGraphFetched: jest.fn().mockResolvedValue(devModeDeploys),
            }),
          };
        }
        return { findById: jest.fn().mockReturnValue({ patch: jest.fn().mockResolvedValue(1) }) };
      });

      const endPromise = AgentSessionService.endSession('sess-1');
      await new Promise((resolve) => setImmediate(resolve));

      expect(deleteAgentPod).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteAgentEditorService).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteAgentApiKeySecret).toHaveBeenCalledWith('test-ns', 'agent-secret-aaaaaaaa');
      await expect(endPromise).resolves.toBeUndefined();
      expect(deleteAgentPvc).toHaveBeenCalledWith('test-ns', 'agent-pvc-sess1');
      expect(deployManagerDeploy).toHaveBeenCalledTimes(1);
      expect(mockDisableDevMode).toHaveBeenCalledTimes(1);

      releaseDeploy();
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockDisableDevMode).toHaveBeenCalledTimes(2);
    });

    it('queues sandbox cleanup instead of waiting on synchronous build deletion', async () => {
      const activeSandboxSession = {
        id: 444,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        namespace: 'sbx-test-build',
        podName: 'agent-sbx',
        pvcName: 'agent-pvc-sbx',
        buildUuid: 'sandbox-build-uuid',
      };

      const patchMock = jest.fn().mockResolvedValue(1);

      let agentQueryCount = 0;
      (AgentSession.query as jest.Mock) = jest.fn().mockImplementation(() => {
        agentQueryCount++;
        if (agentQueryCount === 1) {
          return { findOne: jest.fn().mockResolvedValue(activeSandboxSession) };
        }

        return { findById: jest.fn().mockReturnValue({ patch: patchMock }) };
      });

      const sandboxBuild = {
        id: 444,
        uuid: 'sandbox-build-uuid',
        kind: 'sandbox',
      };

      const buildGraphFetch = jest.fn().mockResolvedValue(sandboxBuild);
      const buildFindOne = jest.fn().mockReturnValue({
        withGraphFetched: buildGraphFetch,
      });

      (Build.query as unknown as jest.Mock) = jest.fn().mockReturnValue({
        findOne: buildFindOne,
      });

      await AgentSessionService.endSession('sess-sbx');

      expect(BuildServiceModule).toHaveBeenCalled();
      expect(mockedBuildServiceModule.deleteQueueAdd).toHaveBeenCalledWith(
        'delete',
        expect.objectContaining({
          buildId: 444,
          buildUuid: 'sandbox-build-uuid',
          sender: 'agent-session',
        })
      );
      expect(mockedBuildServiceModule.deleteBuild).not.toHaveBeenCalled();
      expect(patchMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'ended' }));
      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });
  });

  describe('getSession', () => {
    it('returns session by id', async () => {
      const session = { id: 1, uuid: 'sess-1', status: 'active', buildUuid: null, devModeSnapshots: {} };
      mockSessionQuery.findOne.mockResolvedValue(session);

      const result = await AgentSessionService.getSession('sess-1');

      expect(result).toEqual(
        expect.objectContaining({
          id: 'sess-1',
          status: 'active',
          startupFailure: null,
        })
      );
    });

    it('attaches persisted startup failure details for errored sessions', async () => {
      mockSessionQuery.findOne.mockResolvedValue({
        id: 1,
        uuid: 'sess-1',
        status: 'error',
        buildUuid: null,
        devModeSnapshots: {},
      });
      mockRedis.get.mockResolvedValueOnce(
        JSON.stringify({
          sessionId: 'sess-1',
          stage: 'connect_runtime',
          title: 'Agent pod failed to start',
          message: 'init-workspace: ImagePullBackOff',
          recordedAt: '2026-03-25T10:00:00.000Z',
        })
      );

      const result = await AgentSessionService.getSession('sess-1');

      expect(result).toEqual(
        expect.objectContaining({
          id: 'sess-1',
          status: 'error',
          startupFailure: {
            stage: 'connect_runtime',
            title: 'Agent pod failed to start',
            message: 'init-workspace: ImagePullBackOff',
            recordedAt: '2026-03-25T10:00:00.000Z',
          },
        })
      );
    });
  });

  describe('session startup failures', () => {
    it('returns the persisted runtime failure for a session', async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify({
          sessionId: 'sess-1',
          stage: 'connect_runtime',
          title: 'Agent pod failed to start',
          message: 'init-workspace: ImagePullBackOff',
          recordedAt: '2026-03-25T10:00:00.000Z',
        })
      );

      const result = await AgentSessionService.getSessionStartupFailure('sess-1');

      expect(mockRedis.get).toHaveBeenCalledWith('lifecycle:agent:session:startup-failure:sess-1');
      expect(result).toEqual({
        stage: 'connect_runtime',
        title: 'Agent pod failed to start',
        message: 'init-workspace: ImagePullBackOff',
        recordedAt: '2026-03-25T10:00:00.000Z',
      });
    });

    it('persists a runtime failure in Redis and marks the session errored', async () => {
      mockSessionQuery.findOne.mockResolvedValue({
        id: 123,
        uuid: 'sess-1',
        status: 'active',
      });

      const result = await AgentSessionService.markSessionRuntimeFailure(
        'sess-1',
        new Error('Agent pod failed to start: init-workspace: ImagePullBackOff')
      );

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'lifecycle:agent:session:startup-failure:sess-1',
        3600,
        expect.any(String)
      );
      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:sess-1');
      expect(mockSessionQuery.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          endedAt: expect.any(String),
        })
      );
      expect(result).toEqual(
        expect.objectContaining({
          stage: 'connect_runtime',
          title: 'Agent pod failed to start',
          message: 'init-workspace: ImagePullBackOff',
        })
      );
    });
  });

  describe('getActiveSessions', () => {
    it('returns active sessions for user', async () => {
      await AgentSessionService.getActiveSessions('user-123');

      expect(mockSessionQuery.where).toHaveBeenCalledWith({ userId: 'user-123' });
      expect(mockSessionQuery.whereIn).toHaveBeenCalledWith('status', ['starting', 'active']);
      expect(mockSessionQuery.orderBy).toHaveBeenNthCalledWith(1, 'updatedAt', 'desc');
      expect(mockSessionQuery.orderBy).toHaveBeenNthCalledWith(2, 'createdAt', 'desc');
    });
  });

  describe('getSessions', () => {
    it('returns enriched session metadata for active and ended sessions', async () => {
      const sessions = [
        {
          id: 101,
          uuid: 'sess-active',
          userId: 'user-123',
          buildUuid: 'build-1',
          status: 'active',
          devModeSnapshots: {},
        },
        {
          id: 202,
          uuid: 'sess-ended',
          userId: 'user-123',
          buildUuid: 'build-2',
          status: 'ended',
          devModeSnapshots: {
            '22': {
              deployment: {
                deploymentName: 'api',
                containerName: 'api',
                replicas: null,
                image: 'node:20',
                command: null,
                workingDir: null,
                env: null,
                volumeMounts: null,
                volumes: null,
                nodeSelector: null,
              },
              service: null,
            },
          },
        },
      ];

      const sessionsQuery = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest
          .fn()
          .mockImplementationOnce(() => sessionsQuery)
          .mockImplementationOnce(() => Promise.resolve(sessions)),
      };
      (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue(sessionsQuery);

      const buildGraph = jest.fn().mockResolvedValue([
        {
          uuid: 'build-1',
          pullRequest: {
            fullName: 'example-org/example-repo',
            branchName: 'feature/live',
          },
        },
        {
          uuid: 'build-2',
          baseBuild: {
            pullRequest: {
              fullName: 'example-org/example-repo',
              branchName: 'feature/sandbox',
            },
          },
        },
      ]);
      (Build.query as jest.Mock) = jest.fn().mockReturnValue({
        whereIn: jest.fn().mockReturnValue({
          withGraphFetched: buildGraph,
        }),
      });

      let deployQueryCount = 0;
      (Deploy.query as jest.Mock) = jest.fn().mockImplementation(() => {
        deployQueryCount += 1;

        if (deployQueryCount === 1) {
          return {
            whereIn: jest.fn().mockReturnValue({
              withGraphFetched: jest.fn().mockResolvedValue([
                {
                  id: 10,
                  devModeSessionId: 101,
                  branchName: 'feature/live',
                  repository: { fullName: 'example-org/example-repo' },
                  deployable: { name: 'grpc-echo' },
                },
              ]),
            }),
          };
        }

        return {
          whereIn: jest.fn().mockReturnValue({
            withGraphFetched: jest.fn().mockResolvedValue([
              {
                id: 22,
                branchName: 'feature/sandbox',
                repository: { fullName: 'example-org/example-repo' },
                deployable: { name: 'lc-test-gh-type' },
              },
            ]),
          }),
        };
      });

      const result = await AgentSessionService.getSessions('user-123', { includeEnded: true });

      expect(sessionsQuery.where).toHaveBeenCalledWith({ userId: 'user-123' });
      expect(result).toEqual([
        expect.objectContaining({
          id: 'sess-active',
          repo: 'example-org/example-repo',
          branch: 'feature/live',
          services: ['grpc-echo'],
          startupFailure: null,
        }),
        expect.objectContaining({
          id: 'sess-ended',
          repo: 'example-org/example-repo',
          branch: 'feature/sandbox',
          services: ['lc-test-gh-type'],
          startupFailure: null,
        }),
      ]);
    });

    it('attaches persisted startup failures to errored sessions in the list response', async () => {
      const sessions = [
        {
          id: 101,
          uuid: 'sess-error',
          userId: 'user-123',
          buildUuid: null,
          status: 'error',
          devModeSnapshots: {},
        },
      ];

      const sessionsQuery = {
        where: jest.fn().mockReturnThis(),
        orderBy: jest
          .fn()
          .mockImplementationOnce(() => sessionsQuery)
          .mockImplementationOnce(() => Promise.resolve(sessions)),
      };
      (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue(sessionsQuery);

      mockRedis.get.mockResolvedValueOnce(
        JSON.stringify({
          sessionId: 'sess-error',
          stage: 'connect_runtime',
          title: 'Agent pod failed to start',
          message: 'init-workspace: ImagePullBackOff',
          recordedAt: '2026-03-25T10:00:00.000Z',
        })
      );

      const result = await AgentSessionService.getSessions('user-123', { includeEnded: true });

      expect(result).toEqual([
        expect.objectContaining({
          id: 'sess-error',
          status: 'error',
          startupFailure: {
            stage: 'connect_runtime',
            title: 'Agent pod failed to start',
            message: 'init-workspace: ImagePullBackOff',
            recordedAt: '2026-03-25T10:00:00.000Z',
          },
        }),
      ]);
    });
  });

  describe('touchActivity', () => {
    it('updates lastActivity timestamp', async () => {
      (AgentSession.query as jest.Mock) = jest
        .fn()
        .mockReturnValueOnce({
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockResolvedValue({ id: 123 }),
          }),
        })
        .mockReturnValueOnce({
          findById: jest.fn().mockReturnValue({
            patch: mockSessionQuery.patch,
          }),
        });

      await AgentSessionService.touchActivity('sess-1');

      expect(mockSessionQuery.patch).toHaveBeenCalledWith(
        expect.objectContaining({ lastActivity: expect.any(String) })
      );
    });
  });
});
