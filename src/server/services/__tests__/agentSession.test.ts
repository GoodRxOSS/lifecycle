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

const mockGetCompatibleReadyPrewarm = jest.fn();
const mockGetReadyPrewarmByPvc = jest.fn();
const mockExecInPod = jest.fn();
const mockResolveSessionPodServersForRepo = jest.fn().mockResolvedValue([]);
const mockGetDefaultThreadForSession = jest.fn().mockResolvedValue({ uuid: 'default-thread-1' });
const mockCreateOrUpdateNamespace = jest.fn().mockResolvedValue(undefined);
const mockDeleteNamespace = jest.fn().mockResolvedValue(undefined);
const mockResolveWorkspaceRuntimePlan = jest.fn();
const mockToWorkspaceRuntimePlanMetadata = jest.fn();
const mockCreateOpenSandboxRuntimeService = jest.fn();

jest.mock('server/models/AgentSession');
jest.mock('server/models/AgentThread');
jest.mock('server/models/AgentSource');
jest.mock('server/models/AgentSandbox');
jest.mock('server/models/AgentSandboxExposure');
jest.mock('server/models/AgentRun');
jest.mock('server/models/Build');
jest.mock('server/models/Deploy');
jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/lib/encryption', () => ({
  encrypt: jest.fn((value: string) => `enc:${value}`),
  decrypt: jest.fn((value: string) => value.replace(/^enc:/, '')),
  isEncryptionKeyConfigured: jest.fn(() => true),
}));
jest.mock('server/lib/agentSession/pvcFactory');
jest.mock('server/lib/agentSession/apiKeySecretFactory');
jest.mock('server/lib/agentSession/podFactory');
jest.mock('server/lib/agentSession/editorServiceFactory');
jest.mock('server/lib/agentSession/serviceAccountFactory');
jest.mock('server/lib/agentSession/gvisorCheck');
jest.mock('server/lib/agentSession/configSeeder');
jest.mock('server/lib/agentSession/devModeManager');
jest.mock('server/lib/agentSession/forwardedEnv');
jest.mock('server/lib/agentSession/workspaceRuntimePlan', () => {
  const actual = jest.requireActual('server/lib/agentSession/workspaceRuntimePlan');
  return {
    __esModule: true,
    ...actual,
    resolveWorkspaceRuntimePlan: (...args: unknown[]) => mockResolveWorkspaceRuntimePlan(...args),
    toWorkspaceRuntimePlanMetadata: (...args: unknown[]) => mockToWorkspaceRuntimePlanMetadata(...args),
  };
});
jest.mock('server/services/workspaceRuntime/providers/opensandbox', () => {
  const actual = jest.requireActual('server/services/workspaceRuntime/providers/opensandbox');
  return {
    __esModule: true,
    ...actual,
    createOpenSandboxRuntimeService: (...args: unknown[]) => mockCreateOpenSandboxRuntimeService(...args),
  };
});
jest.mock('server/lib/agentSession/chatPreviewFactory', () => ({
  buildChatPreviewHostSlug: () => 'abcdef1234567890abcdef1234567890',
  resolveChatPreviewPublicPublication: () => ({
    url: 'http://3000--abcdef1234567890abcdef1234567890.localhost:5001/',
    host: '3000--abcdef1234567890abcdef1234567890.localhost:5001',
    path: '/',
  }),
}));
jest.mock('server/lib/kubernetes', () => ({
  createOrUpdateNamespace: (...args: unknown[]) => mockCreateOrUpdateNamespace(...args),
  deleteNamespace: (...args: unknown[]) => mockDeleteNamespace(...args),
}));
jest.mock('server/lib/kubernetes/networkPolicyFactory');
jest.mock('server/services/agentRuntime/mcp/config', () => ({
  __esModule: true,
  McpConfigService: jest.fn().mockImplementation(() => ({
    resolveSessionPodServersForRepo: mockResolveSessionPodServersForRepo,
  })),
}));
jest.mock('server/lib/agentSession/runtimeConfig', () => {
  const actual = jest.requireActual('server/lib/agentSession/runtimeConfig');
  return {
    __esModule: true,
    ...actual,
    resolveAgentSessionControlPlaneConfig: jest.fn(actual.resolveAgentSessionControlPlaneConfig),
    resolveAgentSessionRuntimeConfig: jest.fn(actual.resolveAgentSessionRuntimeConfig),
  };
});
jest.mock('server/lib/agentSession/systemPrompt', () => {
  const actual = jest.requireActual('server/lib/agentSession/systemPrompt');
  return {
    __esModule: true,
    ...actual,
    buildAgentSessionDynamicSystemPrompt: jest.fn(actual.buildAgentSessionDynamicSystemPrompt),
    combineAgentSessionAppendSystemPrompt: jest.fn(actual.combineAgentSessionAppendSystemPrompt),
    resolveAgentSessionPromptContext: jest.fn(actual.resolveAgentSessionPromptContext),
  };
});
const mockGetEffectiveAgentSessionConfig = jest.fn();
jest.mock('server/services/agentSessionConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getEffectiveConfig: mockGetEffectiveAgentSessionConfig,
    })),
  },
}));
jest.mock('server/services/userApiKey');
jest.mock('server/services/agentSessionCandidates', () => {
  const actual = jest.requireActual('server/services/agentSessionCandidates');
  return {
    __esModule: true,
    ...actual,
    loadAgentSessionServiceCandidates: jest.fn(),
  };
});
jest.mock('server/services/agentPrewarm', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getCompatibleReadyPrewarm: mockGetCompatibleReadyPrewarm,
    getReadyPrewarmByPvc: mockGetReadyPrewarmByPvc,
  })),
}));
jest.mock('server/services/agent/ThreadService', () => ({
  __esModule: true,
  default: {
    getDefaultThreadForSession: (...args: unknown[]) => mockGetDefaultThreadForSession(...args),
  },
}));
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
    Exec: jest.fn().mockImplementation(() => ({
      exec: mockExecInPod,
    })),
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockReturnValue({
        createNamespacedNetworkPolicy: jest.fn().mockResolvedValue({}),
        readNamespacedPod: jest.fn().mockResolvedValue({
          body: {
            spec: {
              nodeName: 'agent-node-a',
            },
          },
        }),
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
      getConfig: jest.fn().mockImplementation(async (key: string) => {
        if (key === 'agentRuntime') {
          return {
            enabled: true,
            providers: [
              {
                name: 'anthropic',
                enabled: true,
                apiKeyEnvVar: 'ANTHROPIC_API_KEY',
                models: [
                  {
                    id: 'claude-sonnet-4-6',
                    displayName: 'Claude Sonnet',
                    enabled: true,
                    default: true,
                    maxTokens: 8192,
                  },
                ],
              },
            ],
            maxMessagesPerSession: 50,
            sessionTTL: 3600,
          };
        }

        return null;
      }),
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

import AgentSessionService, {
  AgentSessionStartupError,
  CreateSessionOptions,
  buildAgentSessionPodName,
} from 'server/services/agentSession';
import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';
import AgentSource from 'server/models/AgentSource';
import AgentSandbox from 'server/models/AgentSandbox';
import AgentSandboxExposure from 'server/models/AgentSandboxExposure';
import AgentRun from 'server/models/AgentRun';
import Build from 'server/models/Build';
import Deploy from 'server/models/Deploy';
import { createAgentPvc, deleteAgentPvc } from 'server/lib/agentSession/pvcFactory';
import { createAgentApiKeySecret, deleteAgentApiKeySecret } from 'server/lib/agentSession/apiKeySecretFactory';
import {
  createSessionWorkspacePod,
  createSessionWorkspacePodWithoutWaiting,
  deleteSessionWorkspacePod,
  waitForSessionWorkspacePodReady,
  waitForSessionWorkspacePodScheduled,
} from 'server/lib/agentSession/podFactory';
import {
  createSessionWorkspaceService,
  deleteSessionWorkspaceService,
} from 'server/lib/agentSession/editorServiceFactory';
import { ensureAgentSessionServiceAccount } from 'server/lib/agentSession/serviceAccountFactory';
import { isGvisorAvailable } from 'server/lib/agentSession/gvisorCheck';
import { DevModeManager } from 'server/lib/agentSession/devModeManager';
import {
  applyForwardedAgentEnvSecrets,
  cleanupForwardedAgentEnvSecrets,
  planForwardedAgentEnv,
  resolveForwardedAgentEnv,
} from 'server/lib/agentSession/forwardedEnv';
import type { WorkspaceRuntimePlan } from 'server/lib/agentSession/workspaceRuntimePlan';
import { buildAgentNetworkPolicy } from 'server/lib/kubernetes/networkPolicyFactory';
import * as runtimeConfig from 'server/lib/agentSession/runtimeConfig';
import * as systemPrompt from 'server/lib/agentSession/systemPrompt';
import UserApiKeyService from 'server/services/userApiKey';
import RedisClient from 'server/lib/redisClient';
import { deployHelm } from 'server/lib/nativeHelm/helm';
import { DeploymentManager } from 'server/lib/deploymentManager/deploymentManager';
import BuildServiceModule from 'server/services/build';
import { loadAgentSessionServiceCandidates } from 'server/services/agentSessionCandidates';
import { AgentChatStatus, AgentSessionKind, AgentWorkspaceStatus, BuildKind } from 'shared/constants';
import WorkspaceRuntimeStateService, {
  WorkspaceActionBlockedError,
} from 'server/services/agent/WorkspaceRuntimeStateService';
import AgentSandboxService from 'server/services/agent/SandboxService';

const mockRedis = {
  setex: jest.fn().mockResolvedValue('OK'),
  get: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(1),
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

function buildDevModeSnapshot(deploymentName = 'service') {
  return {
    deployment: {
      deploymentName,
      containerName: deploymentName,
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
  };
}

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
const mockRestorePreviewExposures = jest.spyOn(AgentSandboxService, 'restorePreviewExposures');

const mockEnableDevMode = jest.fn().mockResolvedValue(buildDevModeSnapshot());
const mockDisableDevMode = jest.fn().mockResolvedValue(undefined);
(DevModeManager as jest.Mock).mockImplementation(() => ({
  enableDevMode: mockEnableDevMode,
  disableDevMode: mockDisableDevMode,
}));

(isGvisorAvailable as jest.Mock).mockResolvedValue(false);
(createAgentPvc as jest.Mock).mockResolvedValue({});
(createAgentApiKeySecret as jest.Mock).mockResolvedValue({});
(createSessionWorkspacePod as jest.Mock).mockResolvedValue({ spec: { nodeName: 'agent-node-a' } });
(createSessionWorkspacePodWithoutWaiting as jest.Mock).mockResolvedValue(undefined);
(waitForSessionWorkspacePodReady as jest.Mock).mockResolvedValue({ spec: { nodeName: 'agent-node-a' } });
(waitForSessionWorkspacePodScheduled as jest.Mock).mockResolvedValue({ spec: { nodeName: 'agent-node-a' } });
(createSessionWorkspaceService as jest.Mock).mockResolvedValue({});
(ensureAgentSessionServiceAccount as jest.Mock).mockResolvedValue('agent-sa');
(deleteSessionWorkspacePod as jest.Mock).mockResolvedValue(undefined);
(deleteAgentPvc as jest.Mock).mockResolvedValue(undefined);
(deleteAgentApiKeySecret as jest.Mock).mockResolvedValue(undefined);
(deleteSessionWorkspaceService as jest.Mock).mockResolvedValue(undefined);
(deployHelm as jest.Mock).mockResolvedValue(undefined);

const mockSessionQuery = {
  where: jest.fn().mockReturnThis(),
  whereIn: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  first: jest.fn(),
  findOne: jest.fn(),
  select: jest.fn(),
  findById: jest.fn().mockReturnThis(),
  forUpdate: jest.fn(),
  patch: jest.fn().mockResolvedValue(1),
  patchAndFetchById: jest.fn(),
  insert: jest.fn().mockResolvedValue({}),
  insertAndFetch: jest.fn(),
};
(AgentSession.query as jest.Mock) = jest.fn().mockReturnValue(mockSessionQuery);
(AgentSession.transaction as jest.Mock) = jest.fn();

const mockThreadQuery = {
  insertAndFetch: jest.fn(),
};
(AgentThread.query as jest.Mock) = jest.fn().mockReturnValue(mockThreadQuery);

const mockSourceQuery = {
  findOne: jest.fn(),
  insert: jest.fn().mockResolvedValue({}),
  insertAndFetch: jest.fn(),
  patchAndFetchById: jest.fn(),
};
(AgentSource.query as jest.Mock) = jest.fn().mockReturnValue(mockSourceQuery);

const mockSandboxQuery = {
  where: jest.fn().mockReturnThis(),
  whereIn: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  first: jest.fn(),
  insertAndFetch: jest.fn(),
  patchAndFetchById: jest.fn(),
};
(AgentSandbox.query as jest.Mock) = jest.fn().mockReturnValue(mockSandboxQuery);

const mockSandboxExposureQuery = {
  where: jest.fn().mockReturnThis(),
  whereNull: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  first: jest.fn(),
  insert: jest.fn().mockResolvedValue({}),
  insertAndFetch: jest.fn(),
  patch: jest.fn().mockResolvedValue(1),
  patchAndFetchById: jest.fn(),
};
(AgentSandboxExposure.query as jest.Mock) = jest.fn().mockReturnValue(mockSandboxExposureQuery);

const mockRunQuery = {
  where: jest.fn().mockReturnThis(),
  whereNotIn: jest.fn().mockReturnThis(),
  whereNot: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  first: jest.fn().mockResolvedValue(null),
};
(AgentRun.query as jest.Mock) = jest.fn().mockReturnValue(mockRunQuery);

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
  repoUrl: 'https://github.com/example-org/example-repo.git',
  branch: 'feature/example-session',
  workspaceImage: 'lifecycle-agent:latest',
  workspaceEditorImage: 'codercom/code-server:4.98.2',
};

const actualWorkspaceRuntimePlan = jest.requireActual(
  'server/lib/agentSession/workspaceRuntimePlan'
) as typeof import('server/lib/agentSession/workspaceRuntimePlan');

function buildWorkspaceBackendConfig(provider: 'lifecycle_kubernetes' | 'opensandbox' = 'lifecycle_kubernetes') {
  return {
    provider,
    opensandbox: {
      domain: 'opensandbox.example.test',
      protocol: 'https' as const,
      timeoutSeconds: 3600,
      useServerProxy: false,
      secureAccess: true,
      resourceLimits: {},
      execdPort: 13337,
      gatewayPort: 13338,
      editorPort: 13339,
    },
    e2b: {
      domain: 'e2b.app',
      timeoutSeconds: 3600,
      autoPause: true,
      gatewayPort: 13338,
      editorPort: 13337,
    },
    daytona: {
      apiUrl: 'https://app.daytona.io/api',
      autoArchiveInterval: 0,
      gatewayPort: 13338,
      editorPort: 13337,
    },
    modal: {
      appName: 'lifecycle-workspaces',
      image: 'lifecycleoss/workspace:latest',
      timeoutSeconds: 14400,
      gatewayPort: 13338,
    },
  };
}

function buildRuntimePlan(overrides: Partial<WorkspaceRuntimePlan> = {}): WorkspaceRuntimePlan {
  const basePlan: WorkspaceRuntimePlan = {
    version: 1,
    kind: 'environment',
    sessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    namespace: 'test-ns',
    podName: 'agent-aaaaaaaa',
    apiKeySecretName: 'agent-secret-aaaaaaaa',
    runtimeConfig: {
      workspaceImage: 'lifecycle-agent:latest',
      workspaceEditorImage: 'codercom/code-server:4.98.2',
      workspaceGatewayImage: 'lifecycle-agent:latest',
      workspaceBackend: buildWorkspaceBackendConfig(),
      nodeSelector: undefined,
      keepAttachedServicesOnSessionNode: true,
      readiness: undefined,
      resources: undefined,
      workspaceStorage: {
        defaultSize: '10Gi',
        allowedSizes: ['10Gi', '20Gi'],
        allowClientOverride: true,
        accessMode: 'ReadWriteOnce',
      },
      cleanup: {
        activeIdleSuspendMs: 30 * 60 * 1000,
        startingTimeoutMs: 15 * 60 * 1000,
        hibernatedRetentionMs: 24 * 60 * 60 * 1000,
        intervalMs: 5 * 60 * 1000,
        redisTtlSeconds: 7200,
      },
      durability: {
        runExecutionLeaseMs: 30 * 60 * 1000,
        queuedRunDispatchStaleMs: 30 * 1000,
        dispatchRecoveryLimit: 50,
        maxDurablePayloadBytes: 64 * 1024,
        payloadPreviewBytes: 16 * 1024,
        fileChangePreviewChars: 4000,
      },
    },
    workspaceStorage: {
      requestedSize: null,
      storageSize: '10Gi',
      accessMode: 'ReadWriteOnce',
    },
    servicePlan: {
      workspaceRepos: [
        {
          repo: 'example-org/example-repo',
          repoUrl: 'https://github.com/example-org/example-repo.git',
          branch: 'feature/example-session',
          mountPath: '/workspace',
          primary: true,
        },
      ],
      services: undefined,
      selectedServices: [],
    },
    skillPlan: { version: 1, skills: [] },
    provider: {
      selection: {
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-6',
      },
      apiKey: 'sample-anthropic-provider-key',
      credentialEnv: {
        ANTHROPIC_API_KEY: 'sample-anthropic-provider-key',
      },
    },
    startupMcp: {
      servers: [],
      serializedConfig: '[]',
    },
    forwardedEnv: {
      env: {},
      secretRefs: [],
      secretProviders: [],
      secretServiceName: 'agent-env-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    },
    credentials: {
      hasGitHubToken: false,
      githubToken: null,
    },
    prewarm: {
      compatiblePrewarm: null,
      pvcName: 'agent-pvc-aaaaaaaa',
      skipWorkspaceBootstrap: false,
      ownsPvc: true,
    },
  };

  return {
    ...basePlan,
    ...overrides,
    runtimeConfig: {
      ...basePlan.runtimeConfig,
      ...(overrides.runtimeConfig || {}),
    },
    workspaceStorage: {
      ...basePlan.workspaceStorage,
      ...(overrides.workspaceStorage || {}),
    },
    servicePlan: {
      ...basePlan.servicePlan,
      ...(overrides.servicePlan || {}),
    },
    skillPlan: {
      ...basePlan.skillPlan,
      ...(overrides.skillPlan || {}),
    },
    provider: {
      ...basePlan.provider,
      ...(overrides.provider || {}),
    },
    startupMcp: {
      ...basePlan.startupMcp,
      ...(overrides.startupMcp || {}),
    },
    forwardedEnv: {
      ...basePlan.forwardedEnv,
      ...(overrides.forwardedEnv || {}),
    },
    credentials: {
      ...basePlan.credentials,
      ...(overrides.credentials || {}),
    },
    prewarm: {
      ...basePlan.prewarm,
      ...(overrides.prewarm || {}),
    },
  };
}

function sandboxWritePayloads(): Array<Record<string, unknown>> {
  return [
    ...mockSandboxQuery.insertAndFetch.mock.calls.map(([payload]) => payload),
    ...mockSandboxQuery.patchAndFetchById.mock.calls.map(([, payload]) => payload),
  ].filter(Boolean);
}

function expectSandboxFailure(expectedFailure: {
  stage: string;
  origin: string;
  title?: string;
  message?: string;
}): void {
  expect(sandboxWritePayloads()).toContainEqual(
    expect.objectContaining({
      status: 'failed',
      error: expect.objectContaining({
        stage: expectedFailure.stage,
        origin: expectedFailure.origin,
        ...(expectedFailure.title ? { title: expectedFailure.title } : {}),
        ...(expectedFailure.message ? { message: expect.stringContaining(expectedFailure.message) } : {}),
        retryable: false,
        recordedAt: expect.any(String),
      }),
    })
  );
}

function expectNoCreateSessionKubernetesHelpersCalled(): void {
  expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
  expect(mockDeleteNamespace).not.toHaveBeenCalled();
  expect(createAgentPvc).not.toHaveBeenCalled();
  expect(deleteAgentPvc).not.toHaveBeenCalled();
  expect(createAgentApiKeySecret).not.toHaveBeenCalled();
  expect(deleteAgentApiKeySecret).not.toHaveBeenCalled();
  expect(ensureAgentSessionServiceAccount).not.toHaveBeenCalled();
  expect(createSessionWorkspaceService).not.toHaveBeenCalled();
  expect(deleteSessionWorkspaceService).not.toHaveBeenCalled();
  expect(buildAgentNetworkPolicy).not.toHaveBeenCalled();
  expect(isGvisorAvailable).not.toHaveBeenCalled();
  expect(createSessionWorkspacePod).not.toHaveBeenCalled();
  expect(createSessionWorkspacePodWithoutWaiting).not.toHaveBeenCalled();
  expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
  expect(applyForwardedAgentEnvSecrets).not.toHaveBeenCalled();
  expect(cleanupForwardedAgentEnvSecrets).not.toHaveBeenCalled();
}

function mockPersistedSandboxMetadata(metadata: Record<string, unknown>): void {
  const persistedSandbox = { id: 654, metadata };
  mockSandboxQuery.first
    .mockResolvedValueOnce(persistedSandbox)
    .mockResolvedValueOnce(persistedSandbox)
    .mockImplementation(async () => {
      const latestPayload = sandboxWritePayloads().at(-1);
      return latestPayload ? { id: 654, ...latestPayload } : persistedSandbox;
    });
}

function mockOpenSandboxRuntime() {
  const runtime = {
    backendId: 'opensandbox',
    reattach: jest.fn().mockResolvedValue(null),
    provision: jest.fn(),
    destroy: jest.fn().mockResolvedValue(undefined),
    suspend: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn(),
    resolveGatewayEndpoint: jest.fn().mockReturnValue(null),
    resolveEditorEndpoint: jest.fn().mockReturnValue(null),
    capabilities: jest.fn().mockReturnValue({ backend: 'opensandbox' }),
    hasPersistedHandle: jest.fn((state: unknown) => Boolean((state as { sandboxId?: unknown })?.sandboxId)),
  };
  mockCreateOpenSandboxRuntimeService.mockReturnValue(runtime);
  return runtime;
}

// Persisted opensandbox sandbox row that still reflects subsequent lifecycle writes.
function mockOpenSandboxSandboxRow(): void {
  const row = {
    id: 654,
    sessionId: 321,
    generation: 1,
    provider: 'opensandbox',
    status: 'ready',
    providerState: {
      sandboxId: 'sbx-123',
      lifecycleBaseUrl: 'https://opensandbox.example.test/v1',
    },
    metadata: {},
    endedAt: null,
  };
  mockSandboxQuery.first.mockImplementation(async () => {
    const latestPayload = sandboxWritePayloads().at(-1);
    return latestPayload ? { ...row, ...latestPayload } : row;
  });
}

function queuePatchedSession(baseSession: Record<string, unknown>): void {
  mockSessionQuery.patchAndFetchById.mockImplementationOnce(async (_id, patch) => ({
    ...baseSession,
    ...(patch as Record<string, unknown>),
  }));
}

function buildChatRuntimeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 321,
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    userId: 'sample-user',
    ownerGithubUsername: 'sample-user',
    sessionKind: AgentSessionKind.CHAT,
    podName: null,
    namespace: null,
    pvcName: null,
    model: 'claude-sonnet-4-6',
    buildKind: null,
    status: 'active',
    chatStatus: AgentChatStatus.READY,
    workspaceStatus: AgentWorkspaceStatus.NONE,
    devModeSnapshots: {},
    forwardedAgentSecretProviders: [],
    workspaceRepos: [],
    selectedServices: [],
    skillPlan: { version: 1, skills: [] },
    ...overrides,
  };
}

function mockEndSessionSession(session: Record<string, unknown>): void {
  mockSessionQuery.findOne.mockResolvedValueOnce(session);
  mockSessionQuery.forUpdate.mockResolvedValueOnce(session);
  queuePatchedSession(session);
}

function queueEndedSession(session: Record<string, unknown>, extraPatch: Record<string, unknown> = {}): void {
  queuePatchedSession({
    ...session,
    status: 'ended',
    chatStatus: AgentChatStatus.ENDED,
    workspaceStatus: AgentWorkspaceStatus.ENDED,
    endedAt: new Date().toISOString(),
    ...extraPatch,
  });
}

describe('AgentSessionService', () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  describe('buildAgentSessionPodName', () => {
    it('keeps the legacy short form when no build UUID is provided', () => {
      expect(buildAgentSessionPodName('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe('agent-aaaaaaaa');
    });

    it('includes the build UUID when available', () => {
      expect(buildAgentSessionPodName('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'sandbox-build-uuid')).toBe(
        'agent-sandbox-build-uuid'
      );
    });

    it('sanitizes and truncates long build UUIDs to a Kubernetes-safe name', () => {
      const podName = buildAgentSessionPodName(
        'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        'Build_UUID_With.Invalid.Characters.And-A-Very-Long-Descriptive-Suffix-1234567890'
      );

      expect(podName).toBe('agent-build-uuid-with-invalid-characters-and-a-very-long-descri');
      expect(podName.length).toBeLessThanOrEqual(63);
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRestorePreviewExposures.mockResolvedValue(0);
    delete process.env.ANTHROPIC_API_KEY;
    (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue(mockSessionQuery);
    (AgentSession.transaction as jest.Mock) = jest.fn(async (callback) => callback({ trx: true }));
    (AgentThread.query as jest.Mock) = jest.fn().mockReturnValue(mockThreadQuery);
    (AgentSource.query as jest.Mock) = jest.fn().mockReturnValue(mockSourceQuery);
    (AgentSandbox.query as jest.Mock) = jest.fn().mockReturnValue(mockSandboxQuery);
    (AgentSandboxExposure.query as jest.Mock) = jest.fn().mockReturnValue(mockSandboxExposureQuery);
    (AgentRun.query as jest.Mock) = jest.fn().mockReturnValue(mockRunQuery);
    (Deploy.query as jest.Mock) = jest.fn().mockReturnValue(mockDeployQuery);
    mockSessionQuery.where.mockReturnThis();
    mockSessionQuery.whereIn.mockReturnThis();
    mockSessionQuery.orderBy.mockReturnThis();
    mockSessionQuery.first.mockResolvedValue(null);
    mockSessionQuery.findOne.mockResolvedValue(null);
    mockSessionQuery.select.mockResolvedValue({ id: 123 });
    mockSessionQuery.findById.mockReturnThis();
    mockSessionQuery.forUpdate.mockResolvedValue({
      id: 123,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: null,
      sessionKind: 'environment',
      podName: 'agent-aaaaaaaa',
      namespace: 'test-ns',
      pvcName: 'agent-pvc-aaaaaaaa',
      model: 'claude-sonnet-4-6',
      buildKind: 'environment',
      status: 'starting',
      chatStatus: 'ready',
      workspaceStatus: 'provisioning',
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
    });
    mockSessionQuery.patch.mockResolvedValue(1);
    mockSessionQuery.patchAndFetchById.mockImplementation(async (_id, patch) => ({
      id: 123,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: null,
      sessionKind: 'environment',
      podName: 'agent-aaaaaaaa',
      namespace: 'test-ns',
      pvcName: 'agent-pvc-aaaaaaaa',
      model: 'claude-sonnet-4-6',
      buildKind: 'environment',
      status: 'starting',
      chatStatus: 'ready',
      workspaceStatus: 'provisioning',
      defaultThreadId: 456,
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      ...(patch as Record<string, unknown>),
    }));
    mockSessionQuery.insert.mockResolvedValue({});
    mockSessionQuery.insertAndFetch.mockResolvedValue({
      id: 123,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: null,
      sessionKind: 'environment',
      podName: 'agent-aaaaaaaa',
      namespace: 'test-ns',
      pvcName: 'agent-pvc-aaaaaaaa',
      model: 'claude-sonnet-4-6',
      buildKind: 'environment',
      status: 'starting',
      chatStatus: 'ready',
      workspaceStatus: 'provisioning',
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
    });
    mockThreadQuery.insertAndFetch.mockResolvedValue({
      id: 456,
      uuid: 'default-thread-1',
      sessionId: 123,
      title: 'Default thread',
      isDefault: true,
      metadata: {
        sessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      },
    });
    mockSourceQuery.findOne.mockResolvedValue(null);
    mockSourceQuery.insert.mockResolvedValue({});
    mockSourceQuery.insertAndFetch.mockResolvedValue({
      id: 321,
      uuid: 'source-1',
      sessionId: 123,
      status: 'ready',
    });
    mockSourceQuery.patchAndFetchById.mockResolvedValue({});
    mockSandboxQuery.where.mockReturnThis();
    mockSandboxQuery.whereIn.mockReturnThis();
    mockSandboxQuery.orderBy.mockReturnThis();
    mockSandboxQuery.first.mockImplementation(async () => {
      const latestPayload = sandboxWritePayloads().at(-1);
      return latestPayload ? { id: 654, ...latestPayload } : null;
    });
    mockSandboxQuery.insertAndFetch.mockResolvedValue({
      id: 654,
      uuid: 'sandbox-1',
      sessionId: 123,
      generation: 1,
      provider: 'lifecycle_kubernetes',
      status: 'provisioning',
      endedAt: null,
    });
    mockSandboxQuery.patchAndFetchById.mockResolvedValue({
      id: 654,
      uuid: 'sandbox-1',
      sessionId: 123,
      generation: 1,
      provider: 'lifecycle_kubernetes',
      status: 'ready',
      endedAt: null,
    });
    mockSandboxExposureQuery.where.mockReturnThis();
    mockSandboxExposureQuery.whereNull.mockReturnThis();
    mockSandboxExposureQuery.orderBy.mockReturnThis();
    mockSandboxExposureQuery.first.mockResolvedValue(null);
    mockSandboxExposureQuery.insert.mockResolvedValue({});
    mockSandboxExposureQuery.insertAndFetch.mockResolvedValue({});
    mockSandboxExposureQuery.patch.mockResolvedValue(1);
    mockSandboxExposureQuery.patchAndFetchById.mockResolvedValue({});
    mockRunQuery.where.mockReturnThis();
    mockRunQuery.whereNotIn.mockReturnThis();
    mockRunQuery.whereNot.mockReturnThis();
    mockRunQuery.orderBy.mockReturnThis();
    mockRunQuery.first.mockResolvedValue(null);
    mockDeployQuery.where.mockReturnThis();
    mockDeployQuery.whereIn.mockReturnThis();
    mockDeployQuery.findById.mockReturnThis();
    mockDeployQuery.patch.mockResolvedValue(1);
    mockDeployQuery.withGraphFetched.mockResolvedValue([]);
    (UserApiKeyService.getDecryptedKey as jest.Mock) = jest.fn().mockResolvedValue('sample-anthropic-provider-key');

    jest.spyOn(RedisClient, 'getInstance').mockReturnValue({
      getRedis: () => mockRedis as any,
      getRedlock: () => ({} as any),
      getConnection: () => ({} as any),
      close: jest.fn(),
    } as any);

    mockRedis.setex.mockResolvedValue('OK');
    mockRedis.get.mockResolvedValue(null);
    mockRedis.del.mockResolvedValue(1);
    mockEnableDevMode.mockResolvedValue(buildDevModeSnapshot());
    mockDisableDevMode.mockResolvedValue(undefined);
    (isGvisorAvailable as jest.Mock).mockResolvedValue(false);
    (createAgentPvc as jest.Mock).mockResolvedValue({});
    (createAgentApiKeySecret as jest.Mock).mockResolvedValue({});
    (createSessionWorkspacePod as jest.Mock).mockResolvedValue({ spec: { nodeName: 'agent-node-a' } });
    (createSessionWorkspacePodWithoutWaiting as jest.Mock).mockResolvedValue(undefined);
    (waitForSessionWorkspacePodReady as jest.Mock).mockResolvedValue({ spec: { nodeName: 'agent-node-a' } });
    (waitForSessionWorkspacePodScheduled as jest.Mock).mockResolvedValue({ spec: { nodeName: 'agent-node-a' } });
    (createSessionWorkspaceService as jest.Mock).mockResolvedValue({});
    (ensureAgentSessionServiceAccount as jest.Mock).mockResolvedValue('agent-sa');
    (deleteSessionWorkspacePod as jest.Mock).mockResolvedValue(undefined);
    (deleteAgentPvc as jest.Mock).mockResolvedValue(undefined);
    (deleteAgentApiKeySecret as jest.Mock).mockResolvedValue(undefined);
    (deleteSessionWorkspaceService as jest.Mock).mockResolvedValue(undefined);
    (deployHelm as jest.Mock).mockResolvedValue(undefined);
    (DeploymentManager as jest.Mock).mockImplementation(() => ({
      deploy: jest.fn().mockResolvedValue(undefined),
    }));
    mockedBuildServiceModule.deleteQueueAdd.mockResolvedValue(undefined);
    mockedBuildServiceModule.deleteBuild.mockResolvedValue(undefined);
    mockGetCompatibleReadyPrewarm.mockResolvedValue(null);
    mockGetReadyPrewarmByPvc.mockResolvedValue(null);
    mockGetDefaultThreadForSession.mockResolvedValue({ uuid: 'default-thread-1' });
    mockCreateOrUpdateNamespace.mockResolvedValue(undefined);
    mockDeleteNamespace.mockResolvedValue(undefined);
    mockExecInPod.mockImplementation(
      async (
        _namespace: string,
        _podName: string,
        _containerName: string,
        _command: string[],
        _stdout: unknown,
        _stderr: unknown,
        _stdin: unknown,
        _tty: boolean,
        statusCallback?: (status: Record<string, unknown>) => void
      ) => {
        statusCallback?.({ status: 'Success' });
        return {
          on: jest.fn(),
        };
      }
    );
    (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValue([]);
    (planForwardedAgentEnv as jest.Mock).mockResolvedValue({
      env: {},
      secretRefs: [],
      secretProviders: [],
      secretServiceName: 'agent-env-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    (applyForwardedAgentEnvSecrets as jest.Mock).mockImplementation(async ({ plan }) => plan);
    (resolveForwardedAgentEnv as jest.Mock).mockResolvedValue({
      env: {},
      secretRefs: [],
      secretProviders: [],
      secretServiceName: 'agent-env-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    (cleanupForwardedAgentEnvSecrets as jest.Mock).mockResolvedValue(undefined);
    mockResolveWorkspaceRuntimePlan.mockImplementation(actualWorkspaceRuntimePlan.resolveWorkspaceRuntimePlan);
    mockToWorkspaceRuntimePlanMetadata.mockImplementation(actualWorkspaceRuntimePlan.toWorkspaceRuntimePlanMetadata);
    mockCreateOpenSandboxRuntimeService.mockReset();
    mockResolveSessionPodServersForRepo.mockResolvedValue([]);
    (runtimeConfig.resolveAgentSessionControlPlaneConfig as jest.Mock).mockResolvedValue({
      appendSystemPrompt: undefined,
    });
    (runtimeConfig.resolveAgentSessionRuntimeConfig as jest.Mock).mockResolvedValue({
      workspaceImage: 'lifecycle-agent:latest',
      workspaceEditorImage: 'codercom/code-server:4.98.2',
      workspaceGatewayImage: 'lifecycle-agent:latest',
      workspaceBackend: buildWorkspaceBackendConfig(),
      nodeSelector: undefined,
      keepAttachedServicesOnSessionNode: true,
      readiness: undefined,
      resources: undefined,
      workspaceStorage: {
        defaultSize: '10Gi',
        allowedSizes: ['10Gi'],
        allowClientOverride: false,
        accessMode: 'ReadWriteOnce',
      },
      cleanup: {
        activeIdleSuspendMs: 30 * 60 * 1000,
        startingTimeoutMs: 15 * 60 * 1000,
        hibernatedRetentionMs: 24 * 60 * 60 * 1000,
        intervalMs: 5 * 60 * 1000,
        redisTtlSeconds: 7200,
      },
      durability: {
        runExecutionLeaseMs: 30 * 60 * 1000,
        queuedRunDispatchStaleMs: 30 * 1000,
        dispatchRecoveryLimit: 50,
        maxDurablePayloadBytes: 64 * 1024,
        payloadPreviewBytes: 16 * 1024,
        fileChangePreviewChars: 4000,
      },
    });
    (systemPrompt.buildAgentSessionDynamicSystemPrompt as jest.Mock).mockImplementation(
      jest.requireActual('server/lib/agentSession/systemPrompt').buildAgentSessionDynamicSystemPrompt
    );
    (systemPrompt.combineAgentSessionAppendSystemPrompt as jest.Mock).mockImplementation(
      jest.requireActual('server/lib/agentSession/systemPrompt').combineAgentSessionAppendSystemPrompt
    );
    (systemPrompt.resolveAgentSessionPromptContext as jest.Mock).mockImplementation(
      jest.requireActual('server/lib/agentSession/systemPrompt').resolveAgentSessionPromptContext
    );
  });

  afterAll(() => {
    if (originalAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
  });

  it('creates a chat session without provisioning runtime resources', async () => {
    mockSessionQuery.insertAndFetch.mockResolvedValueOnce({
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: null,
      sessionKind: 'chat',
      podName: null,
      namespace: null,
      pvcName: null,
      model: 'claude-sonnet-4-6',
      buildKind: null,
      status: 'active',
      chatStatus: 'ready',
      workspaceStatus: 'none',
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      workspaceRepos: [],
      selectedServices: [],
      skillPlan: { version: 1, skills: [] },
    });
    mockThreadQuery.insertAndFetch.mockResolvedValueOnce({
      id: 654,
      uuid: 'default-thread-1',
      sessionId: 321,
      title: 'Default thread',
      isDefault: true,
      metadata: {
        sessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      },
    });
    mockSessionQuery.patchAndFetchById.mockResolvedValueOnce({
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: null,
      sessionKind: 'chat',
      podName: null,
      namespace: null,
      pvcName: null,
      model: 'claude-sonnet-4-6',
      buildKind: null,
      status: 'active',
      chatStatus: 'ready',
      workspaceStatus: 'none',
      defaultThreadId: 654,
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      workspaceRepos: [],
      selectedServices: [],
      skillPlan: { version: 1, skills: [] },
    });

    const session = await AgentSessionService.createChatSession({
      userId: 'user-123',
      model: 'claude-sonnet-4-6',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSessionQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKind: AgentSessionKind.CHAT,
        buildKind: null,
        podName: null,
        namespace: null,
        pvcName: null,
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.NONE,
      })
    );
    expect(createAgentPvc).not.toHaveBeenCalled();
    expect(createSessionWorkspacePod).not.toHaveBeenCalled();
    expect(createSessionWorkspaceService).not.toHaveBeenCalled();
    expect(mockThreadQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 321,
        title: 'Default thread',
        isDefault: true,
      })
    );
    expect(mockSourceQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 321,
        adapter: 'blank_workspace',
        status: 'ready',
      })
    );
    expect(AgentSession.transaction).toHaveBeenCalledTimes(1);
    expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
      321,
      expect.objectContaining({
        defaultThreadId: 654,
      })
    );
    expect(mockGetDefaultThreadForSession).not.toHaveBeenCalled();
    expect(session.sessionKind).toBe('chat');
    expect(session.workspaceStatus).toBe('none');
    expect(session.defaultThreadId).toBe(654);
  });

  it('provisions a blank workspace runtime for a chat session on demand', async () => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: 'sample-user',
      sessionKind: 'chat',
      podName: null,
      namespace: null,
      pvcName: null,
      model: 'claude-sonnet-4-6',
      buildKind: null,
      status: 'active',
      chatStatus: 'ready',
      workspaceStatus: 'none',
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      workspaceRepos: [],
      selectedServices: [],
      skillPlan: { version: 1, skills: [] },
    };
    const readyChatSession = {
      ...chatSession,
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      workspaceStatus: 'ready',
    };

    mockSessionQuery.findOne.mockResolvedValueOnce(chatSession).mockResolvedValueOnce(readyChatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession(readyChatSession);

    const session = await AgentSessionService.provisionChatRuntime({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      userIdentity: {
        userId: 'user-123',
        githubUsername: 'sample-user',
      } as any,
      githubToken: 'sample-gh-token',
    });

    expect(mockCreateOrUpdateNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'chat-aaaaaaaa',
        buildUUID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        author: 'sample-user',
      })
    );
    expect(createAgentPvc).toHaveBeenCalledWith(
      'chat-aaaaaaaa',
      'agent-pvc-aaaaaaaa',
      '10Gi',
      undefined,
      'ReadWriteOnce'
    );
    expect(createAgentApiKeySecret).toHaveBeenCalledWith(
      'chat-aaaaaaaa',
      'agent-secret-aaaaaaaa',
      {
        ANTHROPIC_API_KEY: 'sample-anthropic-provider-key',
      },
      'sample-gh-token',
      undefined,
      {},
      {
        LIFECYCLE_SESSION_MCP_CONFIG_JSON: '[]',
        LIFECYCLE_GATEWAY_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/),
      }
    );
    expect(createSessionWorkspacePod).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'chat-aaaaaaaa',
        podName: 'agent-aaaaaaaa',
        pvcName: 'agent-pvc-aaaaaaaa',
        workspaceRepos: [],
      })
    );
    expect(createSessionWorkspaceService).toHaveBeenCalledWith('chat-aaaaaaaa', 'agent-aaaaaaaa');
    expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
      321,
      expect.objectContaining({
        workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
        namespace: 'chat-aaaaaaaa',
        podName: 'agent-aaaaaaaa',
        pvcName: 'agent-pvc-aaaaaaaa',
      })
    );
    expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
      321,
      expect.objectContaining({
        workspaceStatus: AgentWorkspaceStatus.READY,
        namespace: 'chat-aaaaaaaa',
        podName: 'agent-aaaaaaaa',
        pvcName: 'agent-pvc-aaaaaaaa',
      })
    );
    expect(session.workspaceStatus).toBe('ready');
    expect(session.namespace).toBe('chat-aaaaaaaa');
  });

  it('persists the freshly minted gateway token encrypted in kubernetes provider state', async () => {
    const chatSession = buildChatRuntimeSession({ userId: 'user-123' });
    const readyChatSession = {
      ...chatSession,
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      workspaceStatus: AgentWorkspaceStatus.READY,
    };
    mockSessionQuery.findOne.mockResolvedValueOnce(chatSession).mockResolvedValueOnce(readyChatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession(readyChatSession);

    await AgentSessionService.provisionChatRuntime({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      userIdentity: { userId: 'user-123', githubUsername: 'sample-user' } as any,
      githubToken: 'sample-gh-token',
    });

    const secretData = (createAgentApiKeySecret as jest.Mock).mock.calls[0][6] as Record<string, string>;
    const mintedToken = secretData.LIFECYCLE_GATEWAY_TOKEN;
    expect(mintedToken).toMatch(/^[0-9a-f]{64}$/);
    // The pod sees the plaintext via the secret; the DB row only ever sees the ciphertext.
    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        status: 'ready',
        providerState: expect.objectContaining({ gatewayToken: `enc:${mintedToken}` }),
      })
    );
    expect(JSON.stringify(sandboxWritePayloads())).not.toContain(`"${mintedToken}"`);
  });

  it('re-mints the gateway token on kubernetes resume instead of reusing the stale one', async () => {
    const hibernatedSession = buildChatRuntimeSession({
      namespace: 'chat-aaaaaaaa',
      podName: null,
      pvcName: 'agent-pvc-aaaaaaaa',
      workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
    });
    const readyChatSession = {
      ...hibernatedSession,
      podName: 'agent-aaaaaaaa',
      workspaceStatus: AgentWorkspaceStatus.READY,
    };
    // The suspended row still carries the previous (now-orphaned) encrypted token.
    const sandboxRow = {
      id: 654,
      sessionId: 321,
      generation: 1,
      provider: 'lifecycle_kubernetes',
      status: 'suspended',
      providerState: { namespace: 'chat-aaaaaaaa', pvcName: 'agent-pvc-aaaaaaaa', gatewayToken: 'enc:stale-token' },
      metadata: {},
      endedAt: null,
    };
    mockSandboxQuery.first.mockImplementation(async () => {
      const payloads = sandboxWritePayloads();
      const latestPayload = payloads[payloads.length - 1];
      return latestPayload ? { ...sandboxRow, ...latestPayload } : sandboxRow;
    });
    mockSessionQuery.findOne
      .mockResolvedValueOnce(hibernatedSession)
      .mockResolvedValueOnce(hibernatedSession)
      .mockResolvedValueOnce(readyChatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(hibernatedSession);
    queuePatchedSession(hibernatedSession);
    queuePatchedSession(readyChatSession);

    await AgentSessionService.resumeChatRuntime({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      userIdentity: { userId: 'sample-user', githubUsername: 'sample-user' } as any,
      githubToken: 'sample-gh-token',
    });

    // The suspend deleted the per-session secret, so resume must mint a fresh token...
    const secretData = (createAgentApiKeySecret as jest.Mock).mock.calls[0][6] as Record<string, string>;
    const mintedToken = secretData.LIFECYCLE_GATEWAY_TOKEN;
    expect(mintedToken).toMatch(/^[0-9a-f]{64}$/);
    // ...while the claim write carries the stale ciphertext over instead of clobbering it...
    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        status: 'resuming',
        providerState: expect.objectContaining({ gatewayToken: 'enc:stale-token' }),
      })
    );
    // ...and the ready write replaces it with the re-minted one.
    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        status: 'ready',
        providerState: expect.objectContaining({ gatewayToken: `enc:${mintedToken}` }),
      })
    );
  });

  it('passes a freshly minted gateway token to remote provisioning and persists only the ciphertext', async () => {
    const runtime = mockOpenSandboxRuntime();
    runtime.provision.mockResolvedValue({
      providerState: { sandboxId: 'sbx-9', lifecycleBaseUrl: 'https://opensandbox.example.test/v1' },
      capabilitySnapshot: { backend: 'opensandbox' },
      podNameAlias: 'sbx-9',
    });
    mockResolveWorkspaceRuntimePlan.mockResolvedValue(
      buildRuntimePlan({
        kind: 'chat',
        runtimeConfig: {
          workspaceBackend: buildWorkspaceBackendConfig('opensandbox'),
        } as Partial<WorkspaceRuntimePlan>['runtimeConfig'],
      })
    );
    const chatSession = buildChatRuntimeSession({ userId: 'user-123' });
    const readyChatSession = {
      ...chatSession,
      namespace: 'chat-aaaaaaaa',
      podName: 'sbx-9',
      pvcName: null,
      workspaceStatus: AgentWorkspaceStatus.READY,
    };
    mockSessionQuery.findOne.mockResolvedValueOnce(chatSession).mockResolvedValueOnce(readyChatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession(readyChatSession);

    await AgentSessionService.provisionChatRuntime({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      userIdentity: { userId: 'user-123', githubUsername: 'sample-user' } as any,
      githubToken: 'sample-gh-token',
    });

    expect(runtime.provision).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayToken: expect.stringMatching(/^[0-9a-f]{64}$/) })
    );
    const mintedToken = (runtime.provision.mock.calls[0][0] as { gatewayToken: string }).gatewayToken;
    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        provider: 'opensandbox',
        status: 'ready',
        providerState: expect.objectContaining({ sandboxId: 'sbx-9', gatewayToken: `enc:${mintedToken}` }),
      })
    );
    expect(JSON.stringify(sandboxWritePayloads())).not.toContain(`"${mintedToken}"`);
  });

  it('opens an already-ready chat runtime without lifecycle or Kubernetes side effects', async () => {
    expect(typeof AgentSessionService.openChatRuntime).toBe('function');
    const readyChatSession = buildChatRuntimeSession({
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      workspaceStatus: AgentWorkspaceStatus.READY,
    });
    const claimSpy = jest.spyOn(WorkspaceRuntimeStateService, 'claimWorkspaceAction');
    mockSessionQuery.findOne.mockResolvedValueOnce(readyChatSession);

    const session = await AgentSessionService.openChatRuntime({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      userIdentity: {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      } as any,
      githubToken: 'sample-gh-token',
    });

    expect(session).toBe(readyChatSession);
    expect(claimSpy).not.toHaveBeenCalled();
    expect(mockResolveWorkspaceRuntimePlan).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    expect(createAgentPvc).not.toHaveBeenCalled();
    expect(createAgentApiKeySecret).not.toHaveBeenCalled();
    expect(createSessionWorkspaceService).not.toHaveBeenCalled();
    expect(createSessionWorkspacePod).not.toHaveBeenCalled();
    expect(sandboxWritePayloads()).toHaveLength(0);
    claimSpy.mockRestore();
  });

  it('opens a missing chat runtime through provisioning and claims the provision action', async () => {
    expect(typeof AgentSessionService.openChatRuntime).toBe('function');
    const chatSession = buildChatRuntimeSession();
    const readyChatSession = buildChatRuntimeSession({
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      workspaceStatus: AgentWorkspaceStatus.READY,
    });
    mockSessionQuery.findOne
      .mockResolvedValueOnce(chatSession)
      .mockResolvedValueOnce(chatSession)
      .mockResolvedValueOnce(readyChatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession(readyChatSession);

    const session = await AgentSessionService.openChatRuntime({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      userIdentity: {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      } as any,
      githubToken: 'sample-gh-token',
    });

    expect(session.workspaceStatus).toBe(AgentWorkspaceStatus.READY);
    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        status: 'provisioning',
        metadata: expect.objectContaining({
          runtimeLifecycle: expect.objectContaining({
            currentAction: 'provision',
            claimedAt: expect.any(String),
          }),
        }),
      })
    );
  });

  it('passes the allowed active run id when provisioning a missing chat runtime', async () => {
    expect(typeof AgentSessionService.openChatRuntime).toBe('function');
    const chatSession = buildChatRuntimeSession();
    const readyChatSession = buildChatRuntimeSession({
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      workspaceStatus: AgentWorkspaceStatus.READY,
    });
    const claimSpy = jest.spyOn(WorkspaceRuntimeStateService, 'claimWorkspaceAction');
    mockSessionQuery.findOne
      .mockResolvedValueOnce(chatSession)
      .mockResolvedValueOnce(chatSession)
      .mockResolvedValueOnce(readyChatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession(readyChatSession);

    await AgentSessionService.openChatRuntime({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      userIdentity: {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      } as any,
      githubToken: 'sample-gh-token',
      allowedActiveRunUuid: 'run-current',
    });

    expect(claimSpy).toHaveBeenCalledWith(
      321,
      expect.objectContaining({
        action: 'provision',
        allowedActiveRunUuid: 'run-current',
      })
    );
    claimSpy.mockRestore();
  });

  it('records first chat runtime provisioning failures as retryable', async () => {
    expect(typeof AgentSessionService.openChatRuntime).toBe('function');
    const chatSession = buildChatRuntimeSession();
    mockSessionQuery.findOne.mockResolvedValue(chatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession({
      ...chatSession,
      workspaceStatus: AgentWorkspaceStatus.FAILED,
    });
    (createSessionWorkspacePod as jest.Mock).mockRejectedValueOnce(new Error('first open failed'));

    await expect(
      AgentSessionService.openChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'sample-user',
        userIdentity: {
          userId: 'sample-user',
          githubUsername: 'sample-user',
        } as any,
        githubToken: 'sample-gh-token',
      })
    ).rejects.toThrow('first open failed');

    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({
          origin: 'chat_runtime',
          retryable: true,
        }),
      })
    );
  });

  it('opens a failed chat runtime through retry and preserves active chat state on retry failure', async () => {
    expect(typeof AgentSessionService.openChatRuntime).toBe('function');
    const failedChatSession = buildChatRuntimeSession({
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      workspaceStatus: AgentWorkspaceStatus.FAILED,
    });
    mockSessionQuery.findOne.mockResolvedValue(failedChatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(failedChatSession);
    queuePatchedSession(failedChatSession);
    queuePatchedSession({
      ...failedChatSession,
      workspaceStatus: AgentWorkspaceStatus.FAILED,
    });
    (createSessionWorkspacePod as jest.Mock).mockRejectedValueOnce(new Error('retry pod failed'));

    await expect(
      AgentSessionService.openChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'sample-user',
        userIdentity: {
          userId: 'sample-user',
          githubUsername: 'sample-user',
        } as any,
        githubToken: 'sample-gh-token',
      })
    ).rejects.toThrow('retry pod failed');

    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        status: 'provisioning',
        metadata: expect.objectContaining({
          runtimeLifecycle: expect.objectContaining({
            currentAction: 'retry',
            claimedAt: expect.any(String),
          }),
        }),
      })
    );
    expect(mockSessionQuery.patchAndFetchById).toHaveBeenLastCalledWith(
      321,
      expect.objectContaining({
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.FAILED,
      })
    );
    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({
          origin: 'chat_runtime',
          retryable: true,
        }),
      })
    );
  });

  it('opens a hibernated chat runtime through hibernated-only resume behavior', async () => {
    expect(typeof AgentSessionService.openChatRuntime).toBe('function');
    const hibernatedChatSession = buildChatRuntimeSession({
      namespace: 'chat-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
    });
    const readyChatSession = buildChatRuntimeSession({
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      workspaceStatus: AgentWorkspaceStatus.READY,
    });
    mockSessionQuery.findOne
      .mockResolvedValueOnce(hibernatedChatSession)
      .mockResolvedValueOnce(hibernatedChatSession)
      .mockResolvedValueOnce(hibernatedChatSession)
      .mockResolvedValueOnce(readyChatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(hibernatedChatSession);
    queuePatchedSession(hibernatedChatSession);
    queuePatchedSession(readyChatSession);

    const session = await AgentSessionService.openChatRuntime({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      userIdentity: {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      } as any,
      githubToken: 'sample-gh-token',
    });

    expect(session.workspaceStatus).toBe(AgentWorkspaceStatus.READY);
    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        status: 'resuming',
        metadata: expect.objectContaining({
          runtimeLifecycle: expect.objectContaining({
            currentAction: 'resume',
            claimedAt: expect.any(String),
          }),
        }),
      })
    );
  });

  it('blocks canonical chat open when a workspace lifecycle action is already active', async () => {
    expect(typeof AgentSessionService.openChatRuntime).toBe('function');
    const failedChatSession = buildChatRuntimeSession({
      workspaceStatus: AgentWorkspaceStatus.FAILED,
    });
    mockSessionQuery.findOne.mockResolvedValue(failedChatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(failedChatSession);
    // The backend-stickiness probe reads the sandbox before the claim, so the row must persist.
    mockSandboxQuery.first.mockResolvedValue({
      id: 654,
      metadata: {
        runtimeLifecycle: {
          currentAction: 'suspend',
          claimedAt: new Date().toISOString(),
        },
      },
    });

    await expect(
      AgentSessionService.openChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'sample-user',
        userIdentity: {
          userId: 'sample-user',
          githubUsername: 'sample-user',
        } as any,
        githubToken: 'sample-gh-token',
      })
    ).rejects.toBeInstanceOf(WorkspaceActionBlockedError);

    expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    expect(createAgentPvc).not.toHaveBeenCalled();
    expect(createAgentApiKeySecret).not.toHaveBeenCalled();
    expect(createSessionWorkspacePod).not.toHaveBeenCalled();
    expect(mockSessionQuery.patchAndFetchById).not.toHaveBeenCalled();
  });

  it('rejects malformed ready chat runtime state before Kubernetes side effects', async () => {
    expect(typeof AgentSessionService.openChatRuntime).toBe('function');
    const malformedReadySession = buildChatRuntimeSession({
      workspaceStatus: AgentWorkspaceStatus.READY,
      namespace: 'chat-aaaaaaaa',
      podName: null,
      pvcName: 'agent-pvc-aaaaaaaa',
    });
    mockSessionQuery.findOne.mockResolvedValueOnce(malformedReadySession);

    await expect(
      AgentSessionService.openChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'sample-user',
        userIdentity: {
          userId: 'sample-user',
          githubUsername: 'sample-user',
        } as any,
        githubToken: 'sample-gh-token',
      })
    ).rejects.toThrow('Workspace runtime is marked ready but missing runtime references');

    expect(mockResolveWorkspaceRuntimePlan).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    expect(createAgentPvc).not.toHaveBeenCalled();
    expect(createAgentApiKeySecret).not.toHaveBeenCalled();
    expect(createSessionWorkspacePod).not.toHaveBeenCalled();
    expect(sandboxWritePayloads()).toHaveLength(0);
  });

  it('resolves the chat workspace runtime plan before namespace creation', async () => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: 'sample-user',
      sessionKind: 'chat',
      podName: null,
      namespace: null,
      pvcName: null,
      model: 'claude-sonnet-4-6',
      buildKind: null,
      status: 'active',
      chatStatus: 'ready',
      workspaceStatus: 'none',
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      workspaceRepos: [],
      selectedServices: [],
      skillPlan: { version: 1, skills: [] },
    };
    const readyChatSession = {
      ...chatSession,
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      workspaceStatus: 'ready',
    };
    const runtimePlan = buildRuntimePlan({
      kind: 'chat',
      namespace: 'chat-aaaaaaaa',
      servicePlan: {
        workspaceRepos: [],
        services: undefined,
        selectedServices: [],
      },
      credentials: {
        hasGitHubToken: true,
        githubToken: 'sample-gh-token',
      },
    });
    mockResolveWorkspaceRuntimePlan.mockImplementation(async () => {
      expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
      return runtimePlan;
    });
    mockSessionQuery.findOne.mockResolvedValueOnce(chatSession).mockResolvedValueOnce(readyChatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession(readyChatSession);

    await AgentSessionService.provisionChatRuntime({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      userIdentity: {
        userId: 'user-123',
        githubUsername: 'sample-user',
      } as any,
      githubToken: 'sample-gh-token',
    });

    expect(mockResolveWorkspaceRuntimePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat',
        sessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        namespace: 'chat-aaaaaaaa',
        userId: 'user-123',
        githubToken: 'sample-gh-token',
        workspaceRepos: [],
        services: undefined,
        model: 'claude-sonnet-4-6',
      })
    );
    expect(mockResolveWorkspaceRuntimePlan.mock.invocationCallOrder[0]).toBeLessThan(
      mockSessionQuery.patchAndFetchById.mock.invocationCallOrder[0]
    );
    expect(mockSessionQuery.patchAndFetchById.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateOrUpdateNamespace.mock.invocationCallOrder[0]
    );
    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        status: 'provisioning',
        metadata: expect.objectContaining({
          runtimeLifecycle: expect.objectContaining({
            currentAction: 'provision',
            claimedAt: expect.any(String),
          }),
        }),
      })
    );
  });

  it.each([
    ['provision', AgentWorkspaceStatus.NONE],
    ['resume', AgentWorkspaceStatus.HIBERNATED],
  ])('blocks chat runtime %s while another workspace action is active', async (action, workspaceStatus) => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: 'sample-user',
      sessionKind: 'chat',
      podName: null,
      namespace: 'chat-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      model: 'claude-sonnet-4-6',
      buildKind: null,
      status: 'active',
      chatStatus: 'ready',
      workspaceStatus,
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      workspaceRepos: [],
      selectedServices: [],
      skillPlan: { version: 1, skills: [] },
    };
    mockSessionQuery.findOne.mockResolvedValue(chatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    // The backend-stickiness probe reads the sandbox before the claim, so the row must persist.
    mockSandboxQuery.first.mockResolvedValue({
      id: 654,
      metadata: {
        runtimeLifecycle: {
          currentAction: 'provision',
          claimedAt: new Date().toISOString(),
        },
      },
    });
    mockResolveWorkspaceRuntimePlan.mockResolvedValue(
      buildRuntimePlan({
        kind: 'chat',
        namespace: 'chat-aaaaaaaa',
        servicePlan: {
          workspaceRepos: [],
          services: undefined,
          selectedServices: [],
        },
      })
    );

    await expect(
      action === 'resume'
        ? AgentSessionService.resumeChatRuntime({
            sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            userId: 'user-123',
            userIdentity: {
              userId: 'user-123',
              githubUsername: 'sample-user',
            } as any,
            githubToken: 'sample-gh-token',
          })
        : AgentSessionService.provisionChatRuntime({
            sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            userId: 'user-123',
            userIdentity: {
              userId: 'user-123',
              githubUsername: 'sample-user',
            } as any,
            githubToken: 'sample-gh-token',
          })
    ).rejects.toBeInstanceOf(WorkspaceActionBlockedError);

    expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    expect(createAgentPvc).not.toHaveBeenCalled();
    expect(createAgentApiKeySecret).not.toHaveBeenCalled();
    expect(createSessionWorkspacePod).not.toHaveBeenCalled();
    expect(mockSessionQuery.patchAndFetchById).not.toHaveBeenCalled();
    expect(sandboxWritePayloads()).toHaveLength(0);
  });

  it.each(['provision', 'resume'])(
    'returns a canonical conflict when chat runtime %s sees an in-flight provisioning row',
    async (action) => {
      const chatSession = {
        id: 321,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'user-123',
        ownerGithubUsername: 'sample-user',
        sessionKind: 'chat',
        podName: null,
        namespace: 'chat-aaaaaaaa',
        pvcName: 'agent-pvc-aaaaaaaa',
        model: 'claude-sonnet-4-6',
        buildKind: null,
        status: 'active',
        chatStatus: 'ready',
        workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
        devModeSnapshots: {},
        forwardedAgentSecretProviders: [],
        workspaceRepos: [],
        selectedServices: [],
        skillPlan: { version: 1, skills: [] },
      };
      mockSessionQuery.findOne.mockResolvedValue(chatSession);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
      mockSandboxQuery.first.mockResolvedValueOnce({
        id: 654,
        metadata: {
          runtimeLifecycle: {
            currentAction: action,
            claimedAt: new Date().toISOString(),
          },
        },
      });

      await expect(
        action === 'resume'
          ? AgentSessionService.resumeChatRuntime({
              sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
              userId: 'user-123',
              userIdentity: {
                userId: 'user-123',
                githubUsername: 'sample-user',
              } as any,
              githubToken: 'sample-gh-token',
            })
          : AgentSessionService.provisionChatRuntime({
              sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
              userId: 'user-123',
              userIdentity: {
                userId: 'user-123',
                githubUsername: 'sample-user',
              } as any,
              githubToken: 'sample-gh-token',
            })
      ).rejects.toBeInstanceOf(WorkspaceActionBlockedError);

      expect(mockResolveWorkspaceRuntimePlan).not.toHaveBeenCalled();
      expect(mockSessionQuery.patchAndFetchById).not.toHaveBeenCalled();
      expect(sandboxWritePayloads()).toHaveLength(0);
    }
  );

  it('does not create chat runtime resources when workspace runtime plan resolution fails', async () => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: 'sample-user',
      sessionKind: 'chat',
      podName: null,
      namespace: null,
      pvcName: null,
      model: 'claude-sonnet-4-6',
      buildKind: null,
      status: 'active',
      chatStatus: 'ready',
      workspaceStatus: 'none',
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      workspaceRepos: [],
      selectedServices: [],
      skillPlan: { version: 1, skills: [] },
    };
    mockSessionQuery.findOne.mockResolvedValue(chatSession);
    queuePatchedSession({
      ...chatSession,
      workspaceStatus: AgentWorkspaceStatus.FAILED,
      namespace: null,
      podName: null,
      pvcName: null,
    });
    mockResolveWorkspaceRuntimePlan.mockRejectedValue(new Error('plan failed'));

    await expect(
      AgentSessionService.provisionChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'user-123',
        userIdentity: {
          userId: 'user-123',
          githubUsername: 'sample-user',
        } as any,
        githubToken: 'sample-gh-token',
      })
    ).rejects.toThrow('plan failed');

    expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    expect(createAgentPvc).not.toHaveBeenCalled();
    expect(createAgentApiKeySecret).not.toHaveBeenCalled();
    expect(ensureAgentSessionServiceAccount).not.toHaveBeenCalled();
    expect(createSessionWorkspaceService).not.toHaveBeenCalled();
    expect(buildAgentNetworkPolicy).not.toHaveBeenCalled();
    expect(createSessionWorkspacePod).not.toHaveBeenCalled();
    expect(createSessionWorkspacePodWithoutWaiting).not.toHaveBeenCalled();
    expect(sandboxWritePayloads()).not.toContainEqual(
      expect.objectContaining({
        status: 'ready',
      })
    );
    expect(sandboxWritePayloads()).not.toContainEqual(
      expect.objectContaining({
        status: 'provisioning',
      })
    );
    expectSandboxFailure({ stage: 'prepare_infrastructure', origin: 'chat_runtime' });
    const failedSandboxWrite = sandboxWritePayloads().find((payload) => payload.status === 'failed');
    expect(failedSandboxWrite?.providerState).not.toEqual(
      expect.objectContaining({
        namespace: expect.any(String),
      })
    );
    expect(failedSandboxWrite?.providerState).not.toEqual(
      expect.objectContaining({
        podName: expect.any(String),
      })
    );
    expect(failedSandboxWrite?.providerState).not.toEqual(
      expect.objectContaining({
        pvcName: expect.any(String),
      })
    );
    expect(mockSandboxExposureQuery.insert).not.toHaveBeenCalled();
    expect(mockSandboxExposureQuery.patchAndFetchById).not.toHaveBeenCalled();
  });

  it('writes startup MCP config from the chat runtime plan into the API-key secret', async () => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: 'sample-user',
      sessionKind: 'chat',
      podName: null,
      namespace: null,
      pvcName: null,
      model: 'claude-sonnet-4-6',
      buildKind: null,
      status: 'active',
      chatStatus: 'ready',
      workspaceStatus: 'none',
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      workspaceRepos: [
        {
          repo: 'example-org/example-repo',
          repoUrl: 'https://github.com/example-org/example-repo.git',
          branch: 'feature/sample',
          revision: 'commit-sha-1',
          mountPath: '/workspace',
          primary: true,
        },
      ],
      selectedServices: [],
      skillPlan: { version: 1, skills: [] },
    };
    const readyChatSession = {
      ...chatSession,
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      workspaceStatus: 'ready',
    };
    const serializedMcpConfig = JSON.stringify([
      {
        slug: 'sample-stdio',
        name: 'Sample stdio',
        transport: {
          type: 'stdio',
          command: 'sample-mcp',
          args: ['--stdio'],
          env: {
            SAMPLE_TOKEN: 'sample-secret',
          },
        },
        timeout: 30000,
      },
    ]);
    mockSessionQuery.findOne.mockResolvedValueOnce(chatSession).mockResolvedValueOnce(readyChatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession(readyChatSession);
    mockResolveWorkspaceRuntimePlan.mockResolvedValue(
      buildRuntimePlan({
        kind: 'chat',
        namespace: 'chat-aaaaaaaa',
        servicePlan: {
          workspaceRepos: chatSession.workspaceRepos,
          services: undefined,
          selectedServices: [],
        },
        startupMcp: {
          servers: [],
          serializedConfig: serializedMcpConfig,
        },
        credentials: {
          hasGitHubToken: true,
          githubToken: 'sample-gh-token',
        },
      })
    );

    await AgentSessionService.provisionChatRuntime({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      userIdentity: {
        userId: 'user-123',
        githubUsername: 'sample-user',
      } as any,
      githubToken: 'sample-gh-token',
    });

    expect(mockResolveSessionPodServersForRepo).not.toHaveBeenCalled();
    expect(createAgentApiKeySecret).toHaveBeenCalledWith(
      'chat-aaaaaaaa',
      'agent-secret-aaaaaaaa',
      {
        ANTHROPIC_API_KEY: 'sample-anthropic-provider-key',
      },
      'sample-gh-token',
      undefined,
      {},
      {
        LIFECYCLE_SESSION_MCP_CONFIG_JSON: serializedMcpConfig,
        LIFECYCLE_GATEWAY_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/),
      }
    );
  });

  it('preserves build-context repo metadata when chat runtime provisioning fails', async () => {
    const workspaceRepos = [
      {
        repo: 'example-org/example-repo',
        repoUrl: 'https://github.com/example-org/example-repo.git',
        branch: 'feature/sample',
        revision: 'commit-sha-1',
        mountPath: '/workspace',
        primary: true,
      },
    ];
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: 'sample-user',
      sessionKind: 'chat',
      podName: null,
      namespace: null,
      pvcName: null,
      model: 'claude-sonnet-4-6',
      buildKind: null,
      status: 'active',
      chatStatus: 'ready',
      workspaceStatus: 'none',
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      workspaceRepos,
      selectedServices: [],
      skillPlan: { version: 1, skills: [] },
    };
    mockSessionQuery.findOne.mockResolvedValue(chatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession({
      ...chatSession,
      workspaceStatus: AgentWorkspaceStatus.FAILED,
    });
    (createSessionWorkspacePod as jest.Mock).mockRejectedValueOnce(new Error('pod creation failed'));

    await expect(
      AgentSessionService.provisionChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'user-123',
        userIdentity: {
          userId: 'user-123',
          githubUsername: 'sample-user',
        } as any,
        githubToken: 'sample-gh-token',
      })
    ).rejects.toThrow('pod creation failed');

    expect(createSessionWorkspacePod).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRepos,
      })
    );
    expect(mockSessionQuery.patchAndFetchById).toHaveBeenLastCalledWith(
      321,
      expect.objectContaining({
        workspaceStatus: AgentWorkspaceStatus.FAILED,
        namespace: 'chat-aaaaaaaa',
        podName: 'agent-aaaaaaaa',
        pvcName: 'agent-pvc-aaaaaaaa',
      })
    );
    expect(mockSessionQuery.patchAndFetchById).toHaveBeenLastCalledWith(
      321,
      expect.not.objectContaining({
        workspaceRepos: expect.any(Array),
        selectedServices: expect.any(Array),
      })
    );
    expectSandboxFailure({ stage: 'connect_runtime', origin: 'chat_runtime' });
  });

  it('persists chat runtime infrastructure failures with the prepare_infrastructure stage', async () => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: 'sample-user',
      sessionKind: 'chat',
      podName: null,
      namespace: null,
      pvcName: null,
      model: 'claude-sonnet-4-6',
      buildKind: null,
      status: 'active',
      chatStatus: 'ready',
      workspaceStatus: 'none',
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      workspaceRepos: [],
      selectedServices: [],
      skillPlan: { version: 1, skills: [] },
    };
    mockSessionQuery.findOne.mockResolvedValue(chatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession({
      ...chatSession,
      workspaceStatus: AgentWorkspaceStatus.FAILED,
    });
    (createAgentPvc as jest.Mock).mockRejectedValueOnce(new Error('pvc setup failed'));

    await expect(
      AgentSessionService.provisionChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'user-123',
        userIdentity: {
          userId: 'user-123',
          githubUsername: 'sample-user',
        } as any,
        githubToken: 'sample-gh-token',
      })
    ).rejects.toThrow('pvc setup failed');

    expectSandboxFailure({ stage: 'prepare_infrastructure', origin: 'chat_runtime' });
  });

  it('seeds repo-scoped stdio MCP servers when provisioning a build-context chat runtime', async () => {
    const workspaceRepos = [
      {
        repo: 'example-org/example-repo',
        repoUrl: 'https://github.com/example-org/example-repo.git',
        branch: 'feature/sample',
        revision: 'commit-sha-1',
        mountPath: '/workspace',
        primary: true,
      },
    ];
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: 'sample-user',
      sessionKind: 'chat',
      podName: null,
      namespace: null,
      pvcName: null,
      model: 'claude-sonnet-4-6',
      buildKind: null,
      status: 'active',
      chatStatus: 'ready',
      workspaceStatus: 'none',
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      workspaceRepos,
      selectedServices: [],
      skillPlan: { version: 1, skills: [] },
    };
    const readyChatSession = {
      ...chatSession,
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      workspaceStatus: 'ready',
    };
    mockSessionQuery.findOne.mockResolvedValueOnce(chatSession).mockResolvedValueOnce(readyChatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession(readyChatSession);
    mockResolveSessionPodServersForRepo.mockResolvedValueOnce([
      {
        slug: 'sample-stdio',
        name: 'Sample stdio',
        transport: {
          type: 'stdio',
          command: 'sample-mcp',
          args: ['--stdio'],
          env: {
            SAMPLE_TOKEN: 'sample-secret',
          },
        },
        timeout: 30000,
        defaultArgs: {},
        env: {},
        discoveredTools: [],
      },
    ]);

    await AgentSessionService.provisionChatRuntime({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      userIdentity: {
        userId: 'user-123',
        githubUsername: 'sample-user',
      } as any,
      githubToken: 'sample-gh-token',
    });

    expect(mockResolveSessionPodServersForRepo).toHaveBeenCalledWith(
      'example-org/example-repo',
      undefined,
      expect.objectContaining({
        userId: 'user-123',
        githubUsername: 'sample-user',
      })
    );
    expect(createAgentApiKeySecret).toHaveBeenCalledWith(
      'chat-aaaaaaaa',
      'agent-secret-aaaaaaaa',
      {
        ANTHROPIC_API_KEY: 'sample-anthropic-provider-key',
      },
      'sample-gh-token',
      undefined,
      {},
      {
        LIFECYCLE_GATEWAY_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/),
        LIFECYCLE_SESSION_MCP_CONFIG_JSON: JSON.stringify([
          {
            slug: 'sample-stdio',
            name: 'Sample stdio',
            transport: {
              type: 'stdio',
              command: 'sample-mcp',
              args: ['--stdio'],
              env: {
                SAMPLE_TOKEN: 'sample-secret',
              },
            },
            timeout: 30000,
          },
        ]),
      }
    );
  });

  it.each([AgentSessionKind.ENVIRONMENT, AgentSessionKind.SANDBOX])(
    'rejects %s sessions during chat runtime suspension',
    async (sessionKind) => {
      mockSessionQuery.findOne.mockResolvedValueOnce({
        id: 321,
        uuid: 'sample-session-id',
        userId: 'sample-user',
        sessionKind,
        status: 'active',
        workspaceStatus: AgentWorkspaceStatus.READY,
        namespace: 'sample-namespace',
        podName: 'sample-pod',
        pvcName: 'sample-pvc',
      });

      await expect(
        AgentSessionService.suspendChatRuntime({
          sessionId: 'sample-session-id',
          userId: 'sample-user',
        })
      ).rejects.toThrow('Runtime suspension is only supported for chat sessions');

      expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
      expect(deleteSessionWorkspaceService).not.toHaveBeenCalled();
      expect(deleteAgentApiKeySecret).not.toHaveBeenCalled();
    }
  );

  it('blocks chat runtime suspension while an agent run is active', async () => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      sessionKind: AgentSessionKind.CHAT,
      status: 'active',
      workspaceStatus: AgentWorkspaceStatus.READY,
      chatStatus: AgentChatStatus.READY,
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
    };
    mockSessionQuery.findOne.mockResolvedValueOnce(chatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    mockRunQuery.first.mockResolvedValueOnce({
      id: 99,
      uuid: 'run-99',
      status: 'running',
    });

    await expect(
      AgentSessionService.suspendChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'sample-user',
      })
    ).rejects.toBeInstanceOf(WorkspaceActionBlockedError);

    expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
    expect(deleteSessionWorkspaceService).not.toHaveBeenCalled();
    expect(deleteAgentApiKeySecret).not.toHaveBeenCalled();
    expect(mockSessionQuery.patchAndFetchById).not.toHaveBeenCalled();
  });

  it('rejects chat runtime suspension when ready state is missing the pod reference', async () => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      sessionKind: AgentSessionKind.CHAT,
      status: 'active',
      workspaceStatus: AgentWorkspaceStatus.READY,
      chatStatus: AgentChatStatus.READY,
      namespace: 'chat-aaaaaaaa',
      podName: null,
      pvcName: 'agent-pvc-aaaaaaaa',
    };
    mockSessionQuery.findOne.mockResolvedValueOnce(chatSession);

    await expect(
      AgentSessionService.suspendChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'sample-user',
      })
    ).rejects.toThrow('Workspace runtime is not ready');

    expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
    expect(deleteSessionWorkspaceService).not.toHaveBeenCalled();
    expect(deleteAgentApiKeySecret).not.toHaveBeenCalled();
    expect(mockSessionQuery.forUpdate).not.toHaveBeenCalled();
    expect(mockSessionQuery.patchAndFetchById).not.toHaveBeenCalled();
  });

  it('records suspending before deleting resources and clears the action when hibernated', async () => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      sessionKind: AgentSessionKind.CHAT,
      status: 'active',
      workspaceStatus: AgentWorkspaceStatus.READY,
      chatStatus: AgentChatStatus.READY,
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
    };
    const suspendedSession = {
      ...chatSession,
      workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
      podName: null,
    };
    mockSessionQuery.findOne.mockResolvedValueOnce(chatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession(suspendedSession);
    const recordStateSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceState');

    const session = await AgentSessionService.suspendChatRuntime({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
    });

    expect(mockSandboxQuery.insertAndFetch.mock.invocationCallOrder[0]).toBeLessThan(
      (deleteSessionWorkspacePod as jest.Mock).mock.invocationCallOrder[0]
    );
    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        status: 'suspending',
        metadata: expect.objectContaining({
          runtimeLifecycle: expect.objectContaining({
            currentAction: 'suspend',
            claimedAt: expect.any(String),
          }),
        }),
      })
    );
    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        status: 'suspended',
        metadata: expect.not.objectContaining({
          runtimeLifecycle: expect.any(Object),
        }),
      })
    );
    expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(recordStateSpy).toHaveBeenLastCalledWith(
      321,
      expect.objectContaining({
        sandboxStatus: 'suspended',
      }),
      expect.objectContaining({
        expectedLifecycle: {
          action: 'suspend',
          claimedAt: expect.any(String),
        },
      })
    );
    expect(session.workspaceStatus).toBe(AgentWorkspaceStatus.HIBERNATED);
    expect(session.podName).toBeNull();
    recordStateSpy.mockRestore();
  });

  it('persists suspend failures with the suspend stage and origin', async () => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      sessionKind: AgentSessionKind.CHAT,
      status: 'active',
      workspaceStatus: AgentWorkspaceStatus.READY,
      chatStatus: AgentChatStatus.READY,
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
    };
    mockSessionQuery.findOne.mockResolvedValueOnce(chatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession({
      ...chatSession,
      workspaceStatus: AgentWorkspaceStatus.FAILED,
    });
    (deleteSessionWorkspacePod as jest.Mock).mockRejectedValueOnce(new Error('pod delete failed'));
    const recordFailureSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure');

    await expect(
      AgentSessionService.suspendChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'sample-user',
      })
    ).rejects.toThrow('pod delete failed');

    expectSandboxFailure({ stage: 'suspend', origin: 'suspend' });
    expect(mockSessionQuery.patchAndFetchById).toHaveBeenLastCalledWith(
      321,
      expect.objectContaining({
        workspaceStatus: AgentWorkspaceStatus.FAILED,
      })
    );
    expect(recordFailureSpy).toHaveBeenCalledWith(
      321,
      expect.objectContaining({
        failure: expect.objectContaining({
          stage: 'suspend',
          origin: 'suspend',
        }),
      }),
      expect.objectContaining({
        expectedLifecycle: {
          action: 'suspend',
          claimedAt: expect.any(String),
        },
      })
    );
    recordFailureSpy.mockRestore();
  });

  it('nulls podName in the suspend claim before deleting the pod so a crash never leaves READY + a live pod (sr-3)', async () => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      sessionKind: AgentSessionKind.CHAT,
      status: 'active',
      workspaceStatus: AgentWorkspaceStatus.READY,
      chatStatus: AgentChatStatus.READY,
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
    };
    mockSessionQuery.findOne.mockResolvedValueOnce(chatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession({ ...chatSession, workspaceStatus: AgentWorkspaceStatus.HIBERNATED, podName: null });

    await AgentSessionService.suspendChatRuntime({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
    });

    // The claim (first session patch) clears podName before the pod is deleted.
    const claimPatch = mockSessionQuery.patchAndFetchById.mock.calls[0][1] as Record<string, unknown>;
    expect(claimPatch).toMatchObject({ workspaceStatus: AgentWorkspaceStatus.READY, podName: null });
    expect(mockSessionQuery.patchAndFetchById.mock.invocationCallOrder[0]).toBeLessThan(
      (deleteSessionWorkspacePod as jest.Mock).mock.invocationCallOrder[0]
    );
    // The pod is still deleted using the captured original podName.
    expect(deleteSessionWorkspacePod).toHaveBeenCalledWith('chat-aaaaaaaa', 'agent-aaaaaaaa');
  });

  it.each([AgentSessionKind.ENVIRONMENT, AgentSessionKind.SANDBOX])(
    'rejects %s sessions during chat runtime resume provisioning',
    async (sessionKind) => {
      mockSessionQuery.findOne.mockResolvedValueOnce({
        id: 321,
        uuid: 'sample-session-id',
        userId: 'sample-user',
        sessionKind,
        status: 'active',
        workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
        namespace: 'sample-namespace',
        podName: null,
        pvcName: 'sample-pvc',
      });

      await expect(
        AgentSessionService.resumeChatRuntime({
          sessionId: 'sample-session-id',
          userId: 'sample-user',
          userIdentity: {
            userId: 'sample-user',
            githubUsername: 'sample-user',
          } as any,
          githubToken: 'sample-gh-token',
        })
      ).rejects.toThrow('Runtime provisioning is only supported for chat sessions');

      expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
      expect(createAgentPvc).not.toHaveBeenCalled();
      expect(createSessionWorkspacePod).not.toHaveBeenCalled();
    }
  );

  it.each([
    AgentWorkspaceStatus.NONE,
    AgentWorkspaceStatus.PROVISIONING,
    AgentWorkspaceStatus.READY,
    AgentWorkspaceStatus.FAILED,
  ])('rejects %s chat runtime resume before Kubernetes side effects', async (workspaceStatus) => {
    mockSessionQuery.findOne.mockResolvedValueOnce({
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      sessionKind: AgentSessionKind.CHAT,
      status: 'active',
      workspaceStatus,
      chatStatus: AgentChatStatus.READY,
      namespace: workspaceStatus === AgentWorkspaceStatus.READY ? 'chat-aaaaaaaa' : null,
      podName: workspaceStatus === AgentWorkspaceStatus.READY ? 'agent-aaaaaaaa' : null,
      pvcName: workspaceStatus === AgentWorkspaceStatus.READY ? 'agent-pvc-aaaaaaaa' : null,
    });

    await expect(
      AgentSessionService.resumeChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'sample-user',
        userIdentity: {
          userId: 'sample-user',
          githubUsername: 'sample-user',
        } as any,
        githubToken: 'sample-gh-token',
      })
    ).rejects.toThrow('Workspace runtime can only be resumed from hibernated state');

    expect(mockResolveWorkspaceRuntimePlan).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    expect(createAgentPvc).not.toHaveBeenCalled();
    expect(createAgentApiKeySecret).not.toHaveBeenCalled();
    expect(createSessionWorkspaceService).not.toHaveBeenCalled();
    expect(createSessionWorkspacePod).not.toHaveBeenCalled();
    expect(mockRedis.setex).not.toHaveBeenCalled();
    expect(sandboxWritePayloads()).toHaveLength(0);
  });

  it('records hibernated resume as internal resuming while public workspace status is provisioning', async () => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      sessionKind: 'chat',
      podName: null,
      namespace: 'chat-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      model: 'claude-sonnet-4-6',
      buildKind: null,
      status: 'active',
      chatStatus: 'ready',
      workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      workspaceRepos: [],
      selectedServices: [],
      skillPlan: { version: 1, skills: [] },
    };
    const readyChatSession = {
      ...chatSession,
      podName: 'agent-aaaaaaaa',
      workspaceStatus: AgentWorkspaceStatus.READY,
    };
    mockSessionQuery.findOne
      .mockResolvedValueOnce(chatSession)
      .mockResolvedValueOnce(chatSession)
      .mockResolvedValueOnce(readyChatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession(readyChatSession);

    const session = await AgentSessionService.resumeChatRuntime({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      userIdentity: {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      } as any,
      githubToken: 'sample-gh-token',
    });

    expect(mockSessionQuery.patchAndFetchById).toHaveBeenNthCalledWith(
      1,
      321,
      expect.objectContaining({
        workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
      })
    );
    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        status: 'resuming',
        metadata: expect.objectContaining({
          runtimeLifecycle: expect.objectContaining({
            currentAction: 'resume',
            claimedAt: expect.any(String),
          }),
        }),
      })
    );
    expect(session.workspaceStatus).toBe(AgentWorkspaceStatus.READY);
  });

  it('persists resume failures with the resume stage and origin', async () => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      sessionKind: 'chat',
      podName: null,
      namespace: 'chat-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      model: 'claude-sonnet-4-6',
      buildKind: null,
      status: 'active',
      chatStatus: 'ready',
      workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      workspaceRepos: [],
      selectedServices: [],
      skillPlan: { version: 1, skills: [] },
    };
    mockSessionQuery.findOne.mockResolvedValue(chatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession({
      ...chatSession,
      workspaceStatus: AgentWorkspaceStatus.FAILED,
    });
    (createSessionWorkspacePod as jest.Mock).mockRejectedValueOnce(new Error('resume pod failed'));

    await expect(
      AgentSessionService.resumeChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'sample-user',
        userIdentity: {
          userId: 'sample-user',
          githubUsername: 'sample-user',
        } as any,
        githubToken: 'sample-gh-token',
      })
    ).rejects.toThrow('resume pod failed');

    // Resume failures are retryable (sr-2), so assert retryable:true inline.
    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ stage: 'resume', origin: 'resume', retryable: true }),
      })
    );
    // sr-1: a failed resume reuses the persisted PVC + namespace, so neither may be deleted.
    expect(deleteAgentPvc).not.toHaveBeenCalled();
    expect(mockDeleteNamespace).not.toHaveBeenCalled();
  });

  it('records resume failures as retryable so the UI can offer retry (sr-2/NDE-3)', async () => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'sample-user',
      ownerGithubUsername: 'sample-user',
      sessionKind: 'chat',
      podName: null,
      namespace: 'chat-aaaaaaaa',
      pvcName: 'agent-pvc-aaaaaaaa',
      model: 'claude-sonnet-4-6',
      buildKind: null,
      status: 'active',
      chatStatus: 'ready',
      workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      workspaceRepos: [],
      selectedServices: [],
      skillPlan: { version: 1, skills: [] },
    };
    mockSessionQuery.findOne.mockResolvedValue(chatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession({
      ...chatSession,
      workspaceStatus: AgentWorkspaceStatus.FAILED,
    });
    (createSessionWorkspacePod as jest.Mock).mockRejectedValueOnce(new Error('resume pod failed'));

    await expect(
      AgentSessionService.resumeChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'sample-user',
        userIdentity: {
          userId: 'sample-user',
          githubUsername: 'sample-user',
        } as any,
        githubToken: 'sample-gh-token',
      })
    ).rejects.toThrow('resume pod failed');

    expect(sandboxWritePayloads()).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({
          stage: 'resume',
          origin: 'resume',
          retryable: true,
        }),
      })
    );
  });

  it('deletes genuinely-owned fresh resources on a non-resume provision failure', async () => {
    const chatSession = {
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      ownerGithubUsername: 'sample-user',
      sessionKind: 'chat',
      podName: null,
      namespace: null,
      pvcName: null,
      model: 'claude-sonnet-4-6',
      buildKind: null,
      status: 'active',
      chatStatus: 'ready',
      workspaceStatus: 'none',
      devModeSnapshots: {},
      forwardedAgentSecretProviders: [],
      workspaceRepos: [],
      selectedServices: [],
      skillPlan: { version: 1, skills: [] },
    };
    mockSessionQuery.findOne.mockResolvedValue(chatSession);
    mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
    queuePatchedSession(chatSession);
    queuePatchedSession({
      ...chatSession,
      workspaceStatus: AgentWorkspaceStatus.FAILED,
    });
    (createSessionWorkspacePod as jest.Mock).mockRejectedValueOnce(new Error('pod creation failed'));

    await expect(
      AgentSessionService.provisionChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'user-123',
        userIdentity: {
          userId: 'user-123',
          githubUsername: 'sample-user',
        } as any,
        githubToken: 'sample-gh-token',
      })
    ).rejects.toThrow('pod creation failed');

    // Fresh provision owns the PVC/namespace, so a failure must clean them up.
    expect(deleteAgentPvc).toHaveBeenCalledWith('chat-aaaaaaaa', 'agent-pvc-aaaaaaaa');
    expect(mockDeleteNamespace).toHaveBeenCalledWith('chat-aaaaaaaa');
  });

  it('publishes a chat session HTTP port through the workspace gateway preview proxy', async () => {
    mockSessionQuery.findOne.mockResolvedValue({
      id: 321,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      sessionKind: 'chat',
      namespace: 'chat-aaaaaaaa',
      podName: 'agent-aaaaaaaa',
      workspaceStatus: 'ready',
      status: 'active',
    });
    mockSandboxQuery.first.mockResolvedValue({
      id: 654,
      sessionId: 321,
      provider: 'lifecycle_kubernetes',
      status: 'ready',
      providerState: {
        gatewayToken: 'enc:gateway-token',
      },
    });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: {
        cancel: jest.fn().mockResolvedValue(undefined),
      },
    } as any);

    const publication = await AgentSessionService.publishChatHttpPort({
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      userId: 'user-123',
      port: 3000,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://agent-aaaaaaaa.chat-aaaaaaaa.svc.cluster.local:13338/preview/3000',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer gateway-token',
          'x-lifecycle-gateway-token': 'gateway-token',
        },
      })
    );
    expect(mockSandboxExposureQuery.insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: 654,
        kind: 'preview',
        targetPort: 3000,
        status: 'ready',
        url: 'http://3000--abcdef1234567890abcdef1234567890.localhost:5001/',
        metadata: {
          attachmentKind: 'workspace_gateway_preview',
          previewSlug: 'abcdef1234567890abcdef1234567890',
        },
        providerState: {
          url: 'http://agent-aaaaaaaa.chat-aaaaaaaa.svc.cluster.local:13338/preview/3000',
          headers: {
            Authorization: 'Bearer gateway-token',
            'x-lifecycle-gateway-token': 'gateway-token',
          },
        },
        endedAt: null,
      })
    );
    expect(publication).toMatchObject({
      url: 'http://3000--abcdef1234567890abcdef1234567890.localhost:5001/',
      host: '3000--abcdef1234567890abcdef1234567890.localhost:5001',
      path: '/',
      port: 3000,
      upstreamHealth: expect.objectContaining({ status: 'healthy', ok: true }),
    });
    expect(publication).not.toHaveProperty('ingressName');
    expect(publication).not.toHaveProperty('gatewayUrl');
    fetchMock.mockRestore();
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

    it('requires a provider API key to launch the session workspace', async () => {
      (UserApiKeyService.getDecryptedKey as jest.Mock).mockResolvedValue(null);

      await expect(AgentSessionService.createSession(baseOpts)).rejects.toThrow(
        'No API key is configured for provider "anthropic"'
      );
      expect(createAgentPvc).not.toHaveBeenCalled();
      expect(createSessionWorkspacePod).not.toHaveBeenCalled();
    });

    it('persists a terminal environment failure when templated env resolution fails before runtime plan resolution', async () => {
      const recordFailureSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure');
      (Build.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(
        AgentSessionService.createSession({
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
        })
      ).rejects.toThrow('Build not found');

      expect(mockResolveWorkspaceRuntimePlan).not.toHaveBeenCalled();
      expect(mockToWorkspaceRuntimePlanMetadata).not.toHaveBeenCalled();
      expect(mockSessionQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userId: 'user-123',
          ownerGithubUsername: null,
          buildUuid: 'sample-build-123',
          buildKind: BuildKind.ENVIRONMENT,
          sessionKind: AgentSessionKind.ENVIRONMENT,
          podName: null,
          namespace: 'test-ns',
          pvcName: null,
          model: 'unresolved',
          defaultModel: 'unresolved',
          defaultHarness: 'lifecycle_ai_sdk',
          status: 'error',
          chatStatus: AgentChatStatus.ERROR,
          workspaceStatus: AgentWorkspaceStatus.FAILED,
          endedAt: expect.any(String),
          devModeSnapshots: {},
          forwardedAgentSecretProviders: [],
          workspaceRepos: [],
          selectedServices: [],
          skillPlan: { version: 1, skills: [] },
          keepAttachedServicesOnSessionNode: null,
        })
      );
      expect(mockSourceQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 123,
          adapter: 'lifecycle_environment',
          status: 'failed',
        })
      );
      expect(recordFailureSpy).toHaveBeenCalledWith(
        123,
        expect.objectContaining({
          sessionPatch: expect.objectContaining({
            status: 'error',
            chatStatus: AgentChatStatus.ERROR,
            workspaceStatus: AgentWorkspaceStatus.FAILED,
            endedAt: expect.any(String),
          }),
          failure: expect.objectContaining({
            stage: 'create_session',
            origin: 'agent_session',
            retryable: false,
            recordedAt: expect.any(String),
          }),
        }),
        { trx: { trx: true } }
      );
      expect(recordFailureSpy.mock.calls[0][1]).not.toHaveProperty('workspaceStorage');
      expect(recordFailureSpy.mock.calls[0][1]).not.toHaveProperty('runtimePlanMetadata');
      expectSandboxFailure({ stage: 'create_session', origin: 'agent_session' });
      expectNoCreateSessionKubernetesHelpersCalled();
      recordFailureSpy.mockRestore();
    });

    it('persists a terminal sandbox failure when templated env resolution fails before runtime plan resolution', async () => {
      const recordFailureSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure');
      (Build.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(
        AgentSessionService.createSession({
          ...baseOpts,
          buildUuid: 'sandbox-build-uuid',
          buildKind: BuildKind.SANDBOX,
          model: ' sample-model ',
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
        })
      ).rejects.toThrow('Build not found');

      expect(mockResolveWorkspaceRuntimePlan).not.toHaveBeenCalled();
      expect(mockToWorkspaceRuntimePlanMetadata).not.toHaveBeenCalled();
      expect(mockSessionQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          buildUuid: 'sandbox-build-uuid',
          buildKind: BuildKind.SANDBOX,
          sessionKind: AgentSessionKind.SANDBOX,
          podName: null,
          pvcName: null,
          model: 'sample-model',
          defaultModel: 'sample-model',
          status: 'error',
          chatStatus: AgentChatStatus.ERROR,
          workspaceStatus: AgentWorkspaceStatus.FAILED,
          endedAt: expect.any(String),
          selectedServices: [],
        })
      );
      expect(mockSourceQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 123,
          adapter: 'lifecycle_fork',
          status: 'failed',
        })
      );
      expect(recordFailureSpy).toHaveBeenCalledWith(
        123,
        expect.objectContaining({
          sessionPatch: expect.objectContaining({
            status: 'error',
            chatStatus: AgentChatStatus.ERROR,
            workspaceStatus: AgentWorkspaceStatus.FAILED,
            endedAt: expect.any(String),
          }),
          failure: expect.objectContaining({
            stage: 'create_session',
            origin: 'sandbox_launch',
            retryable: false,
            recordedAt: expect.any(String),
          }),
        }),
        { trx: { trx: true } }
      );
      expect(recordFailureSpy.mock.calls[0][1]).not.toHaveProperty('workspaceStorage');
      expect(recordFailureSpy.mock.calls[0][1]).not.toHaveProperty('runtimePlanMetadata');
      expectSandboxFailure({ stage: 'create_session', origin: 'sandbox_launch' });
      expectNoCreateSessionKubernetesHelpersCalled();
      recordFailureSpy.mockRestore();
    });

    it('persists a terminal environment failure when workspace runtime plan resolution fails', async () => {
      const recordFailureSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure');
      mockResolveWorkspaceRuntimePlan.mockRejectedValueOnce(new Error('plan failed'));

      await expect(AgentSessionService.createSession(baseOpts)).rejects.toThrow('plan failed');

      expect(mockResolveWorkspaceRuntimePlan).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'environment',
          sessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          namespace: 'test-ns',
          userId: 'user-123',
        })
      );
      expect(mockSessionQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userId: 'user-123',
          ownerGithubUsername: null,
          buildUuid: null,
          buildKind: BuildKind.ENVIRONMENT,
          sessionKind: AgentSessionKind.ENVIRONMENT,
          podName: null,
          namespace: 'test-ns',
          pvcName: null,
          model: 'unresolved',
          defaultModel: 'unresolved',
          defaultHarness: 'lifecycle_ai_sdk',
          status: 'error',
          chatStatus: AgentChatStatus.ERROR,
          workspaceStatus: AgentWorkspaceStatus.FAILED,
          endedAt: expect.any(String),
          devModeSnapshots: {},
          forwardedAgentSecretProviders: [],
          workspaceRepos: [],
          selectedServices: [],
          skillPlan: { version: 1, skills: [] },
          keepAttachedServicesOnSessionNode: null,
        })
      );
      expect(mockSourceQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 123,
          adapter: 'lifecycle_environment',
          status: 'failed',
          input: expect.objectContaining({
            buildUuid: null,
            buildKind: BuildKind.ENVIRONMENT,
            sessionKind: AgentSessionKind.ENVIRONMENT,
            defaults: {
              provider: null,
              model: 'unresolved',
            },
          }),
        })
      );
      expect(recordFailureSpy).toHaveBeenCalledWith(
        123,
        expect.objectContaining({
          sessionPatch: expect.objectContaining({
            status: 'error',
            chatStatus: AgentChatStatus.ERROR,
            workspaceStatus: AgentWorkspaceStatus.FAILED,
            endedAt: expect.any(String),
          }),
          failure: expect.objectContaining({
            stage: 'create_session',
            origin: 'agent_session',
            retryable: false,
            recordedAt: expect.any(String),
          }),
        }),
        { trx: { trx: true } }
      );
      expect(recordFailureSpy.mock.calls[0][1]).not.toHaveProperty('workspaceStorage');
      expect(recordFailureSpy.mock.calls[0][1]).not.toHaveProperty('runtimePlanMetadata');
      expectSandboxFailure({ stage: 'create_session', origin: 'agent_session' });
      expectNoCreateSessionKubernetesHelpersCalled();
      recordFailureSpy.mockRestore();
    });

    it('persists a terminal sandbox failure when workspace runtime plan resolution fails', async () => {
      const recordFailureSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure');
      mockResolveWorkspaceRuntimePlan.mockRejectedValueOnce(new Error('sandbox plan failed'));

      await expect(
        AgentSessionService.createSession({
          ...baseOpts,
          buildUuid: 'sandbox-build-uuid',
          buildKind: BuildKind.SANDBOX,
          model: ' sample-model ',
        })
      ).rejects.toThrow('sandbox plan failed');

      expect(mockResolveWorkspaceRuntimePlan).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'sandbox',
          sessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          namespace: 'test-ns',
          userId: 'user-123',
          buildUuid: 'sandbox-build-uuid',
        })
      );
      expect(mockSessionQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          buildUuid: 'sandbox-build-uuid',
          buildKind: BuildKind.SANDBOX,
          sessionKind: AgentSessionKind.SANDBOX,
          podName: null,
          pvcName: null,
          model: 'sample-model',
          defaultModel: 'sample-model',
          status: 'error',
          chatStatus: AgentChatStatus.ERROR,
          workspaceStatus: AgentWorkspaceStatus.FAILED,
          endedAt: expect.any(String),
          selectedServices: [],
        })
      );
      expect(mockSourceQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 123,
          adapter: 'lifecycle_fork',
          status: 'failed',
          input: expect.objectContaining({
            buildUuid: 'sandbox-build-uuid',
            buildKind: BuildKind.SANDBOX,
            sessionKind: AgentSessionKind.SANDBOX,
            defaults: {
              provider: null,
              model: 'sample-model',
            },
          }),
        })
      );
      expect(recordFailureSpy).toHaveBeenCalledWith(
        123,
        expect.objectContaining({
          sessionPatch: expect.objectContaining({
            status: 'error',
            chatStatus: AgentChatStatus.ERROR,
            workspaceStatus: AgentWorkspaceStatus.FAILED,
            endedAt: expect.any(String),
          }),
          failure: expect.objectContaining({
            stage: 'create_session',
            origin: 'sandbox_launch',
            retryable: false,
            recordedAt: expect.any(String),
          }),
        }),
        { trx: { trx: true } }
      );
      expect(recordFailureSpy.mock.calls[0][1]).not.toHaveProperty('workspaceStorage');
      expect(recordFailureSpy.mock.calls[0][1]).not.toHaveProperty('runtimePlanMetadata');
      expectSandboxFailure({ stage: 'create_session', origin: 'sandbox_launch' });
      expectNoCreateSessionKubernetesHelpersCalled();
      recordFailureSpy.mockRestore();
    });

    it('uses the canonical failure writer when startup fails before session persistence completes', async () => {
      const runtimePlan = buildRuntimePlan();
      const runtimePlanMetadata = actualWorkspaceRuntimePlan.toWorkspaceRuntimePlanMetadata(runtimePlan);
      const recordFailureSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure');
      mockResolveWorkspaceRuntimePlan.mockResolvedValueOnce(runtimePlan);
      mockSourceQuery.insertAndFetch.mockRejectedValueOnce(new Error('source write failed'));

      await expect(AgentSessionService.createSession(baseOpts)).rejects.toThrow('source write failed');

      expect(mockSessionQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          chatStatus: AgentChatStatus.ERROR,
          workspaceStatus: AgentWorkspaceStatus.FAILED,
          podName: 'agent-aaaaaaaa',
          pvcName: 'agent-pvc-aaaaaaaa',
          model: 'claude-sonnet-4-6',
          defaultModel: 'claude-sonnet-4-6',
          workspaceRepos: runtimePlan.servicePlan.workspaceRepos,
          selectedServices: runtimePlan.servicePlan.selectedServices,
          skillPlan: runtimePlan.skillPlan,
        })
      );
      expect(mockSourceQuery.insertAndFetch).toHaveBeenCalledTimes(2);
      expect(recordFailureSpy).toHaveBeenCalledWith(
        123,
        expect.objectContaining({
          sessionPatch: expect.objectContaining({
            status: 'error',
            chatStatus: AgentChatStatus.ERROR,
            workspaceStatus: AgentWorkspaceStatus.FAILED,
            endedAt: expect.any(String),
          }),
          workspaceStorage: runtimePlan.workspaceStorage,
          failure: expect.objectContaining({
            stage: 'create_session',
            origin: 'agent_session',
            retryable: false,
          }),
          runtimePlanMetadata,
        }),
        { trx: { trx: true } }
      );
      expectSandboxFailure({ stage: 'create_session', origin: 'agent_session' });
      recordFailureSpy.mockRestore();
    });

    it('creates PVC, pod, network policy, and session record', async () => {
      const session = await AgentSessionService.createSession(baseOpts);

      expect(createAgentPvc).toHaveBeenCalledWith('test-ns', 'agent-pvc-aaaaaaaa', '10Gi', undefined, 'ReadWriteOnce');
      expect(ensureAgentSessionServiceAccount).toHaveBeenCalledWith('test-ns');
      expect(createAgentApiKeySecret).toHaveBeenCalledWith(
        'test-ns',
        'agent-secret-aaaaaaaa',
        {
          ANTHROPIC_API_KEY: 'sample-anthropic-provider-key',
        },
        undefined,
        undefined,
        {},
        {
          LIFECYCLE_SESSION_MCP_CONFIG_JSON: '[]',
          LIFECYCLE_GATEWAY_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/),
        }
      );
      expect(createSessionWorkspacePod).toHaveBeenCalledWith(
        expect.objectContaining({
          podName: 'agent-aaaaaaaa',
          namespace: 'test-ns',
          pvcName: 'agent-pvc-aaaaaaaa',
          workspaceImage: 'lifecycle-agent:latest',
          workspaceEditorImage: 'codercom/code-server:4.98.2',
          apiKeySecretName: 'agent-secret-aaaaaaaa',
          serviceAccountName: 'agent-sa',
          hasGitHubToken: false,
        })
      );
      expect(createSessionWorkspaceService).toHaveBeenCalledWith('test-ns', 'agent-aaaaaaaa', undefined);
      expect(AgentSession.transaction).toHaveBeenCalledTimes(2);
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
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        123,
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

    it('records createSession initial and ready workspace states through the paired writer', async () => {
      const runtimePlan = buildRuntimePlan({
        prewarm: {
          compatiblePrewarm: {
            uuid: 'prewarm-1',
            pvcName: 'prewarm-pvc',
          },
          pvcName: 'prewarm-pvc',
          skipWorkspaceBootstrap: true,
          ownsPvc: false,
        },
      });
      const runtimePlanMetadata = actualWorkspaceRuntimePlan.toWorkspaceRuntimePlanMetadata(runtimePlan);
      mockResolveWorkspaceRuntimePlan.mockResolvedValueOnce(runtimePlan);
      const recordStateSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceState');

      await AgentSessionService.createSession(baseOpts);

      const provisioningWrite = recordStateSpy.mock.calls.find(([, state]) => state.sandboxStatus === 'provisioning');
      const readyWrite = recordStateSpy.mock.calls.find(([, state]) => state.sandboxStatus === 'ready');

      expect(provisioningWrite).toEqual([
        123,
        expect.objectContaining({
          sessionPatch: {
            workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
          },
          sandboxStatus: 'provisioning',
          workspaceStorage: runtimePlan.workspaceStorage,
          runtimePlanMetadata,
          runtimeLifecycle: {
            currentAction: 'provision',
            claimedAt: expect.any(String),
          },
        }),
        { trx: { trx: true } },
      ]);
      expect(readyWrite).toEqual([
        123,
        expect.objectContaining({
          sessionPatch: {
            status: 'active',
            chatStatus: AgentChatStatus.READY,
            workspaceStatus: AgentWorkspaceStatus.READY,
          },
          sandboxStatus: 'ready',
          workspaceStorage: runtimePlan.workspaceStorage,
          runtimePlanMetadata,
          runtimeLifecycle: null,
        }),
        expect.objectContaining({
          expectedLifecycle: {
            action: 'provision',
            claimedAt: expect.any(String),
          },
        }),
      ]);
      expect(mockSessionQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
        })
      );
      expect(createAgentPvc).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();

      recordStateSpy.mockRestore();
    });

    it('uses resolved prewarm PVC ownership for pod creation and rollback', async () => {
      const runtimePlan = buildRuntimePlan({
        prewarm: {
          compatiblePrewarm: {
            uuid: 'prewarm-1',
            pvcName: 'prewarm-pvc',
          },
          pvcName: 'prewarm-pvc',
          skipWorkspaceBootstrap: true,
          ownsPvc: false,
        },
      });
      mockResolveWorkspaceRuntimePlan.mockResolvedValueOnce(runtimePlan);
      (createSessionWorkspacePod as jest.Mock).mockRejectedValueOnce(new Error('pod creation failed'));

      await expect(AgentSessionService.createSession(baseOpts)).rejects.toThrow('pod creation failed');

      expect(createAgentPvc).not.toHaveBeenCalled();
      expect(createSessionWorkspacePod).toHaveBeenCalledWith(
        expect.objectContaining({
          pvcName: 'prewarm-pvc',
          skipWorkspaceBootstrap: true,
        })
      );
      expect(deleteAgentPvc).not.toHaveBeenCalled();
      expect(mockToWorkspaceRuntimePlanMetadata).toHaveBeenCalledWith(runtimePlan);
    });

    it('uses resolved storage override ownership for fresh PVC creation', async () => {
      const runtimePlan = buildRuntimePlan({
        workspaceStorage: {
          requestedSize: '20Gi',
          storageSize: '20Gi',
          accessMode: 'ReadWriteOnce',
        },
        prewarm: {
          compatiblePrewarm: null,
          pvcName: 'agent-pvc-custom',
          skipWorkspaceBootstrap: false,
          ownsPvc: true,
        },
      });
      mockResolveWorkspaceRuntimePlan.mockResolvedValueOnce(runtimePlan);

      await AgentSessionService.createSession({
        ...baseOpts,
        workspaceStorageSize: '20Gi',
      } as CreateSessionOptions & { workspaceStorageSize: string });

      expect(mockResolveWorkspaceRuntimePlan).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceStorageSize: '20Gi',
        })
      );
      expect(createAgentPvc).toHaveBeenCalledWith('test-ns', 'agent-pvc-custom', '20Gi', undefined, 'ReadWriteOnce');
      expect(createSessionWorkspacePod).toHaveBeenCalledWith(
        expect.objectContaining({
          pvcName: 'agent-pvc-custom',
          skipWorkspaceBootstrap: false,
        })
      );
    });

    it('applies forwarded-env ExternalSecrets after plan resolution and before pod creation', async () => {
      const runtimePlan = buildRuntimePlan({
        forwardedEnv: {
          env: {
            PLAIN_TOKEN: 'plain-token',
            SECRET_TOKEN: '{{aws:sample/path:value}}',
          },
          secretRefs: [
            {
              envKey: 'SECRET_TOKEN',
              provider: 'aws',
              path: 'sample/path',
              key: 'value',
            },
          ],
          secretProviders: ['aws'],
          secretServiceName: 'agent-env-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        },
      });
      mockResolveWorkspaceRuntimePlan.mockImplementationOnce(async () => {
        expect(applyForwardedAgentEnvSecrets).not.toHaveBeenCalled();
        return runtimePlan;
      });
      (applyForwardedAgentEnvSecrets as jest.Mock).mockResolvedValueOnce(runtimePlan.forwardedEnv);

      await AgentSessionService.createSession(baseOpts);

      expect(applyForwardedAgentEnvSecrets).toHaveBeenCalledWith({
        plan: runtimePlan.forwardedEnv,
        namespace: 'test-ns',
        buildUuid: undefined,
      });
      expect(mockResolveWorkspaceRuntimePlan.mock.invocationCallOrder[0]).toBeLessThan(
        (applyForwardedAgentEnvSecrets as jest.Mock).mock.invocationCallOrder[0]
      );
      expect((applyForwardedAgentEnvSecrets as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
        (createSessionWorkspacePod as jest.Mock).mock.invocationCallOrder[0]
      );
      expect(createAgentApiKeySecret).toHaveBeenCalledWith(
        'test-ns',
        'agent-secret-aaaaaaaa',
        {
          ANTHROPIC_API_KEY: 'sample-anthropic-provider-key',
        },
        undefined,
        undefined,
        {
          PLAIN_TOKEN: 'plain-token',
        },
        {
          LIFECYCLE_SESSION_MCP_CONFIG_JSON: '[]',
          LIFECYCLE_GATEWAY_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/),
        }
      );
    });

    it('does not block session readiness on default thread creation', async () => {
      const defaultThread = createDeferred<{ uuid: string }>();
      mockGetDefaultThreadForSession.mockImplementationOnce(() => defaultThread.promise);

      const sessionPromise = AgentSessionService.createSession(baseOpts);
      const result = await Promise.race([
        sessionPromise.then(() => 'resolved'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 20)),
      ]);

      expect(result).toBe('resolved');
      expect(mockGetDefaultThreadForSession).toHaveBeenCalledWith('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'user-123');

      defaultThread.resolve({ uuid: 'default-thread-1' });
      await sessionPromise;
    });

    it('reuses a compatible ready prewarm PVC and skips workspace bootstrap', async () => {
      mockGetCompatibleReadyPrewarm.mockResolvedValue({
        uuid: 'prewarm-1',
        pvcName: 'agent-prewarm-pvc-1234',
        services: ['web'],
        status: 'ready',
      });

      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        buildUuid: 'build-123',
        services: [{ name: 'web', deployId: 1, devConfig: { image: 'node:20', command: 'pnpm dev' } }],
      };

      await AgentSessionService.createSession(optsWithServices);

      expect(mockGetCompatibleReadyPrewarm).toHaveBeenCalledWith(
        expect.objectContaining({
          buildUuid: 'build-123',
          requestedServices: ['web'],
          revision: undefined,
          workspaceRepos: [
            expect.objectContaining({
              repo: 'example-org/example-repo',
              branch: 'feature/example-session',
              mountPath: '/workspace',
              primary: true,
            }),
          ],
          requestedServiceRefs: [
            expect.objectContaining({
              name: 'web',
              deployId: 1,
              repo: 'example-org/example-repo',
              branch: 'feature/example-session',
              workspacePath: '/workspace',
            }),
          ],
        })
      );
      expect(createAgentPvc).not.toHaveBeenCalled();
      expect(createSessionWorkspacePod).not.toHaveBeenCalled();
      expect(createSessionWorkspacePodWithoutWaiting).toHaveBeenCalledWith(
        expect.objectContaining({
          pvcName: 'agent-prewarm-pvc-1234',
          skipWorkspaceBootstrap: true,
        })
      );
      expect(waitForSessionWorkspacePodScheduled).toHaveBeenCalledWith('test-ns', 'agent-build-123', undefined);
      expect(waitForSessionWorkspacePodReady).toHaveBeenCalledWith('test-ns', 'agent-build-123', undefined);
      expect(mockSessionQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          pvcName: 'agent-prewarm-pvc-1234',
        })
      );
    });

    it('falls back to the cold path when no compatible prewarm is available', async () => {
      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        buildUuid: 'build-123',
        services: [{ name: 'api', deployId: 2, devConfig: { image: 'node:20', command: 'pnpm dev' } }],
      };

      await AgentSessionService.createSession(optsWithServices);

      expect(mockGetCompatibleReadyPrewarm).toHaveBeenCalledWith(
        expect.objectContaining({
          buildUuid: 'build-123',
          requestedServices: ['api'],
          revision: undefined,
          workspaceRepos: [
            expect.objectContaining({
              repo: 'example-org/example-repo',
              branch: 'feature/example-session',
              mountPath: '/workspace',
              primary: true,
            }),
          ],
          requestedServiceRefs: [
            expect.objectContaining({
              name: 'api',
              deployId: 2,
              repo: 'example-org/example-repo',
              branch: 'feature/example-session',
              workspacePath: '/workspace',
            }),
          ],
        })
      );
      expect(createAgentPvc).toHaveBeenCalledWith(
        'test-ns',
        'agent-pvc-aaaaaaaa',
        '10Gi',
        'build-123',
        'ReadWriteOnce'
      );
      expect(createSessionWorkspacePod).toHaveBeenCalledWith(
        expect.objectContaining({
          podName: 'agent-build-123',
          pvcName: 'agent-pvc-aaaaaaaa',
          skipWorkspaceBootstrap: false,
        })
      );
    });

    it('reuses a compatible multi-repo prewarm when workspace layout matches', async () => {
      mockGetCompatibleReadyPrewarm.mockResolvedValue({
        uuid: 'prewarm-2',
        pvcName: 'agent-prewarm-pvc-5678',
        services: ['api', 'web'],
        status: 'ready',
      });

      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        buildUuid: 'build-123',
        services: [
          {
            name: 'web',
            deployId: 1,
            devConfig: { image: 'node:20', command: 'pnpm dev' },
          },
          {
            name: 'api',
            deployId: 2,
            devConfig: { image: 'node:20', command: 'pnpm dev' },
            repo: 'org/api',
            branch: 'feature/api',
            revision: 'sha-api',
          },
        ],
      };

      await AgentSessionService.createSession(optsWithServices);

      expect(mockGetCompatibleReadyPrewarm).toHaveBeenCalledWith(
        expect.objectContaining({
          buildUuid: 'build-123',
          requestedServices: ['web', 'api'],
          workspaceRepos: expect.arrayContaining([
            expect.objectContaining({
              repo: 'example-org/example-repo',
              branch: 'feature/example-session',
              mountPath: '/workspace/repos/example-org/example-repo',
              primary: true,
            }),
            expect.objectContaining({
              repo: 'org/api',
              branch: 'feature/api',
              revision: 'sha-api',
              mountPath: '/workspace/repos/org/api',
              primary: false,
            }),
          ]),
          requestedServiceRefs: expect.arrayContaining([
            expect.objectContaining({
              name: 'web',
              deployId: 1,
              repo: 'example-org/example-repo',
              branch: 'feature/example-session',
              workspacePath: '/workspace/repos/example-org/example-repo',
            }),
            expect.objectContaining({
              name: 'api',
              deployId: 2,
              repo: 'org/api',
              branch: 'feature/api',
              workspacePath: '/workspace/repos/org/api',
            }),
          ]),
        })
      );
      expect(createAgentPvc).not.toHaveBeenCalled();
      expect(createSessionWorkspacePod).not.toHaveBeenCalled();
      expect(createSessionWorkspacePodWithoutWaiting).toHaveBeenCalledWith(
        expect.objectContaining({
          pvcName: 'agent-prewarm-pvc-5678',
          skipWorkspaceBootstrap: true,
          workspaceRepos: expect.arrayContaining([
            expect.objectContaining({
              repo: 'example-org/example-repo',
              mountPath: '/workspace/repos/example-org/example-repo',
            }),
            expect.objectContaining({ repo: 'org/api', mountPath: '/workspace/repos/org/api' }),
          ]),
        })
      );
      expect(waitForSessionWorkspacePodScheduled).toHaveBeenCalledWith('test-ns', 'agent-build-123', undefined);
      expect(waitForSessionWorkspacePodReady).toHaveBeenCalledWith('test-ns', 'agent-build-123', undefined);
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

      expect(createSessionWorkspacePod).toHaveBeenCalledWith(
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

      expect(createSessionWorkspacePod).toHaveBeenCalledWith(
        expect.objectContaining({
          readiness: optsWithReadiness.readiness,
        })
      );
    });

    it('passes forwarded service env through to the agent pod when configured', async () => {
      const forwardedEnvPlan = {
        env: { PRIVATE_REGISTRY_TOKEN: 'plain-token' },
        secretRefs: [],
        secretProviders: [],
        secretServiceName: 'agent-env-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      };
      (planForwardedAgentEnv as jest.Mock).mockResolvedValue(forwardedEnvPlan);
      (applyForwardedAgentEnvSecrets as jest.Mock).mockResolvedValue(forwardedEnvPlan);
      (resolveForwardedAgentEnv as jest.Mock).mockResolvedValue(forwardedEnvPlan);

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
        {
          ANTHROPIC_API_KEY: 'sample-anthropic-provider-key',
        },
        undefined,
        undefined,
        {
          PRIVATE_REGISTRY_TOKEN: 'plain-token',
        },
        {
          LIFECYCLE_SESSION_MCP_CONFIG_JSON: '[]',
          LIFECYCLE_GATEWAY_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/),
        }
      );
      expect(createSessionWorkspacePod).toHaveBeenCalledWith(
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
      expect(createSessionWorkspacePod).toHaveBeenCalledWith(
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
        githubToken: 'sample-github-token',
      };

      await AgentSessionService.createSession(optsWithGitHubToken);

      expect(createAgentApiKeySecret).toHaveBeenCalledWith(
        'test-ns',
        'agent-secret-aaaaaaaa',
        {
          ANTHROPIC_API_KEY: 'sample-anthropic-provider-key',
        },
        'sample-github-token',
        undefined,
        {},
        {
          LIFECYCLE_SESSION_MCP_CONFIG_JSON: '[]',
          LIFECYCLE_GATEWAY_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/),
        }
      );
      expect(createSessionWorkspacePod).toHaveBeenCalledWith(
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

      expect(mockSessionQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          keepAttachedServicesOnSessionNode: true,
        })
      );
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

    it('starts dev mode for multiple services in parallel during session creation', async () => {
      const webEnable = createDeferred<ReturnType<typeof buildDevModeSnapshot>>();
      const apiEnable = createDeferred<ReturnType<typeof buildDevModeSnapshot>>();
      mockEnableDevMode.mockImplementationOnce(() => webEnable.promise).mockImplementationOnce(() => apiEnable.promise);

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

      const createPromise = AgentSessionService.createSession(optsWithServices);
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockEnableDevMode).toHaveBeenCalledTimes(2);
      expect(mockSessionQuery.patch).not.toHaveBeenCalled();

      webEnable.resolve(buildDevModeSnapshot('web-build-uuid'));
      apiEnable.resolve(buildDevModeSnapshot('api-build-uuid'));

      await expect(createPromise).resolves.toEqual(expect.objectContaining({ status: 'active' }));
    });

    it('starts attached services after scheduling but before the agent pod is ready for prewarmed same-node sessions', async () => {
      const scheduled = createDeferred<{ spec: { nodeName: string } }>();
      const ready = createDeferred<{ spec: { nodeName: string } }>();

      mockGetCompatibleReadyPrewarm.mockResolvedValue({
        uuid: 'prewarm-1',
        pvcName: 'agent-prewarm-pvc-1234',
        services: ['web'],
        status: 'ready',
      });
      (waitForSessionWorkspacePodScheduled as jest.Mock).mockImplementationOnce(() => scheduled.promise);
      (waitForSessionWorkspacePodReady as jest.Mock).mockImplementationOnce(() => ready.promise);

      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        buildUuid: 'build-123',
        services: [
          {
            name: 'web',
            deployId: 1,
            resourceName: 'web-build-uuid',
            devConfig: { image: 'node:20', command: 'pnpm dev' },
          },
        ],
      };

      const createPromise = AgentSessionService.createSession(optsWithServices);
      await new Promise((resolve) => setImmediate(resolve));

      expect(createSessionWorkspacePodWithoutWaiting).toHaveBeenCalled();
      expect(mockEnableDevMode).not.toHaveBeenCalled();

      scheduled.resolve({ spec: { nodeName: 'agent-node-a' } });
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockEnableDevMode).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentName: 'web-build-uuid',
          requiredNodeName: 'agent-node-a',
        })
      );
      expect(mockSessionQuery.patch).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));

      ready.resolve({ spec: { nodeName: 'agent-node-a' } });

      await expect(createPromise).resolves.toEqual(expect.objectContaining({ status: 'active' }));
    });

    it('starts attached services immediately for prewarmed sessions when same-node placement is disabled', async () => {
      const ready = createDeferred<{ spec: { nodeName: string } }>();

      mockGetCompatibleReadyPrewarm.mockResolvedValue({
        uuid: 'prewarm-1',
        pvcName: 'agent-prewarm-pvc-1234',
        services: ['web'],
        status: 'ready',
      });
      (waitForSessionWorkspacePodReady as jest.Mock).mockImplementationOnce(() => ready.promise);

      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        buildUuid: 'build-123',
        keepAttachedServicesOnSessionNode: false,
        services: [
          {
            name: 'web',
            deployId: 1,
            resourceName: 'web-build-uuid',
            devConfig: { image: 'node:20', command: 'pnpm dev' },
          },
        ],
      };

      const createPromise = AgentSessionService.createSession(optsWithServices);
      await new Promise((resolve) => setImmediate(resolve));

      expect(createSessionWorkspacePodWithoutWaiting).toHaveBeenCalled();
      expect(waitForSessionWorkspacePodScheduled).not.toHaveBeenCalled();
      expect(mockEnableDevMode).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentName: 'web-build-uuid',
          requiredNodeName: undefined,
        })
      );
      expect(mockSessionQuery.patch).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));

      ready.resolve({ spec: { nodeName: 'agent-node-a' } });

      await expect(createPromise).resolves.toEqual(expect.objectContaining({ status: 'active' }));
    });

    it('does not pin services to the session node when same-node placement is disabled', async () => {
      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        keepAttachedServicesOnSessionNode: false,
        services: [
          {
            name: 'web',
            deployId: 1,
            resourceName: 'web-build-uuid',
            devConfig: { image: 'node:20', command: 'pnpm dev' },
          },
        ],
      };

      await AgentSessionService.createSession(optsWithServices);

      expect(mockSessionQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          keepAttachedServicesOnSessionNode: false,
        })
      );
      expect(mockEnableDevMode).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentName: 'web-build-uuid',
          requiredNodeName: undefined,
        })
      );
    });

    it('persists attach-service failures under the attach_services startup stage', async () => {
      mockGetCompatibleReadyPrewarm.mockResolvedValue({
        uuid: 'prewarm-1',
        pvcName: 'agent-prewarm-pvc-1234',
        services: ['web'],
        status: 'ready',
      });
      mockEnableDevMode.mockRejectedValueOnce(new Error('service attach failed'));

      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        buildUuid: 'build-123',
        keepAttachedServicesOnSessionNode: false,
        services: [
          {
            name: 'web',
            deployId: 1,
            resourceName: 'web-build-uuid',
            devConfig: { image: 'node:20', command: 'pnpm dev' },
          },
        ],
      };

      await expect(AgentSessionService.createSession(optsWithServices)).rejects.toThrow('service attach failed');

      const startupFailurePayload = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(startupFailurePayload.stage).toBe('attach_services');
      expect(startupFailurePayload.title).toBe('Attached services failed to start');
      expect(startupFailurePayload).toEqual(
        expect.objectContaining({
          message: 'service attach failed',
          retryable: false,
          origin: 'agent_session',
        })
      );
      expectSandboxFailure({
        stage: 'attach_services',
        origin: 'agent_session',
        title: 'Attached services failed to start',
        message: 'service attach failed',
      });
      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({
          status: 'failed',
          error: expect.objectContaining({
            stage: 'attach_services',
            title: 'Attached services failed to start',
            message: 'service attach failed',
            retryable: false,
            origin: 'agent_session',
          }),
        })
      );
    });

    it('restores successful sibling services when one parallel dev-mode enable fails', async () => {
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

      mockEnableDevMode
        .mockResolvedValueOnce(buildDevModeSnapshot('web-build-uuid'))
        .mockRejectedValueOnce(new Error('api dev mode failed'));

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

      await expect(AgentSessionService.createSession(optsWithServices)).rejects.toThrow('api dev mode failed');

      expect(DeploymentManager).toHaveBeenCalledWith(revertDeploys);
      expect(deployManagerDeploy).toHaveBeenCalled();
      expect(mockDisableDevMode).toHaveBeenCalledTimes(2);
      expect(mockDisableDevMode).toHaveBeenNthCalledWith(
        1,
        'test-ns',
        'deploy-1',
        'deploy-1',
        buildDevModeSnapshot('web-build-uuid')
      );
      expect(mockDisableDevMode).toHaveBeenNthCalledWith(
        2,
        'test-ns',
        'deploy-1',
        'deploy-1',
        buildDevModeSnapshot('web-build-uuid')
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

      expect(createSessionWorkspacePod).toHaveBeenCalledWith(
        expect.objectContaining({
          installCommand: 'cd /workspace/web && pnpm install\n\ncd /workspace/api && pnpm install',
        })
      );
    });

    it('rewrites dev-mode workspace paths when selected services span multiple repositories', async () => {
      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        repoUrl: 'https://github.com/example-org/ui-service.git',
        branch: 'feature/ui-service',
        services: [
          {
            name: 'web',
            deployId: 1,
            resourceName: 'web-build-uuid',
            repo: 'example-org/ui-service',
            branch: 'feature/ui-service',
            devConfig: {
              image: 'node:20',
              command: 'pnpm dev',
              workDir: 'apps/web',
              installCommand: 'pnpm install',
            },
          },
          {
            name: 'api',
            deployId: 2,
            resourceName: 'api-build-uuid',
            repo: 'example-org/api-service',
            branch: 'feature/api-service',
            devConfig: {
              image: 'node:20',
              command: 'pnpm start',
              workDir: 'services/api',
              installCommand: 'pnpm install',
            },
          },
        ],
      };

      await AgentSessionService.createSession(optsWithServices);

      expect(createSessionWorkspacePod).toHaveBeenCalledWith(
        expect.objectContaining({
          repoUrl: 'https://github.com/example-org/ui-service.git',
          branch: 'feature/ui-service',
          workspaceRepos: [
            expect.objectContaining({
              repo: 'example-org/ui-service',
              branch: 'feature/ui-service',
              mountPath: '/workspace/repos/example-org/ui-service',
              primary: true,
            }),
            expect.objectContaining({
              repo: 'example-org/api-service',
              branch: 'feature/api-service',
              mountPath: '/workspace/repos/example-org/api-service',
              primary: false,
            }),
          ],
          installCommand:
            'cd "/workspace/repos/example-org/ui-service"\npnpm install\n\ncd "/workspace/repos/example-org/api-service"\npnpm install',
        })
      );
      expect(mockEnableDevMode).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          devConfig: expect.objectContaining({
            workDir: '/workspace/repos/example-org/ui-service/apps/web',
          }),
        })
      );
      expect(mockEnableDevMode).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          devConfig: expect.objectContaining({
            workDir: '/workspace/repos/example-org/api-service/services/api',
          }),
        })
      );
      expect(mockSessionQuery.insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceRepos: [
            expect.objectContaining({ repo: 'example-org/ui-service', primary: true }),
            expect.objectContaining({ repo: 'example-org/api-service', primary: false }),
          ],
          selectedServices: [
            expect.objectContaining({
              name: 'web',
              repo: 'example-org/ui-service',
              branch: 'feature/ui-service',
              workspacePath: '/workspace/repos/example-org/ui-service',
              workDir: '/workspace/repos/example-org/ui-service/apps/web',
            }),
            expect.objectContaining({
              name: 'api',
              repo: 'example-org/api-service',
              branch: 'feature/api-service',
              workspacePath: '/workspace/repos/example-org/api-service',
              workDir: '/workspace/repos/example-org/api-service/services/api',
            }),
          ],
        })
      );
      expect(mockGetCompatibleReadyPrewarm).not.toHaveBeenCalled();
    });

    it('rolls back on pod creation failure', async () => {
      const recordFailureSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure');
      (createSessionWorkspacePod as jest.Mock).mockRejectedValue(new Error('pod creation failed'));

      await expect(AgentSessionService.createSession(baseOpts)).rejects.toThrow('pod creation failed');

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'lifecycle:agent:session:startup-failure:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        3600,
        expect.any(String)
      );
      expect(deleteSessionWorkspaceService).toHaveBeenCalledWith('test-ns', 'agent-aaaaaaaa');
      expect(deleteSessionWorkspacePod).toHaveBeenCalledWith('test-ns', 'agent-aaaaaaaa');
      expect(deleteAgentPvc).toHaveBeenCalledWith('test-ns', 'agent-pvc-aaaaaaaa');
      expect(deleteAgentApiKeySecret).toHaveBeenCalledWith('test-ns', 'agent-secret-aaaaaaaa');
      expect(cleanupForwardedAgentEnvSecrets).toHaveBeenCalledWith(
        'test-ns',
        'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        []
      );
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        123,
        expect.objectContaining({ status: 'error' })
      );
      expect(recordFailureSpy).toHaveBeenCalledWith(
        123,
        expect.objectContaining({
          sessionPatch: expect.objectContaining({
            status: 'error',
            chatStatus: AgentChatStatus.ERROR,
            workspaceStatus: AgentWorkspaceStatus.FAILED,
            endedAt: expect.any(String),
          }),
          failure: expect.objectContaining({
            stage: 'connect_runtime',
            origin: 'agent_session',
            retryable: false,
            recordedAt: expect.any(String),
          }),
          runtimePlanMetadata: expect.objectContaining({
            pvcName: 'agent-pvc-aaaaaaaa',
            ownsPvc: true,
          }),
        }),
        expect.objectContaining({
          expectedLifecycle: {
            action: 'provision',
            claimedAt: expect.any(String),
          },
        })
      );
      expect(deleteAgentPvc.mock.invocationCallOrder[0]).toBeLessThan(recordFailureSpy.mock.invocationCallOrder[0]);
      expectSandboxFailure({ stage: 'connect_runtime', origin: 'agent_session' });
      recordFailureSpy.mockRestore();
    });

    it.each([
      {
        name: 'image pull failure',
        error: new Error('ImagePullBackOff while pulling lifecycle-agent:latest'),
        title: 'Session workspace image could not be pulled',
        message: 'ImagePullBackOff while pulling lifecycle-agent:latest',
      },
      {
        name: 'init-skills failure',
        error: new Error('init-skills: dependency install failed'),
        title: 'Skill initialization failed',
        message: 'init-skills: dependency install failed',
      },
      {
        name: 'editor startup failure',
        error: new Error('workspace editor container failed to start'),
        title: 'Workspace editor failed to start',
        message: 'workspace editor container failed to start',
      },
      {
        name: 'pod readiness timeout',
        error: new Error('Session workspace pod did not become ready within 120000ms'),
        title: 'Session workspace did not become ready',
        message: 'Session workspace pod did not become ready within 120000ms',
      },
    ])('persists classified $name through canonical workspace failure state', async ({ error, title, message }) => {
      const recordFailureSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure');
      (createSessionWorkspacePod as jest.Mock).mockRejectedValueOnce(error);

      await expect(AgentSessionService.createSession(baseOpts)).rejects.toThrow(error.message);

      const startupFailurePayload = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(startupFailurePayload).toEqual(
        expect.objectContaining({
          stage: 'connect_runtime',
          title,
          message,
          retryable: false,
          origin: 'agent_session',
          recordedAt: expect.any(String),
        })
      );
      expect(recordFailureSpy).toHaveBeenCalledWith(
        123,
        expect.objectContaining({
          sessionPatch: expect.objectContaining({
            status: 'error',
            chatStatus: AgentChatStatus.ERROR,
            workspaceStatus: AgentWorkspaceStatus.FAILED,
            endedAt: expect.any(String),
          }),
          failure: expect.objectContaining({
            stage: 'connect_runtime',
            title,
            message,
            retryable: false,
            origin: 'agent_session',
          }),
        }),
        expect.objectContaining({
          expectedLifecycle: {
            action: 'provision',
            claimedAt: expect.any(String),
          },
        })
      );
      expectSandboxFailure({
        stage: 'connect_runtime',
        origin: 'agent_session',
        title,
        message,
      });
      recordFailureSpy.mockRestore();
    });

    it('persists infrastructure preparation failures before runtime connection starts', async () => {
      (createAgentPvc as jest.Mock).mockRejectedValueOnce(new Error('pvc setup failed'));

      await expect(AgentSessionService.createSession(baseOpts)).rejects.toThrow('pvc setup failed');

      const startupFailurePayload = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(startupFailurePayload.stage).toBe('prepare_infrastructure');
      expectSandboxFailure({ stage: 'prepare_infrastructure', origin: 'agent_session' });
    });

    it('persists sandbox launch failures with the sandbox_launch origin', async () => {
      (createSessionWorkspacePod as jest.Mock).mockRejectedValueOnce(new Error('sandbox pod failed'));

      let rejectedError: unknown;
      try {
        await AgentSessionService.createSession({
          ...baseOpts,
          buildKind: BuildKind.SANDBOX,
          buildUuid: 'sandbox-build-uuid',
        });
      } catch (error) {
        rejectedError = error;
      }

      expect(rejectedError).toBeInstanceOf(AgentSessionStartupError);
      expect(rejectedError).toMatchObject({
        message: 'sandbox pod failed',
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        buildUuid: 'sandbox-build-uuid',
        namespace: 'test-ns',
        failure: expect.objectContaining({
          stage: 'connect_runtime',
          origin: 'sandbox_launch',
          retryable: false,
        }),
      });

      expectSandboxFailure({ stage: 'connect_runtime', origin: 'sandbox_launch' });
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

      expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
      expect(deleteSessionWorkspaceService).not.toHaveBeenCalled();
      expect(deleteAgentApiKeySecret).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();

      releaseDeploy();
      await expect(rollbackPromise).rejects.toThrow('snapshot persist failed');
      expect(deleteSessionWorkspacePod).toHaveBeenCalledWith('test-ns', 'agent-aaaaaaaa');
      expect(deleteSessionWorkspaceService).toHaveBeenCalledWith('test-ns', 'agent-aaaaaaaa');
      expect(deleteAgentApiKeySecret).toHaveBeenCalledWith('test-ns', 'agent-secret-aaaaaaaa');
      expect(deleteAgentPvc).toHaveBeenCalledWith('test-ns', 'agent-pvc-aaaaaaaa');
    });
  });

  describe('attachServices', () => {
    it('connects a same-repo service to an active single-repo session', async () => {
      mockSessionQuery.findOne.mockResolvedValue({
        id: 321,
        uuid: 'sess-1',
        status: 'active',
        buildUuid: 'build-123',
        buildKind: 'environment',
        namespace: 'test-ns',
        podName: 'agent-aaaaaaaa',
        pvcName: 'agent-pvc-aaaaaaaa',
        workspaceRepos: [
          {
            repo: 'example-org/example-repo',
            repoUrl: 'https://github.com/example-org/example-repo.git',
            branch: 'feature/current',
            mountPath: '/workspace',
            primary: true,
          },
        ],
        selectedServices: [],
        devModeSnapshots: {},
      });
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValue([
        {
          name: 'web',
          type: 'github',
          deployId: 11,
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
            installCommand: 'cd /workspace/apps/web && pnpm install',
            workDir: '/workspace/apps/web',
          },
          repo: 'example-org/example-repo',
          branch: 'feature/current',
          revision: '0123456789abcdef0123456789abcdef01234567',
          baseDeploy: {
            id: 11,
            uuid: 'web-build-uuid',
          },
        },
      ]);

      await AgentSessionService.attachServices('sess-1', ['web']);

      expect(loadAgentSessionServiceCandidates).toHaveBeenCalledWith('build-123');
      expect(mockExecInPod).toHaveBeenCalledWith(
        'test-ns',
        'agent-aaaaaaaa',
        'workspace-gateway',
        ['sh', '-lc', 'cd /workspace/apps/web && pnpm install'],
        expect.anything(),
        expect.anything(),
        null,
        false,
        expect.any(Function)
      );
      expect(mockEnableDevMode).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'test-ns',
          deploymentName: 'web-build-uuid',
          serviceName: 'web-build-uuid',
          pvcName: 'agent-pvc-aaaaaaaa',
          requiredNodeName: 'agent-node-a',
          devConfig: expect.objectContaining({
            workDir: '/workspace/apps/web',
          }),
        })
      );
      expect(mockDeployQuery.patch).toHaveBeenCalledWith({
        devMode: true,
        devModeSessionId: 321,
      });
      expect(mockSessionQuery.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedServices: [
            expect.objectContaining({
              name: 'web',
              deployId: 11,
              repo: 'example-org/example-repo',
              branch: 'feature/current',
              workspacePath: '/workspace',
              workDir: '/workspace/apps/web',
            }),
          ],
          devModeSnapshots: expect.objectContaining({
            '11': expect.any(Object),
          }),
        })
      );
    });

    it('starts dev mode for multiple attached services in parallel', async () => {
      const webEnable = createDeferred<ReturnType<typeof buildDevModeSnapshot>>();
      const apiEnable = createDeferred<ReturnType<typeof buildDevModeSnapshot>>();
      mockEnableDevMode.mockImplementationOnce(() => webEnable.promise).mockImplementationOnce(() => apiEnable.promise);

      mockSessionQuery.findOne.mockResolvedValue({
        id: 321,
        uuid: 'sess-1',
        status: 'active',
        buildUuid: 'build-123',
        buildKind: 'environment',
        namespace: 'test-ns',
        podName: 'agent-aaaaaaaa',
        pvcName: 'agent-pvc-aaaaaaaa',
        workspaceRepos: [
          {
            repo: 'example-org/example-repo',
            repoUrl: 'https://github.com/example-org/example-repo.git',
            branch: 'feature/current',
            mountPath: '/workspace',
            primary: true,
          },
        ],
        selectedServices: [],
        devModeSnapshots: {},
      });
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValue([
        {
          name: 'web',
          type: 'github',
          deployId: 11,
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
            installCommand: 'cd /workspace/apps/web && pnpm install',
            workDir: '/workspace/apps/web',
          },
          repo: 'example-org/example-repo',
          branch: 'feature/current',
          revision: '0123456789abcdef0123456789abcdef01234567',
          baseDeploy: {
            id: 11,
            uuid: 'web-build-uuid',
          },
        },
        {
          name: 'api',
          type: 'github',
          deployId: 22,
          devConfig: {
            image: 'node:20',
            command: 'pnpm start',
            installCommand: 'cd /workspace/apps/api && pnpm install',
            workDir: '/workspace/apps/api',
          },
          repo: 'example-org/example-repo',
          branch: 'feature/current',
          revision: 'fedcba98765432100123456789abcdef01234567',
          baseDeploy: {
            id: 22,
            uuid: 'api-build-uuid',
          },
        },
      ]);

      const attachPromise = AgentSessionService.attachServices('sess-1', ['web', 'api']);
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockEnableDevMode).toHaveBeenCalledTimes(2);
      expect(mockSessionQuery.patch).not.toHaveBeenCalled();

      webEnable.resolve(buildDevModeSnapshot('web-build-uuid'));
      apiEnable.resolve(buildDevModeSnapshot('api-build-uuid'));

      await expect(attachPromise).resolves.toBeUndefined();
    });

    it('restores successful attached services when one parallel dev-mode enable fails', async () => {
      mockSessionQuery.findOne.mockResolvedValue({
        id: 321,
        uuid: 'sess-1',
        status: 'active',
        buildUuid: 'build-123',
        buildKind: 'environment',
        namespace: 'test-ns',
        podName: 'agent-aaaaaaaa',
        pvcName: 'agent-pvc-aaaaaaaa',
        workspaceRepos: [
          {
            repo: 'example-org/example-repo',
            repoUrl: 'https://github.com/example-org/example-repo.git',
            branch: 'feature/current',
            mountPath: '/workspace',
            primary: true,
          },
        ],
        selectedServices: [],
        devModeSnapshots: {},
      });
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValue([
        {
          name: 'web',
          type: 'github',
          deployId: 11,
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
            installCommand: 'cd /workspace/apps/web && pnpm install',
            workDir: '/workspace/apps/web',
          },
          repo: 'example-org/example-repo',
          branch: 'feature/current',
          revision: '0123456789abcdef0123456789abcdef01234567',
          baseDeploy: {
            id: 11,
            uuid: 'web-build-uuid',
          },
        },
        {
          name: 'api',
          type: 'github',
          deployId: 22,
          devConfig: {
            image: 'node:20',
            command: 'pnpm start',
            installCommand: 'cd /workspace/apps/api && pnpm install',
            workDir: '/workspace/apps/api',
          },
          repo: 'example-org/example-repo',
          branch: 'feature/current',
          revision: 'fedcba98765432100123456789abcdef01234567',
          baseDeploy: {
            id: 22,
            uuid: 'api-build-uuid',
          },
        },
      ]);
      mockEnableDevMode
        .mockResolvedValueOnce(buildDevModeSnapshot('web-build-uuid'))
        .mockRejectedValueOnce(new Error('api dev mode failed'));

      const deployManagerDeploy = jest.fn().mockResolvedValue(undefined);
      (DeploymentManager as jest.Mock).mockImplementation(() => ({
        deploy: deployManagerDeploy,
      }));

      const revertDeploys = [
        {
          id: 11,
          uuid: 'deploy-11',
          build: { namespace: 'test-ns' },
          deployable: { name: 'web', type: 'github', deploymentDependsOn: [] },
        },
      ];
      mockDeployQuery.withGraphFetched.mockResolvedValue(revertDeploys);

      await expect(AgentSessionService.attachServices('sess-1', ['web', 'api'])).rejects.toThrow('api dev mode failed');

      expect(mockSessionQuery.patch).not.toHaveBeenCalled();
      expect(mockDeployQuery.patch).not.toHaveBeenCalled();
      expect(DeploymentManager).toHaveBeenCalledWith(revertDeploys);
      expect(deployManagerDeploy).toHaveBeenCalled();
      expect(mockDisableDevMode).toHaveBeenCalledTimes(2);
      expect(mockDisableDevMode).toHaveBeenNthCalledWith(
        1,
        'test-ns',
        'deploy-11',
        'deploy-11',
        buildDevModeSnapshot('web-build-uuid')
      );
      expect(mockDisableDevMode).toHaveBeenNthCalledWith(
        2,
        'test-ns',
        'deploy-11',
        'deploy-11',
        buildDevModeSnapshot('web-build-uuid')
      );
      expect(mockDisableDevMode.mock.invocationCallOrder[0]).toBeLessThan(
        deployManagerDeploy.mock.invocationCallOrder[0]
      );
    });

    it('honors the session stored same-node policy when attaching services', async () => {
      // The stored boolean short-circuits the global-config fallback, so no config stub is queued.
      mockSessionQuery.findOne.mockResolvedValue({
        id: 321,
        uuid: 'sess-1',
        status: 'active',
        buildUuid: 'build-123',
        buildKind: 'environment',
        namespace: 'test-ns',
        podName: 'agent-aaaaaaaa',
        pvcName: 'agent-pvc-aaaaaaaa',
        keepAttachedServicesOnSessionNode: true,
        workspaceRepos: [
          {
            repo: 'example-org/example-repo',
            repoUrl: 'https://github.com/example-org/example-repo.git',
            branch: 'feature/current',
            mountPath: '/workspace',
            primary: true,
          },
        ],
        selectedServices: [],
        devModeSnapshots: {},
      });
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValue([
        {
          name: 'web',
          type: 'github',
          deployId: 11,
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
            installCommand: 'cd /workspace/apps/web && pnpm install',
            workDir: '/workspace/apps/web',
          },
          repo: 'example-org/example-repo',
          branch: 'feature/current',
          revision: '0123456789abcdef0123456789abcdef01234567',
          baseDeploy: {
            id: 11,
            uuid: 'web-build-uuid',
          },
        },
      ]);

      await AgentSessionService.attachServices('sess-1', ['web']);

      expect(mockEnableDevMode).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentName: 'web-build-uuid',
          requiredNodeName: 'agent-node-a',
        })
      );
    });

    it('honors a stored disabled same-node policy when attaching services', async () => {
      mockSessionQuery.findOne.mockResolvedValue({
        id: 321,
        uuid: 'sess-1',
        status: 'active',
        buildUuid: 'build-123',
        buildKind: 'environment',
        namespace: 'test-ns',
        podName: 'agent-aaaaaaaa',
        pvcName: 'agent-pvc-aaaaaaaa',
        keepAttachedServicesOnSessionNode: false,
        workspaceRepos: [
          {
            repo: 'example-org/example-repo',
            repoUrl: 'https://github.com/example-org/example-repo.git',
            branch: 'feature/current',
            mountPath: '/workspace',
            primary: true,
          },
        ],
        selectedServices: [],
        devModeSnapshots: {},
      });
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValue([
        {
          name: 'web',
          type: 'github',
          deployId: 11,
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
            installCommand: 'cd /workspace/apps/web && pnpm install',
            workDir: '/workspace/apps/web',
          },
          repo: 'example-org/example-repo',
          branch: 'feature/current',
          revision: '0123456789abcdef0123456789abcdef01234567',
          baseDeploy: {
            id: 11,
            uuid: 'web-build-uuid',
          },
        },
      ]);

      await AgentSessionService.attachServices('sess-1', ['web']);

      expect(mockEnableDevMode).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentName: 'web-build-uuid',
          requiredNodeName: undefined,
        })
      );
    });

    it('falls back to the current global placement policy for legacy sessions', async () => {
      const globalConfigService = jest.requireMock('server/services/globalConfig').default;
      globalConfigService.getInstance.mockReturnValueOnce({
        getConfig: jest.fn().mockImplementation(async (key: string) => {
          if (key === 'agentSessionDefaults') {
            return {
              scheduling: {
                keepAttachedServicesOnSessionNode: false,
              },
            };
          }

          return null;
        }),
      });

      mockSessionQuery.findOne.mockResolvedValue({
        id: 321,
        uuid: 'sess-1',
        status: 'active',
        buildUuid: 'build-123',
        buildKind: 'environment',
        namespace: 'test-ns',
        podName: 'agent-aaaaaaaa',
        pvcName: 'agent-pvc-aaaaaaaa',
        workspaceRepos: [
          {
            repo: 'example-org/example-repo',
            repoUrl: 'https://github.com/example-org/example-repo.git',
            branch: 'feature/current',
            mountPath: '/workspace',
            primary: true,
          },
        ],
        selectedServices: [],
        devModeSnapshots: {},
      });
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValue([
        {
          name: 'web',
          type: 'github',
          deployId: 11,
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
            installCommand: 'cd /workspace/apps/web && pnpm install',
            workDir: '/workspace/apps/web',
          },
          repo: 'example-org/example-repo',
          branch: 'feature/current',
          revision: '0123456789abcdef0123456789abcdef01234567',
          baseDeploy: {
            id: 11,
            uuid: 'web-build-uuid',
          },
        },
      ]);

      await AgentSessionService.attachServices('sess-1', ['web']);

      expect(mockEnableDevMode).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentName: 'web-build-uuid',
          requiredNodeName: undefined,
        })
      );
    });

    it('rejects services outside the current repo checkout', async () => {
      mockSessionQuery.findOne.mockResolvedValue({
        id: 321,
        uuid: 'sess-1',
        status: 'active',
        buildUuid: 'build-123',
        buildKind: 'environment',
        namespace: 'test-ns',
        podName: 'agent-aaaaaaaa',
        pvcName: 'agent-pvc-aaaaaaaa',
        workspaceRepos: [
          {
            repo: 'example-org/example-repo',
            repoUrl: 'https://github.com/example-org/example-repo.git',
            branch: 'feature/current',
            mountPath: '/workspace',
            primary: true,
          },
        ],
        selectedServices: [],
        devModeSnapshots: {},
      });
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValue([
        {
          name: 'api',
          type: 'github',
          deployId: 22,
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
          },
          repo: 'example-org/other-repo',
          branch: 'feature/current',
          revision: null,
          baseDeploy: {
            id: 22,
            uuid: 'api-build-uuid',
          },
        },
      ]);

      await expect(AgentSessionService.attachServices('sess-1', ['api'])).rejects.toThrow(
        'Only services from example-org/example-repo:feature/current can be connected after the session starts.'
      );

      expect(mockEnableDevMode).not.toHaveBeenCalled();
      expect(mockSessionQuery.patch).not.toHaveBeenCalled();
    });

    it('rejects services that require forwarding env vars into the already-running agent', async () => {
      mockSessionQuery.findOne.mockResolvedValue({
        id: 321,
        uuid: 'sess-1',
        status: 'active',
        buildUuid: 'build-123',
        buildKind: 'environment',
        namespace: 'test-ns',
        podName: 'agent-aaaaaaaa',
        pvcName: 'agent-pvc-aaaaaaaa',
        workspaceRepos: [
          {
            repo: 'example-org/example-repo',
            repoUrl: 'https://github.com/example-org/example-repo.git',
            branch: 'feature/current',
            mountPath: '/workspace',
            primary: true,
          },
        ],
        selectedServices: [],
        devModeSnapshots: {},
      });
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValue([
        {
          name: 'worker',
          type: 'github',
          deployId: 33,
          devConfig: {
            image: 'node:20',
            command: 'pnpm dev',
            forwardEnvVarsToAgent: ['PRIVATE_TOKEN'],
          },
          repo: 'example-org/example-repo',
          branch: 'feature/current',
          revision: null,
          baseDeploy: {
            id: 33,
            uuid: 'worker-build-uuid',
          },
        },
      ]);

      await expect(AgentSessionService.attachServices('sess-1', ['worker'])).rejects.toThrow(
        'Services that forward env vars to the agent must be selected when the session starts: worker'
      );

      expect(mockEnableDevMode).not.toHaveBeenCalled();
      expect(mockSessionQuery.patch).not.toHaveBeenCalled();
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

    it('blocks cleanup while an agent run is active before destructive work starts', async () => {
      const activeSession = {
        id: 1,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildKind: BuildKind.ENVIRONMENT,
        buildUuid: null,
        namespace: 'test-ns',
        podName: 'agent-sess1',
        pvcName: 'agent-pvc-sess1',
        forwardedAgentSecretProviders: ['aws'],
        devModeSnapshots: {},
      };
      mockSessionQuery.findOne.mockResolvedValueOnce(activeSession);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(activeSession);
      mockRunQuery.first.mockResolvedValueOnce({
        id: 99,
        uuid: 'run-99',
        status: 'running',
      });

      await expect(AgentSessionService.endSession('sess-1')).rejects.toBeInstanceOf(WorkspaceActionBlockedError);

      expect(deleteSessionWorkspaceService).not.toHaveBeenCalled();
      expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
      expect(deleteAgentApiKeySecret).not.toHaveBeenCalled();
      expect(cleanupForwardedAgentEnvSecrets).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();
      expect(mockDeleteNamespace).not.toHaveBeenCalled();
      expect(mockRedis.del).not.toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      expect(mockedBuildServiceModule.deleteQueueAdd).not.toHaveBeenCalled();
      expect(mockSessionQuery.patchAndFetchById).not.toHaveBeenCalled();
    });

    it('blocks cleanup while another workspace lifecycle action is active', async () => {
      const activeSession = {
        id: 1,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildKind: BuildKind.ENVIRONMENT,
        buildUuid: null,
        namespace: 'test-ns',
        podName: 'agent-sess1',
        pvcName: 'agent-pvc-sess1',
        forwardedAgentSecretProviders: ['aws'],
        devModeSnapshots: {},
      };
      mockSessionQuery.findOne.mockResolvedValueOnce(activeSession);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(activeSession);
      mockSandboxQuery.first.mockResolvedValueOnce({
        id: 654,
        metadata: {
          runtimeLifecycle: {
            currentAction: 'resume',
            claimedAt: new Date().toISOString(),
          },
        },
      });

      await expect(AgentSessionService.endSession('sess-1')).rejects.toBeInstanceOf(WorkspaceActionBlockedError);

      expect(deleteSessionWorkspaceService).not.toHaveBeenCalled();
      expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
      expect(deleteAgentApiKeySecret).not.toHaveBeenCalled();
      expect(cleanupForwardedAgentEnvSecrets).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();
      expect(mockDeleteNamespace).not.toHaveBeenCalled();
      expect(mockedBuildServiceModule.deleteQueueAdd).not.toHaveBeenCalled();
      expect(mockSessionQuery.patchAndFetchById).not.toHaveBeenCalled();
    });

    it('ends session, triggers deploy restore, deletes pod and pvc, updates DB and Redis', async () => {
      const activeSession = {
        id: 1,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildKind: BuildKind.ENVIRONMENT,
        buildUuid: null,
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

      mockEndSessionSession(activeSession);
      queueEndedSession(activeSession, { devModeSnapshots: {} });

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
      mockDeployQuery.withGraphFetched.mockResolvedValueOnce(devModeDeploys);
      const recordStateSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceState');

      await AgentSessionService.endSession('sess-1');

      expect(DeploymentManager).toHaveBeenCalledWith(devModeDeploys);
      expect(deployManagerDeploy).toHaveBeenCalled();
      expect(mockDisableDevMode).toHaveBeenCalledWith(
        'test-ns',
        'deploy-10',
        'deploy-10',
        activeSession.devModeSnapshots['10']
      );
      expect(mockDisableDevMode.mock.invocationCallOrder[0]).toBeLessThan(
        deployManagerDeploy.mock.invocationCallOrder[0]
      );
      expect(deleteSessionWorkspaceService).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteSessionWorkspacePod).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteAgentPvc).toHaveBeenCalledWith('test-ns', 'agent-pvc-sess1');
      expect(deleteAgentApiKeySecret).toHaveBeenCalledWith('test-ns', 'agent-secret-aaaaaaaa');
      expect(cleanupForwardedAgentEnvSecrets).toHaveBeenCalledWith('test-ns', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', [
        'aws',
      ]);
      expect(mockSessionQuery.patchAndFetchById.mock.invocationCallOrder[0]).toBeLessThan(
        (deleteSessionWorkspacePod as jest.Mock).mock.invocationCallOrder[0]
      );
      expect(mockSessionQuery.patchAndFetchById.mock.invocationCallOrder[0]).toBeLessThan(
        (cleanupForwardedAgentEnvSecrets as jest.Mock).mock.invocationCallOrder[0]
      );
      expect(mockSessionQuery.patchAndFetchById.mock.invocationCallOrder[0]).toBeLessThan(
        (deleteAgentPvc as jest.Mock).mock.invocationCallOrder[0]
      );
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ status: 'ended', devModeSnapshots: {} })
      );
      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({
          status: 'ended',
          metadata: expect.not.objectContaining({
            runtimeLifecycle: expect.any(Object),
          }),
        })
      );
      expect(recordStateSpy).toHaveBeenLastCalledWith(
        1,
        expect.objectContaining({
          sandboxStatus: 'ended',
        }),
        expect.objectContaining({
          expectedLifecycle: {
            action: 'cleanup',
            claimedAt: expect.any(String),
          },
        })
      );
      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      recordStateSpy.mockRestore();
    });

    it('claims cleanup before deleting a chat namespace', async () => {
      const chatSession = {
        id: 1,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.CHAT,
        buildKind: null,
        buildUuid: null,
        namespace: 'chat-aaaaaaaa',
        podName: 'agent-chat',
        pvcName: 'agent-pvc-chat',
        forwardedAgentSecretProviders: [],
        devModeSnapshots: {},
      };
      mockEndSessionSession(chatSession);
      queueEndedSession(chatSession, { devModeSnapshots: {} });

      await AgentSessionService.endSession('sess-1');

      expect(mockSessionQuery.patchAndFetchById.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteNamespace.mock.invocationCallOrder[0]
      );
      expect(mockDeleteNamespace).toHaveBeenCalledWith('chat-aaaaaaaa');
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ status: 'ended', devModeSnapshots: {} })
      );
      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({
          status: 'ended',
          metadata: expect.not.objectContaining({
            runtimeLifecycle: expect.any(Object),
          }),
        })
      );
    });

    it('preserves a reused prewarm PVC when ending the session', async () => {
      mockGetReadyPrewarmByPvc.mockResolvedValue({
        uuid: 'prewarm-1',
        pvcName: 'agent-prewarm-pvc-1234',
        status: 'ready',
      });

      const activeSession = {
        id: 1,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildKind: BuildKind.ENVIRONMENT,
        buildUuid: 'build-123',
        namespace: 'test-ns',
        podName: 'agent-sess1',
        pvcName: 'agent-prewarm-pvc-1234',
        forwardedAgentSecretProviders: [],
        devModeSnapshots: {},
      };

      mockEndSessionSession(activeSession);
      queueEndedSession(activeSession, { devModeSnapshots: {} });

      (Build.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue({ kind: 'environment' }),
        }),
      });

      (Deploy.query as jest.Mock) = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue([]),
        }),
      });

      await AgentSessionService.endSession('sess-1');

      expect(mockGetReadyPrewarmByPvc).toHaveBeenCalledWith({
        buildUuid: 'build-123',
        pvcName: 'agent-prewarm-pvc-1234',
      });
      expect(deleteAgentPvc).not.toHaveBeenCalled();
      expect(deleteSessionWorkspacePod).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteAgentApiKeySecret).toHaveBeenCalledWith('test-ns', 'agent-secret-aaaaaaaa');
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ status: 'ended', devModeSnapshots: {} })
      );
    });

    it('preserves a reused prewarm PVC from persisted runtime-plan metadata when prewarm DB state drifted', async () => {
      mockGetReadyPrewarmByPvc.mockResolvedValue(null);
      mockPersistedSandboxMetadata({
        runtimePlan: {
          version: 1,
          pvc: {
            name: 'agent-prewarm-pvc-1234',
            ownsPvc: false,
            skipWorkspaceBootstrap: true,
            compatiblePrewarmUuid: 'prewarm-1',
          },
        },
      });

      const activeSession = {
        id: 1,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildKind: BuildKind.ENVIRONMENT,
        buildUuid: 'build-123',
        namespace: 'test-ns',
        podName: 'agent-sess1',
        pvcName: 'agent-prewarm-pvc-1234',
        forwardedAgentSecretProviders: [],
        devModeSnapshots: {},
      };

      mockEndSessionSession(activeSession);
      queueEndedSession(activeSession, { devModeSnapshots: {} });

      (Build.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue({ kind: 'environment' }),
        }),
      });

      (Deploy.query as jest.Mock) = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue([]),
        }),
      });

      await AgentSessionService.endSession('sess-1');

      expect(mockGetReadyPrewarmByPvc).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();
      expect(deleteSessionWorkspacePod).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteAgentApiKeySecret).toHaveBeenCalledWith('test-ns', 'agent-secret-aaaaaaaa');
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ status: 'ended', devModeSnapshots: {} })
      );
    });

    it('deletes an owned PVC from persisted runtime-plan metadata when ending the session', async () => {
      mockGetReadyPrewarmByPvc.mockResolvedValue({
        uuid: 'prewarm-1',
        pvcName: 'agent-pvc-sess1',
        status: 'ready',
      });
      mockPersistedSandboxMetadata({
        runtimePlan: {
          version: 1,
          pvc: {
            name: 'agent-pvc-sess1',
            ownsPvc: true,
            skipWorkspaceBootstrap: false,
            compatiblePrewarmUuid: null,
          },
        },
      });

      const activeSession = {
        id: 1,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildKind: BuildKind.ENVIRONMENT,
        buildUuid: 'build-123',
        namespace: 'test-ns',
        podName: 'agent-sess1',
        pvcName: 'agent-pvc-sess1',
        forwardedAgentSecretProviders: [],
        devModeSnapshots: {},
      };

      mockEndSessionSession(activeSession);
      queueEndedSession(activeSession, { devModeSnapshots: {} });

      (Build.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue({ kind: 'environment' }),
        }),
      });

      (Deploy.query as jest.Mock) = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue([]),
        }),
      });

      await AgentSessionService.endSession('sess-1');

      expect(mockGetReadyPrewarmByPvc).not.toHaveBeenCalled();
      expect(deleteAgentPvc).toHaveBeenCalledWith('test-ns', 'agent-pvc-sess1');
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ status: 'ended', devModeSnapshots: {} })
      );
    });

    it('cleans up a failed session when explicitly ended', async () => {
      const failedSession = {
        id: 1,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'error',
        chatStatus: AgentChatStatus.ERROR,
        workspaceStatus: AgentWorkspaceStatus.FAILED,
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildKind: BuildKind.ENVIRONMENT,
        buildUuid: null,
        namespace: 'test-ns',
        podName: 'agent-sess1',
        pvcName: 'agent-pvc-sess1',
        forwardedAgentSecretProviders: ['aws'],
        devModeSnapshots: {},
      };
      mockEndSessionSession(failedSession);
      queueEndedSession(failedSession, { devModeSnapshots: {} });
      const recordStateSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceState');

      await AgentSessionService.endSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      expect(deleteSessionWorkspaceService).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteSessionWorkspacePod).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteAgentApiKeySecret).toHaveBeenCalledWith('test-ns', 'agent-secret-aaaaaaaa');
      expect(cleanupForwardedAgentEnvSecrets).toHaveBeenCalledWith('test-ns', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', [
        'aws',
      ]);
      expect(deleteAgentPvc).toHaveBeenCalledWith('test-ns', 'agent-pvc-sess1');
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          status: 'ended',
          endedAt: expect.any(String),
        })
      );
      expect(recordStateSpy).toHaveBeenLastCalledWith(
        1,
        expect.objectContaining({
          sandboxStatus: 'ended',
        }),
        expect.objectContaining({
          expectedLifecycle: {
            action: 'cleanup',
            claimedAt: expect.any(String),
          },
        })
      );
      recordStateSpy.mockRestore();
    });

    it('persists cleanup failures with the cleanup stage and origin', async () => {
      const activeSession = {
        id: 1,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildKind: BuildKind.ENVIRONMENT,
        buildUuid: null,
        namespace: 'test-ns',
        podName: 'agent-sess1',
        pvcName: 'agent-pvc-sess1',
        forwardedAgentSecretProviders: [],
        devModeSnapshots: {},
      };

      const recordFailureSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure');
      mockEndSessionSession(activeSession);
      (Build.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue(null),
        }),
      });
      (Deploy.query as jest.Mock) = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue([]),
        }),
      });
      (deleteAgentPvc as jest.Mock).mockRejectedValueOnce(new Error('pvc cleanup failed'));

      await expect(AgentSessionService.endSession('sess-1')).rejects.toThrow('pvc cleanup failed');

      expect(recordFailureSpy).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          sessionPatch: expect.objectContaining({
            workspaceStatus: AgentWorkspaceStatus.FAILED,
          }),
          failure: expect.objectContaining({
            stage: 'cleanup',
            origin: 'cleanup',
            retryable: false,
            recordedAt: expect.any(String),
          }),
        }),
        expect.objectContaining({
          expectedLifecycle: {
            action: 'cleanup',
            claimedAt: expect.any(String),
          },
        })
      );
      expectSandboxFailure({ stage: 'cleanup', origin: 'cleanup' });
      recordFailureSpy.mockRestore();
    });

    it('records cleanup failure without deleting a reused prewarm PVC', async () => {
      mockPersistedSandboxMetadata({
        runtimePlan: {
          version: 1,
          pvc: {
            name: 'agent-prewarm-pvc-1234',
            ownsPvc: false,
            skipWorkspaceBootstrap: true,
            compatiblePrewarmUuid: 'prewarm-1',
          },
        },
      });

      const activeSession = {
        id: 1,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildKind: BuildKind.ENVIRONMENT,
        buildUuid: 'build-123',
        namespace: 'test-ns',
        podName: 'agent-sess1',
        pvcName: 'agent-prewarm-pvc-1234',
        forwardedAgentSecretProviders: [],
        devModeSnapshots: {
          '10': buildDevModeSnapshot('deploy-10'),
        },
      };
      const devModeDeploys = [
        {
          id: 10,
          uuid: 'deploy-10',
          build: { namespace: 'test-ns' },
          deployable: { name: 'web', type: 'github', deploymentDependsOn: [] },
        },
      ];
      mockEndSessionSession(activeSession);
      (Build.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue({ kind: 'environment' }),
        }),
      });
      mockDeployQuery.withGraphFetched.mockResolvedValueOnce(devModeDeploys);
      mockDisableDevMode.mockRejectedValueOnce(new Error('dev mode cleanup failed'));

      await expect(AgentSessionService.endSession('sess-1')).rejects.toThrow('dev mode cleanup failed');

      expect(deleteAgentPvc).not.toHaveBeenCalled();
      expectSandboxFailure({ stage: 'cleanup', origin: 'cleanup' });
    });

    it('returns after cleanup and restore trigger without waiting for redeploy to finish', async () => {
      const activeSession = {
        id: 1,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildKind: BuildKind.ENVIRONMENT,
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

      mockEndSessionSession(activeSession);
      queueEndedSession(activeSession, { devModeSnapshots: {} });

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
      mockDeployQuery.withGraphFetched.mockResolvedValueOnce(devModeDeploys);

      const endPromise = AgentSessionService.endSession('sess-1');
      await new Promise((resolve) => setImmediate(resolve));

      expect(deleteSessionWorkspacePod).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteSessionWorkspaceService).toHaveBeenCalledWith('test-ns', 'agent-sess1');
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
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.SANDBOX,
        buildKind: BuildKind.SANDBOX,
        namespace: 'sbx-test-build',
        podName: 'agent-sbx',
        pvcName: 'agent-pvc-sbx',
        buildUuid: 'sandbox-build-uuid',
      };

      mockEndSessionSession(activeSandboxSession);
      queueEndedSession(activeSandboxSession);

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
      expect(mockSessionQuery.patchAndFetchById.mock.invocationCallOrder[0]).toBeLessThan(
        mockedBuildServiceModule.deleteQueueAdd.mock.invocationCallOrder[0]
      );
      expect(mockedBuildServiceModule.deleteBuild).not.toHaveBeenCalled();
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        444,
        expect.objectContaining({ status: 'ended' })
      );
      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });
  });

  describe('OpenSandbox-backed sessions', () => {
    it('rejects createSession when an OpenSandbox runtime plan resolves Lifecycle services', async () => {
      const runtime = mockOpenSandboxRuntime();
      mockResolveWorkspaceRuntimePlan.mockResolvedValueOnce(
        buildRuntimePlan({
          runtimeConfig: {
            workspaceBackend: buildWorkspaceBackendConfig('opensandbox'),
          } as Partial<WorkspaceRuntimePlan>['runtimeConfig'],
          servicePlan: {
            workspaceRepos: [
              {
                repo: 'example-org/example-repo',
                repoUrl: 'https://github.com/example-org/example-repo.git',
                branch: 'feature/example-session',
                mountPath: '/workspace',
                primary: true,
              },
            ],
            services: [
              {
                name: 'web',
                deployId: 1,
                resourceName: 'web-build-uuid',
                devConfig: { image: 'node:20', command: 'pnpm dev' },
              },
            ],
            selectedServices: [],
          } as unknown as Partial<WorkspaceRuntimePlan>['servicePlan'],
        })
      );

      await expect(AgentSessionService.createSession(baseOpts)).rejects.toThrow(
        'The OpenSandbox workspace backend does not support environment sessions or dev-mode service attachment.'
      );

      expect(runtime.reattach).not.toHaveBeenCalled();
      expect(runtime.provision).not.toHaveBeenCalled();
      expect(runtime.destroy).not.toHaveBeenCalled();
      expect(mockEnableDevMode).not.toHaveBeenCalled();
      expectSandboxFailure({
        stage: 'create_session',
        origin: 'agent_session',
        message: 'does not support environment sessions or dev-mode service attachment',
      });
      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({ provider: 'opensandbox', status: 'failed' })
      );
      expectNoCreateSessionKubernetesHelpersCalled();
    });

    it('rejects attachServices before any service validation', async () => {
      mockOpenSandboxRuntime();
      mockOpenSandboxSandboxRow();
      mockSessionQuery.findOne.mockResolvedValueOnce({
        id: 321,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        buildKind: BuildKind.ENVIRONMENT,
        buildUuid: 'build-123',
        namespace: 'test-ns',
        podName: 'sbx-123',
        pvcName: null,
        workspaceRepos: [],
      });

      await expect(AgentSessionService.attachServices('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', ['web'])).rejects.toThrow(
        'The OpenSandbox workspace backend does not support environment sessions or dev-mode service attachment.'
      );

      expect(mockEnableDevMode).not.toHaveBeenCalled();
      expect(mockSessionQuery.patchAndFetchById).not.toHaveBeenCalled();
    });

    it('destroys the sandbox on endSession instead of deleting the chat namespace', async () => {
      const runtime = mockOpenSandboxRuntime();
      mockOpenSandboxSandboxRow();
      const chatSession = {
        id: 321,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.CHAT,
        buildKind: null,
        buildUuid: null,
        namespace: 'chat-aaaaaaaa',
        podName: 'sbx-123',
        pvcName: null,
        forwardedAgentSecretProviders: [],
        devModeSnapshots: {},
      };
      mockEndSessionSession(chatSession);
      queueEndedSession(chatSession, { devModeSnapshots: {}, podName: null, pvcName: null });

      await AgentSessionService.endSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      expect(runtime.destroy).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxId: 'sbx-123',
          lifecycleBaseUrl: 'https://opensandbox.example.test/v1',
        })
      );
      expect(mockDeleteNamespace).not.toHaveBeenCalled();
      expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();
      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        321,
        expect.objectContaining({ status: 'ended', podName: null, pvcName: null })
      );
      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({ provider: 'opensandbox', status: 'ended' })
      );
    });

    it('restores previously published preview exposures after remote resume', async () => {
      const runtime = mockOpenSandboxRuntime();
      const previousProviderState = {
        sandboxId: 'sbx-123',
        lifecycleBaseUrl: 'https://opensandbox.example.test/v1',
      };
      const resumedProviderState = {
        sandboxId: 'sbx-456',
        lifecycleBaseUrl: 'https://opensandbox.example.test/v1',
        editorUrl: 'https://sbx-456.opensandbox.example.test/editor',
      };
      runtime.resume.mockResolvedValue({
        providerState: resumedProviderState,
        capabilitySnapshot: { backend: 'opensandbox', portExposure: true },
        podNameAlias: 'sbx-456',
      });
      const persistedSandbox = {
        id: 654,
        sessionId: 321,
        generation: 1,
        provider: 'opensandbox',
        status: 'suspended',
        providerState: previousProviderState,
        metadata: {},
        endedAt: null,
      };
      mockSandboxQuery.first.mockImplementation(async () => {
        const latestPayload = sandboxWritePayloads().at(-1);
        return latestPayload ? { ...persistedSandbox, ...latestPayload } : persistedSandbox;
      });
      const hibernatedSession = buildChatRuntimeSession({
        namespace: 'chat-aaaaaaaa',
        podName: 'sbx-123',
        workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
      });
      const readySession = {
        ...hibernatedSession,
        podName: 'sbx-456',
        workspaceStatus: AgentWorkspaceStatus.READY,
      };
      mockSessionQuery.findOne.mockResolvedValueOnce(hibernatedSession);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(hibernatedSession);
      queuePatchedSession(hibernatedSession);
      queuePatchedSession(readySession);

      await AgentSessionService.resumeChatRuntime({
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'sample-user',
        userIdentity: { userId: 'sample-user', githubUsername: 'sample-user' } as any,
        githubToken: 'sample-gh-token',
      });

      expect(runtime.resume.mock.calls[0][0]).toEqual(previousProviderState);
      expect(mockRestorePreviewExposures).toHaveBeenCalledWith(
        expect.objectContaining({
          uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          workspaceStatus: AgentWorkspaceStatus.READY,
          podName: 'sbx-456',
        })
      );
    });

    it('records a workspace failure and rethrows when suspend fails', async () => {
      const runtime = mockOpenSandboxRuntime();
      runtime.suspend.mockRejectedValueOnce(new Error('opensandbox suspend failed'));
      mockOpenSandboxSandboxRow();
      const chatSession = {
        id: 321,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        userId: 'sample-user',
        sessionKind: AgentSessionKind.CHAT,
        status: 'active',
        workspaceStatus: AgentWorkspaceStatus.READY,
        chatStatus: AgentChatStatus.READY,
        namespace: 'chat-aaaaaaaa',
        podName: 'sbx-123',
        pvcName: null,
      };
      mockSessionQuery.findOne.mockResolvedValueOnce(chatSession);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
      queuePatchedSession(chatSession);
      queuePatchedSession({ ...chatSession, workspaceStatus: AgentWorkspaceStatus.FAILED });
      const recordFailureSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure');

      await expect(
        AgentSessionService.suspendChatRuntime({
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userId: 'sample-user',
        })
      ).rejects.toThrow('opensandbox suspend failed');

      expect(runtime.suspend).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'sbx-123' }), {
        retainForMs: 24 * 60 * 60 * 1000 + 60 * 60 * 1000,
      });
      expect(recordFailureSpy).toHaveBeenCalledWith(
        321,
        expect.objectContaining({
          failure: expect.objectContaining({ stage: 'suspend', origin: 'suspend' }),
          runtimeProvider: 'opensandbox',
          providerState: expect.objectContaining({ sandboxId: 'sbx-123' }),
        }),
        expect.objectContaining({
          expectedLifecycle: { action: 'suspend', claimedAt: expect.any(String) },
        })
      );
      expectSandboxFailure({ stage: 'suspend', origin: 'suspend', message: 'opensandbox suspend failed' });
      expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenLastCalledWith(
        321,
        expect.objectContaining({ workspaceStatus: AgentWorkspaceStatus.FAILED })
      );
      recordFailureSpy.mockRestore();
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
          title: 'Session workspace pod failed to start',
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
            title: 'Session workspace pod failed to start',
            message: 'init-workspace: ImagePullBackOff',
            recordedAt: '2026-03-25T10:00:00.000Z',
            retryable: false,
            origin: 'agent_session',
          },
        })
      );
    });

    it('falls back to durable sandbox failure details when Redis startup failure is absent', async () => {
      mockSessionQuery.findOne.mockResolvedValue({
        id: 1,
        uuid: 'sess-1',
        status: 'error',
        buildUuid: null,
        devModeSnapshots: {},
      });
      mockSandboxQuery.orderBy
        .mockImplementationOnce(() => mockSandboxQuery)
        .mockImplementationOnce(() =>
          Promise.resolve([
            {
              id: 654,
              uuid: 'sandbox-1',
              sessionId: 1,
              generation: 1,
              provider: 'lifecycle_kubernetes',
              status: 'failed',
              providerState: {},
              error: {
                stage: 'connect_runtime',
                title: 'Session workspace pod failed to start',
                message: 'init-workspace: ImagePullBackOff',
                recordedAt: '2026-03-25T10:00:00.000Z',
                retryable: false,
                origin: 'agent_session',
              },
            },
          ])
        );

      const result = await AgentSessionService.getSession('sess-1');

      expect(result).toEqual(
        expect.objectContaining({
          id: 'sess-1',
          status: 'error',
          startupFailure: {
            stage: 'connect_runtime',
            title: 'Session workspace pod failed to start',
            message: 'init-workspace: ImagePullBackOff',
            recordedAt: '2026-03-25T10:00:00.000Z',
            retryable: false,
            origin: 'agent_session',
          },
        })
      );
    });

    it('prefers durable sandbox failure details over stale Redis startup failure details', async () => {
      mockSessionQuery.findOne.mockResolvedValue({
        id: 1,
        uuid: 'sess-1',
        status: 'error',
        buildUuid: null,
        devModeSnapshots: {},
      });
      mockRedis.get.mockResolvedValue(
        JSON.stringify({
          sessionId: 'sess-1',
          stage: 'connect_runtime',
          title: 'Stale Redis failure',
          message: 'stale failure',
          recordedAt: '2026-03-24T10:00:00.000Z',
        })
      );
      mockSandboxQuery.orderBy
        .mockImplementationOnce(() => mockSandboxQuery)
        .mockImplementationOnce(() =>
          Promise.resolve([
            {
              id: 654,
              uuid: 'sandbox-1',
              sessionId: 1,
              generation: 1,
              provider: 'lifecycle_kubernetes',
              status: 'failed',
              providerState: {},
              error: {
                stage: 'attach_services',
                title: 'Attached services failed to start',
                message: 'sample-service failed to start',
                recordedAt: '2026-03-25T10:00:00.000Z',
                retryable: false,
                origin: 'agent_session',
              },
            },
          ])
        );

      const result = await AgentSessionService.getSession('sess-1');

      expect(result).toEqual(
        expect.objectContaining({
          id: 'sess-1',
          status: 'error',
          startupFailure: {
            stage: 'attach_services',
            title: 'Attached services failed to start',
            message: 'sample-service failed to start',
            recordedAt: '2026-03-25T10:00:00.000Z',
            retryable: false,
            origin: 'agent_session',
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
          title: 'Session workspace pod failed to start',
          message: 'init-workspace: ImagePullBackOff',
          recordedAt: '2026-03-25T10:00:00.000Z',
        })
      );

      const result = await AgentSessionService.getSessionStartupFailure('sess-1');

      expect(mockRedis.get).toHaveBeenCalledWith('lifecycle:agent:session:startup-failure:sess-1');
      expect(result).toEqual({
        stage: 'connect_runtime',
        title: 'Session workspace pod failed to start',
        message: 'init-workspace: ImagePullBackOff',
        recordedAt: '2026-03-25T10:00:00.000Z',
        retryable: false,
        origin: 'agent_session',
      });
    });

    it('persists a runtime failure in Redis and marks the session errored', async () => {
      const recordFailureSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure');
      mockSessionQuery.findOne.mockResolvedValue({
        id: 123,
        uuid: 'sess-1',
        status: 'active',
        namespace: 'test-ns',
        podName: 'agent-sess1',
        pvcName: 'agent-pvc-sess1',
      });

      const result = await AgentSessionService.markSessionRuntimeFailure(
        'sess-1',
        new Error('Session workspace pod failed to start: init-workspace: ImagePullBackOff')
      );

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'lifecycle:agent:session:startup-failure:sess-1',
        3600,
        expect.any(String)
      );
      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:sess-1');
      expect(recordFailureSpy).toHaveBeenCalledWith(
        123,
        expect.objectContaining({
          sessionPatch: expect.objectContaining({
            status: 'error',
            chatStatus: AgentChatStatus.ERROR,
            workspaceStatus: AgentWorkspaceStatus.FAILED,
            endedAt: expect.any(String),
          }),
          failure: expect.objectContaining({
            stage: 'connect_runtime',
            origin: 'manual_runtime',
            retryable: false,
          }),
        })
      );
      expect(result).toEqual(
        expect.objectContaining({
          stage: 'connect_runtime',
          title: 'Session workspace pod failed to start',
          message: 'init-workspace: ImagePullBackOff',
        })
      );
      expectSandboxFailure({ stage: 'connect_runtime', origin: 'manual_runtime' });
      recordFailureSpy.mockRestore();
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
                deployable: { name: 'sample-git-service' },
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
          services: ['sample-git-service'],
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
          title: 'Session workspace pod failed to start',
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
            title: 'Session workspace pod failed to start',
            message: 'init-workspace: ImagePullBackOff',
            recordedAt: '2026-03-25T10:00:00.000Z',
            retryable: false,
            origin: 'agent_session',
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

  describe('getSessionAppendSystemPrompt', () => {
    it('uses the control-plane prompt config and appends dynamic session context', async () => {
      mockGetEffectiveAgentSessionConfig.mockResolvedValue({
        appendSystemPrompt: 'Use concise responses.',
      });
      (systemPrompt.resolveAgentSessionPromptContext as jest.Mock).mockResolvedValue({
        namespace: 'test-ns',
        buildUuid: 'build-123',
        services: [],
      });
      (systemPrompt.buildAgentSessionDynamicSystemPrompt as jest.Mock).mockReturnValue(
        'Session context:\n- namespace: test-ns'
      );
      (systemPrompt.combineAgentSessionAppendSystemPrompt as jest.Mock).mockReturnValue('combined prompt');

      (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({
          select: jest.fn().mockResolvedValue({
            id: 123,
            namespace: 'test-ns',
            buildUuid: 'build-123',
            workspaceStatus: AgentWorkspaceStatus.READY,
            podName: 'agent-test',
          }),
        }),
      });

      await expect(AgentSessionService.getSessionAppendSystemPrompt('sess-1')).resolves.toBe('combined prompt');
      expect(mockGetEffectiveAgentSessionConfig).toHaveBeenCalled();
      expect(systemPrompt.resolveAgentSessionPromptContext).toHaveBeenCalledWith({
        sessionDbId: 123,
        namespace: 'test-ns',
        buildUuid: 'build-123',
      });
      expect(systemPrompt.buildAgentSessionDynamicSystemPrompt).toHaveBeenCalled();
      const dynamicArgs = (systemPrompt.buildAgentSessionDynamicSystemPrompt as jest.Mock).mock.calls[0][0];
      expect(dynamicArgs.toolLines.length).toBeGreaterThan(0);
      expect(systemPrompt.combineAgentSessionAppendSystemPrompt).toHaveBeenCalledWith(
        'Use concise responses.',
        'Session context:\n- namespace: test-ns'
      );
    });

    it('appends dynamic build context without workspace tool inventory for build-context chats', async () => {
      mockGetEffectiveAgentSessionConfig.mockResolvedValue({
        appendSystemPrompt: 'Use concise responses.',
      });
      (systemPrompt.resolveAgentSessionPromptContext as jest.Mock).mockResolvedValue({
        namespace: null,
        buildUuid: 'build-123',
        services: [],
        build: { uuid: 'build-123', status: 'build_failed', namespace: 'env-build-123' },
        lifecycleConfig: { status: 'missing', path: 'lifecycle.yaml' },
      });
      (systemPrompt.buildAgentSessionDynamicSystemPrompt as jest.Mock).mockReturnValue(
        'Session context:\n- buildUuid: build-123\nBuild context:\n- buildUuid=build-123: status=build_failed'
      );
      (systemPrompt.combineAgentSessionAppendSystemPrompt as jest.Mock).mockReturnValue('combined build prompt');

      (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({
          select: jest.fn().mockResolvedValue({
            id: 123,
            namespace: null,
            buildUuid: 'build-123',
            skillPlan: { skills: [] },
            workspaceStatus: AgentWorkspaceStatus.NONE,
            podName: null,
          }),
        }),
      });

      await expect(AgentSessionService.getSessionAppendSystemPrompt('sess-1')).resolves.toBe('combined build prompt');
      expect(systemPrompt.resolveAgentSessionPromptContext).toHaveBeenCalledWith({
        sessionDbId: 123,
        namespace: null,
        buildUuid: 'build-123',
      });
      const dynamicArgs = (systemPrompt.buildAgentSessionDynamicSystemPrompt as jest.Mock).mock.calls[0][0];
      expect(dynamicArgs.toolLines).toEqual([]);
      // Top-level namespace falls back to build.namespace.
      expect(dynamicArgs.namespace).toBe('env-build-123');
      expect(dynamicArgs.lifecycleConfig).toEqual({ status: 'missing', path: 'lifecycle.yaml' });
    });

    it('emits the UNAVAILABLE snapshot when prompt context resolution fails', async () => {
      mockGetEffectiveAgentSessionConfig.mockResolvedValue({
        appendSystemPrompt: 'Use concise responses.',
      });
      (systemPrompt.resolveAgentSessionPromptContext as jest.Mock).mockRejectedValue(new Error('lookup failed'));

      (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({
          select: jest.fn().mockResolvedValue({
            id: 123,
            namespace: null,
            buildUuid: 'build-123',
            skillPlan: { skills: [] },
          }),
        }),
      });

      const prompt = await AgentSessionService.getSessionAppendSystemPrompt('sess-1');
      expect(prompt).toContain('Use concise responses.');
      expect(prompt).toContain(
        'Initial Lifecycle snapshot: UNAVAILABLE (context lookup failed) — gather build/deploy/k8s state via tools and note in your answer that baseline context was unavailable.'
      );
    });

    it('returns the configured control-plane prompt when the session cannot be found', async () => {
      mockGetEffectiveAgentSessionConfig.mockResolvedValue({
        appendSystemPrompt: 'Use concise responses.',
      });

      (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({
          select: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(AgentSessionService.getSessionAppendSystemPrompt('missing')).resolves.toBe('Use concise responses.');
    });
  });
});
