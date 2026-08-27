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
const mockProbeWorkspacePodPresence = jest.fn().mockResolvedValue('present');
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
  probeWorkspacePodPresence: (...args: unknown[]) => mockProbeWorkspacePodPresence(...args),
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
  const enqueueBuildDeletion = jest.fn().mockResolvedValue(undefined);
  const deleteBuild = jest.fn().mockResolvedValue(undefined);

  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      enqueueBuildDeletion,
      deleteBuild,
    })),
    __mocked: {
      enqueueBuildDeletion,
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
  ActiveEnvironmentSessionError,
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
import { WorkspaceRuntimeGoneError, WorkspaceRuntimeSecurityError } from 'server/services/workspaceRuntime/types';

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
  enqueueBuildDeletion: jest.Mock;
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
        idleArchiveMs: 30 * 24 * 60 * 60 * 1000,
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

function mockTeardownSession(session: Record<string, unknown>): void {
  mockSessionQuery.findOne.mockResolvedValueOnce(session);
  mockSessionQuery.forUpdate.mockResolvedValueOnce(session);
  queuePatchedSession(session);
}

function queueArchivedSession(session: Record<string, unknown>, extraPatch: Record<string, unknown> = {}): void {
  queuePatchedSession({
    ...session,
    status: 'archived',
    chatStatus: AgentChatStatus.READY,
    workspaceStatus: AgentWorkspaceStatus.NONE,
    archivedAt: new Date().toISOString(),
    podName: null,
    pvcName: null,
    ...extraPatch,
  });
}

function queueReleasedSession(session: Record<string, unknown>, extraPatch: Record<string, unknown> = {}): void {
  queuePatchedSession({
    ...session,
    status: 'active',
    chatStatus: AgentChatStatus.READY,
    workspaceStatus: AgentWorkspaceStatus.NONE,
    archivedAt: null,
    podName: null,
    pvcName: null,
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
    mockedBuildServiceModule.enqueueBuildDeletion.mockResolvedValue(undefined);
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
        idleArchiveMs: 30 * 24 * 60 * 60 * 1000,
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
        // The gateway bearer token is never persisted at rest — only the endpoint URL.
        providerState: {
          url: 'http://agent-aaaaaaaa.chat-aaaaaaaa.svc.cluster.local:13338/preview/3000',
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

  describe('reconcileLostChatWorkspaceRuntime', () => {
    // The transition spies stub class statics; restore exactly these so later suites hit the real
    // implementations (a blanket restoreAllMocks would also tear down this file's module-scope spies).
    const activeSpies: jest.SpyInstance[] = [];
    function trackSpy<T extends jest.SpyInstance>(spy: T): T {
      activeSpies.push(spy);
      return spy;
    }
    afterEach(() => {
      while (activeSpies.length > 0) {
        activeSpies.pop()?.mockRestore();
      }
    });

    const readyChatSession = {
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
    const k8sBackend = { backendId: 'lifecycle_kubernetes', provider: null, state: {} };

    function spyOnDerive(value: unknown) {
      return trackSpy(
        jest.spyOn(AgentSandboxService, 'deriveWorkspaceBackendForAction').mockResolvedValue(value as any)
      );
    }

    function spyOnTransitions() {
      const claimSpy = trackSpy(
        jest
          .spyOn(WorkspaceRuntimeStateService, 'claimWorkspaceAction')
          .mockResolvedValue({ session: readyChatSession, sandbox: null } as any)
      );
      const recordSpy = trackSpy(
        jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceState').mockResolvedValue({
          session: { ...readyChatSession, workspaceStatus: AgentWorkspaceStatus.HIBERNATED, podName: null },
          sandbox: null,
        } as any)
      );
      const releaseSpy = trackSpy(jest.spyOn(AgentSessionService, 'releaseWorkspace').mockResolvedValue(undefined));
      return { claimSpy, recordSpy, releaseSpy };
    }

    it('does nothing unless the session claims a ready chat workspace', async () => {
      const deriveSpy = trackSpy(jest.spyOn(AgentSandboxService, 'deriveWorkspaceBackendForAction'));
      mockSessionQuery.findOne.mockResolvedValueOnce({
        ...readyChatSession,
        workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
      });

      await expect(AgentSessionService.reconcileLostChatWorkspaceRuntime(readyChatSession.uuid)).resolves.toBeNull();
      expect(deriveSpy).not.toHaveBeenCalled();
      expect(mockProbeWorkspacePodPresence).not.toHaveBeenCalled();
    });

    it('hibernates a kubernetes session whose pod vanished, preserving the PVC reference', async () => {
      const { claimSpy, recordSpy, releaseSpy } = spyOnTransitions();
      spyOnDerive(k8sBackend);
      mockSessionQuery.findOne.mockResolvedValueOnce(readyChatSession);
      mockProbeWorkspacePodPresence.mockResolvedValueOnce('pod_missing');

      const settled = await AgentSessionService.reconcileLostChatWorkspaceRuntime(readyChatSession.uuid, {
        allowedActiveRunUuid: 'run-1',
      });

      expect(claimSpy).toHaveBeenCalledWith(
        readyChatSession.id,
        expect.objectContaining({
          action: 'suspend',
          allowedActiveRunUuid: 'run-1',
          sessionPatch: expect.objectContaining({ podName: null }),
        })
      );
      expect(recordSpy).toHaveBeenCalledWith(
        readyChatSession.id,
        expect.objectContaining({
          sessionPatch: expect.objectContaining({
            workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
            podName: null,
          }),
          sandboxStatus: 'suspended',
        }),
        expect.objectContaining({ expectedLifecycle: expect.objectContaining({ action: 'suspend' }) })
      );
      // pvcName stays untouched: the kubernetes resume lane restores workspace data from the PVC.
      expect(recordSpy.mock.calls[0][1].sessionPatch).not.toHaveProperty('pvcName');
      expect(releaseSpy).not.toHaveBeenCalled();
      expect(settled?.workspaceStatus).toBe(AgentWorkspaceStatus.HIBERNATED);
      expect(mockRedis.del).toHaveBeenCalledWith(`lifecycle:agent:session:${readyChatSession.uuid}`);
    });

    it('releases the workspace when the whole namespace is gone', async () => {
      const { claimSpy, releaseSpy } = spyOnTransitions();
      spyOnDerive(k8sBackend);
      mockSessionQuery.findOne
        .mockResolvedValueOnce(readyChatSession)
        .mockResolvedValueOnce({ ...readyChatSession, workspaceStatus: AgentWorkspaceStatus.NONE });
      mockProbeWorkspacePodPresence.mockResolvedValueOnce('namespace_missing');

      const settled = await AgentSessionService.reconcileLostChatWorkspaceRuntime(readyChatSession.uuid, {
        allowedActiveRunUuid: 'run-1',
      });

      expect(releaseSpy).toHaveBeenCalledWith(readyChatSession.uuid, { allowedActiveRunUuid: 'run-1' });
      expect(claimSpy).not.toHaveBeenCalled();
      expect(settled?.workspaceStatus).toBe(AgentWorkspaceStatus.NONE);
    });

    it('leaves a live runtime alone and treats probe failures as inconclusive', async () => {
      const { claimSpy, releaseSpy } = spyOnTransitions();
      spyOnDerive(k8sBackend);
      mockSessionQuery.findOne.mockResolvedValue(readyChatSession);
      mockProbeWorkspacePodPresence.mockResolvedValueOnce('present');
      await expect(AgentSessionService.reconcileLostChatWorkspaceRuntime(readyChatSession.uuid)).resolves.toBeNull();

      mockProbeWorkspacePodPresence.mockRejectedValueOnce(new Error('kube api down'));
      await expect(AgentSessionService.reconcileLostChatWorkspaceRuntime(readyChatSession.uuid)).resolves.toBeNull();

      expect(claimSpy).not.toHaveBeenCalled();
      expect(releaseSpy).not.toHaveBeenCalled();
    });

    it('hibernates a remote session whose sandbox is unrecoverable, keeping its sandbox alias and state', async () => {
      const { claimSpy, recordSpy } = spyOnTransitions();
      const reattach = jest.fn().mockResolvedValue(null);
      spyOnDerive({
        backendId: 'e2b',
        provider: { backendId: 'e2b', reattach } as any,
        state: { sandboxId: 'sbx-1' },
      });
      mockSessionQuery.findOne.mockResolvedValueOnce(readyChatSession);

      const settled = await AgentSessionService.reconcileLostChatWorkspaceRuntime(readyChatSession.uuid);

      expect(reattach.mock.calls[0][0]).toEqual({ sandboxId: 'sbx-1' });
      // Remote rows keep podName (the sandbox-id alias the resume lane reads) and providerState so
      // resume can restore from a checkpoint or fall through to a fresh provision.
      expect(claimSpy).toHaveBeenCalledWith(
        readyChatSession.id,
        expect.objectContaining({
          action: 'suspend',
          runtimeProvider: 'e2b',
          sessionPatch: expect.objectContaining({ podName: readyChatSession.podName }),
        })
      );
      expect(recordSpy).toHaveBeenCalledWith(
        readyChatSession.id,
        expect.objectContaining({
          sessionPatch: expect.objectContaining({ workspaceStatus: AgentWorkspaceStatus.HIBERNATED }),
        }),
        expect.anything()
      );
      expect(settled?.workspaceStatus).toBe(AgentWorkspaceStatus.HIBERNATED);
      expect(mockProbeWorkspacePodPresence).not.toHaveBeenCalled();
    });

    it('does not transition when the remote sandbox reattaches', async () => {
      const { claimSpy, releaseSpy } = spyOnTransitions();
      spyOnDerive({
        backendId: 'e2b',
        provider: { backendId: 'e2b', reattach: jest.fn().mockResolvedValue({ providerState: {} }) } as any,
        state: { sandboxId: 'sbx-1' },
      });
      mockSessionQuery.findOne.mockResolvedValueOnce(readyChatSession);

      await expect(AgentSessionService.reconcileLostChatWorkspaceRuntime(readyChatSession.uuid)).resolves.toBeNull();
      expect(claimSpy).not.toHaveBeenCalled();
      expect(releaseSpy).not.toHaveBeenCalled();
    });

    it('yields to a concurrent workspace action instead of fighting the claim', async () => {
      const { claimSpy } = spyOnTransitions();
      claimSpy.mockRejectedValueOnce(new WorkspaceActionBlockedError('active_run', 'blocked'));
      spyOnDerive(k8sBackend);
      mockSessionQuery.findOne.mockResolvedValueOnce(readyChatSession);
      mockProbeWorkspacePodPresence.mockResolvedValueOnce('pod_missing');

      await expect(AgentSessionService.reconcileLostChatWorkspaceRuntime(readyChatSession.uuid)).resolves.toBeNull();
    });

    it('leaves the session untouched when settling a confirmed loss fails unexpectedly', async () => {
      const { claimSpy, recordSpy } = spyOnTransitions();
      claimSpy.mockRejectedValueOnce(new Error('state database unavailable'));
      spyOnDerive(k8sBackend);
      mockSessionQuery.findOne.mockResolvedValueOnce(readyChatSession);
      mockProbeWorkspacePodPresence.mockResolvedValueOnce('pod_missing');

      await expect(AgentSessionService.reconcileLostChatWorkspaceRuntime(readyChatSession.uuid)).resolves.toBeNull();
      expect(recordSpy).not.toHaveBeenCalled();
    });
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

    it('preserves the preflight error when persisting that failure also fails', async () => {
      (UserApiKeyService.getDecryptedKey as jest.Mock).mockResolvedValue(null);
      (AgentSession.transaction as jest.Mock).mockRejectedValueOnce(new Error('failure database unavailable'));

      await expect(AgentSessionService.createSession(baseOpts)).rejects.toThrow(
        'No API key is configured for provider "anthropic"'
      );
      expect(mockRedis.setex).toHaveBeenCalled();
      expect(createAgentPvc).not.toHaveBeenCalled();
      expect(createSessionWorkspacePod).not.toHaveBeenCalled();
    });

    it('preserves the initial session persistence error when recording that failure also fails', async () => {
      const persistenceError = new Error('session insert unavailable');
      (AgentSession.transaction as jest.Mock)
        .mockRejectedValueOnce(persistenceError)
        .mockRejectedValueOnce(new Error('failure record unavailable'));

      await expect(AgentSessionService.createSession(baseOpts)).rejects.toBe(persistenceError);

      expect(AgentSession.transaction).toHaveBeenCalledTimes(2);
      expect(mockRedis.setex).toHaveBeenCalled();
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

    it('records a prewarmed pod readiness failure as a runtime connection failure', async () => {
      const readinessError = new Error('prewarmed pod never became ready');
      mockGetCompatibleReadyPrewarm.mockResolvedValue({
        uuid: 'prewarm-1',
        pvcName: 'agent-prewarm-pvc-1234',
        services: ['web'],
        status: 'ready',
      });
      (waitForSessionWorkspacePodReady as jest.Mock).mockRejectedValueOnce(readinessError);
      mockDeployQuery.withGraphFetched.mockRejectedValueOnce(new Error('rollback deploy lookup unavailable'));
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

      await expect(AgentSessionService.createSession(optsWithServices)).rejects.toThrow(readinessError.message);

      const startupFailurePayload = JSON.parse(mockRedis.setex.mock.calls[0][2]);
      expect(startupFailurePayload).toEqual(
        expect.objectContaining({
          stage: 'connect_runtime',
          message: readinessError.message,
        })
      );
      expect(mockDeployQuery.withGraphFetched).toHaveBeenCalled();
    });

    it('records a prewarmed pod scheduling failure before enabling same-node services', async () => {
      const schedulingError = new Error('pod scheduling watch failed');
      mockGetCompatibleReadyPrewarm.mockResolvedValue({
        uuid: 'prewarm-1',
        pvcName: 'agent-prewarm-pvc-1234',
        services: ['web'],
        status: 'ready',
      });
      (waitForSessionWorkspacePodScheduled as jest.Mock).mockRejectedValueOnce(schedulingError);
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

      await expect(AgentSessionService.createSession(optsWithServices)).rejects.toThrow(schedulingError.message);
      expect(mockEnableDevMode).not.toHaveBeenCalled();
      expect(JSON.parse(mockRedis.setex.mock.calls[0][2])).toEqual(
        expect.objectContaining({ stage: 'connect_runtime', message: schedulingError.message })
      );
    });

    it('rejects a prewarmed same-node attachment when scheduling returns no node', async () => {
      mockGetCompatibleReadyPrewarm.mockResolvedValue({
        uuid: 'prewarm-1',
        pvcName: 'agent-prewarm-pvc-1234',
        services: ['web'],
        status: 'ready',
      });
      (waitForSessionWorkspacePodScheduled as jest.Mock).mockResolvedValueOnce({ spec: {} });
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

      await expect(AgentSessionService.createSession(optsWithServices)).rejects.toThrow(
        'Session workspace pod agent-build-123 did not report a scheduled node'
      );
      expect(mockEnableDevMode).not.toHaveBeenCalled();
    });

    it('rejects a cold same-node attachment when the created pod has no node', async () => {
      (createSessionWorkspacePod as jest.Mock).mockResolvedValueOnce({ spec: {} });
      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        services: [
          {
            name: 'web',
            deployId: 1,
            resourceName: 'web-build-uuid',
            devConfig: { image: 'node:20', command: 'pnpm dev' },
          },
        ],
      };

      await expect(AgentSessionService.createSession(optsWithServices)).rejects.toThrow(
        'Session workspace pod agent-aaaaaaaa did not report a scheduled node'
      );
      expect(mockEnableDevMode).not.toHaveBeenCalled();
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
          {
            name: 'worker',
            deployId: 2,
            resourceName: 'worker-build-uuid',
            devConfig: {
              image: 'node:20',
              command: 'pnpm worker',
            },
          },
        ],
      };

      await AgentSessionService.createSession(optsWithServices);

      expect(buildContext.$fetchGraph).toHaveBeenCalledWith('[deploys.[deployable], pullRequest]');
      expect(mockEnableDevMode).toHaveBeenCalledWith(
        expect.objectContaining({
          devConfig: expect.objectContaining({
            env: {
              ASSET_PREFIX: 'https://sample-service-sample-env.example.test',
            },
          }),
        })
      );
      expect(mockEnableDevMode).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentName: 'worker-build-uuid',
          devConfig: expect.objectContaining({
            image: 'node:20',
            command: 'pnpm worker',
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

    it('preserves the runtime error when persisting the post-startup failure is unavailable', async () => {
      const runtimeError = new Error('pod creation failed before readiness');
      const recordFailureSpy = jest
        .spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure')
        .mockRejectedValueOnce(new Error('workspace failure persistence unavailable'));
      (createSessionWorkspacePod as jest.Mock).mockRejectedValueOnce(runtimeError);

      await expect(AgentSessionService.createSession(baseOpts)).rejects.toBe(runtimeError);

      expect(recordFailureSpy).toHaveBeenCalled();
      expect(deleteSessionWorkspacePod).toHaveBeenCalledWith('test-ns', 'agent-aaaaaaaa');
      expect(deleteAgentPvc).toHaveBeenCalledWith('test-ns', 'agent-pvc-aaaaaaaa');
      recordFailureSpy.mockRestore();
    });

    it('best-effort reverts a persisted service row when final Redis readiness persistence fails', async () => {
      const readinessPersistenceError = new Error('ready Redis write failed');
      const rollbackPatchError = new Error('deploy rollback patch failed');
      const deployToRestore = {
        id: 1,
        uuid: 'web-build-uuid',
        build: { namespace: 'test-ns' },
        deployable: { name: 'web', type: 'github', deploymentDependsOn: [] },
      };
      mockRedis.setex.mockRejectedValueOnce(readinessPersistenceError);
      mockDeployQuery.patch.mockResolvedValueOnce(1).mockRejectedValueOnce(rollbackPatchError);
      mockDeployQuery.withGraphFetched.mockResolvedValueOnce([deployToRestore]);
      const optsWithServices: CreateSessionOptions = {
        ...baseOpts,
        services: [
          {
            name: 'web',
            deployId: 1,
            resourceName: 'web-build-uuid',
            devConfig: { image: 'node:20', command: 'pnpm dev' },
          },
        ],
      };

      await expect(AgentSessionService.createSession(optsWithServices)).rejects.toThrow(
        readinessPersistenceError.message
      );

      expect(mockDeployQuery.patch).toHaveBeenNthCalledWith(1, { devMode: true, devModeSessionId: 123 });
      expect(mockDeployQuery.patch).toHaveBeenNthCalledWith(2, { devMode: false, devModeSessionId: null });
      expect(DeploymentManager).toHaveBeenCalledWith([deployToRestore]);
      expect(mockDisableDevMode).toHaveBeenCalled();
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

  describe('archiveSession', () => {
    it('throws if session not found', async () => {
      (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue(null),
      });

      await expect(AgentSessionService.archiveSession('nonexistent')).rejects.toThrow(
        'Session not found or already archived'
      );
    });

    it('throws if session already archived', async () => {
      (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue({ id: 1, uuid: 'sess-1', status: 'archived' }),
      });

      await expect(AgentSessionService.archiveSession('sess-1')).rejects.toThrow(
        'Session not found or already archived'
      );
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

      await expect(AgentSessionService.archiveSession('sess-1')).rejects.toBeInstanceOf(WorkspaceActionBlockedError);

      expect(deleteSessionWorkspaceService).not.toHaveBeenCalled();
      expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
      expect(deleteAgentApiKeySecret).not.toHaveBeenCalled();
      expect(cleanupForwardedAgentEnvSecrets).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();
      expect(mockDeleteNamespace).not.toHaveBeenCalled();
      expect(mockRedis.del).not.toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      expect(mockedBuildServiceModule.enqueueBuildDeletion).not.toHaveBeenCalled();
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
      // Resolved for both the pre-claim backend derivation and the claim's active-action check.
      mockSandboxQuery.first.mockResolvedValue({
        id: 654,
        metadata: {
          runtimeLifecycle: {
            currentAction: 'resume',
            claimedAt: new Date().toISOString(),
          },
        },
      });

      await expect(AgentSessionService.archiveSession('sess-1')).rejects.toBeInstanceOf(WorkspaceActionBlockedError);

      expect(deleteSessionWorkspaceService).not.toHaveBeenCalled();
      expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
      expect(deleteAgentApiKeySecret).not.toHaveBeenCalled();
      expect(cleanupForwardedAgentEnvSecrets).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();
      expect(mockDeleteNamespace).not.toHaveBeenCalled();
      expect(mockedBuildServiceModule.enqueueBuildDeletion).not.toHaveBeenCalled();
      expect(mockSessionQuery.patchAndFetchById).not.toHaveBeenCalled();
    });

    it('archives the session, triggers deploy restore, deletes pod and pvc, updates DB and Redis', async () => {
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

      mockTeardownSession(activeSession);
      queueArchivedSession(activeSession, { devModeSnapshots: {} });

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

      await AgentSessionService.archiveSession('sess-1');

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
        expect.objectContaining({ status: 'archived', devModeSnapshots: {} })
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
      mockTeardownSession(chatSession);
      queueArchivedSession(chatSession, { devModeSnapshots: {} });

      await AgentSessionService.archiveSession('sess-1');

      expect(mockSessionQuery.patchAndFetchById.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteNamespace.mock.invocationCallOrder[0]
      );
      expect(mockDeleteNamespace).toHaveBeenCalledWith('chat-aaaaaaaa');
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          status: 'archived',
          chatStatus: AgentChatStatus.READY,
          workspaceStatus: AgentWorkspaceStatus.NONE,
          archivedAt: expect.any(String),
          namespace: null,
          podName: null,
          pvcName: null,
          devModeSnapshots: {},
        })
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

    it('releaseWorkspace tears down the chat workspace but keeps the session live', async () => {
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
      mockTeardownSession(chatSession);
      queueReleasedSession(chatSession, { namespace: null });

      await AgentSessionService.releaseWorkspace('sess-1');

      expect(mockDeleteNamespace).toHaveBeenCalledWith('chat-aaaaaaaa');
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          status: 'active',
          chatStatus: AgentChatStatus.READY,
          workspaceStatus: AgentWorkspaceStatus.NONE,
          archivedAt: null,
          namespace: null,
          podName: null,
          pvcName: null,
          devModeSnapshots: {},
        })
      );
      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({
          status: 'ended',
          metadata: expect.not.objectContaining({
            runtimeLifecycle: expect.any(Object),
          }),
        })
      );
      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('releaseWorkspace throws when the session is already archived', async () => {
      (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue({ id: 1, uuid: 'sess-1', status: 'archived' }),
      });

      await expect(AgentSessionService.releaseWorkspace('sess-1')).rejects.toThrow(
        'Session not found or already archived'
      );
    });

    it('preserves a reused prewarm PVC when archiving the session', async () => {
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

      mockTeardownSession(activeSession);
      queueArchivedSession(activeSession, { devModeSnapshots: {} });

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

      await AgentSessionService.archiveSession('sess-1');

      expect(mockGetReadyPrewarmByPvc).toHaveBeenCalledWith({
        buildUuid: 'build-123',
        pvcName: 'agent-prewarm-pvc-1234',
      });
      expect(deleteAgentPvc).not.toHaveBeenCalled();
      expect(deleteSessionWorkspacePod).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteAgentApiKeySecret).toHaveBeenCalledWith('test-ns', 'agent-secret-aaaaaaaa');
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ status: 'archived', devModeSnapshots: {} })
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

      mockTeardownSession(activeSession);
      queueArchivedSession(activeSession, { devModeSnapshots: {} });

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

      await AgentSessionService.archiveSession('sess-1');

      expect(mockGetReadyPrewarmByPvc).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();
      expect(deleteSessionWorkspacePod).toHaveBeenCalledWith('test-ns', 'agent-sess1');
      expect(deleteAgentApiKeySecret).toHaveBeenCalledWith('test-ns', 'agent-secret-aaaaaaaa');
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ status: 'archived', devModeSnapshots: {} })
      );
    });

    it('deletes an owned PVC from persisted runtime-plan metadata when archiving the session', async () => {
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

      mockTeardownSession(activeSession);
      queueArchivedSession(activeSession, { devModeSnapshots: {} });

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

      await AgentSessionService.archiveSession('sess-1');

      expect(mockGetReadyPrewarmByPvc).not.toHaveBeenCalled();
      expect(deleteAgentPvc).toHaveBeenCalledWith('test-ns', 'agent-pvc-sess1');
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ status: 'archived', devModeSnapshots: {} })
      );
    });

    it('cleans up a failed session when explicitly archived', async () => {
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
      mockTeardownSession(failedSession);
      queueArchivedSession(failedSession, { devModeSnapshots: {} });
      const recordStateSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceState');

      await AgentSessionService.archiveSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

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
          status: 'archived',
          archivedAt: expect.any(String),
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
      mockTeardownSession(activeSession);
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

      await expect(AgentSessionService.archiveSession('sess-1')).rejects.toThrow('pvc cleanup failed');

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
      mockTeardownSession(activeSession);
      (Build.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({
          withGraphFetched: jest.fn().mockResolvedValue({ kind: 'environment' }),
        }),
      });
      mockDeployQuery.withGraphFetched.mockResolvedValueOnce(devModeDeploys);
      mockDisableDevMode.mockRejectedValueOnce(new Error('dev mode cleanup failed'));

      await expect(AgentSessionService.archiveSession('sess-1')).rejects.toThrow('dev mode cleanup failed');

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

      mockTeardownSession(activeSession);
      queueArchivedSession(activeSession, { devModeSnapshots: {} });

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

      const endPromise = AgentSessionService.archiveSession('sess-1');
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

      mockTeardownSession(activeSandboxSession);
      queueArchivedSession(activeSandboxSession);

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

      await AgentSessionService.archiveSession('sess-sbx');

      expect(BuildServiceModule).toHaveBeenCalled();
      expect(mockedBuildServiceModule.enqueueBuildDeletion).toHaveBeenCalledWith(sandboxBuild, 'agent_session_archive');
      expect(mockSessionQuery.patchAndFetchById.mock.invocationCallOrder[0]).toBeLessThan(
        mockedBuildServiceModule.enqueueBuildDeletion.mock.invocationCallOrder[0]
      );
      expect(mockedBuildServiceModule.deleteBuild).not.toHaveBeenCalled();
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        444,
        expect.objectContaining({ status: 'archived' })
      );
      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });
  });

  describe('OpenSandbox-backed sessions', () => {
    it('creates an environment session through the remote runtime without Kubernetes resources', async () => {
      const runtime = mockOpenSandboxRuntime();
      const providerState = {
        sandboxId: 'sbx-environment',
        lifecycleBaseUrl: 'https://opensandbox.example.test/v1',
      };
      runtime.provision.mockResolvedValueOnce({
        providerState,
        capabilitySnapshot: { backend: 'opensandbox' },
        podNameAlias: 'sbx-environment',
      });
      mockResolveWorkspaceRuntimePlan.mockResolvedValueOnce(
        buildRuntimePlan({
          runtimeConfig: {
            workspaceBackend: buildWorkspaceBackendConfig('opensandbox'),
          } as Partial<WorkspaceRuntimePlan>['runtimeConfig'],
        })
      );
      mockGetDefaultThreadForSession.mockRejectedValueOnce(new Error('thread database unavailable'));

      await expect(AgentSessionService.createSession(baseOpts)).resolves.toMatchObject({
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildKind: BuildKind.ENVIRONMENT,
        status: 'active',
        workspaceStatus: AgentWorkspaceStatus.READY,
        namespace: 'test-ns',
        podName: 'sbx-environment',
        pvcName: null,
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(runtime.provision).toHaveBeenCalledWith(
        expect.objectContaining({ plan: expect.objectContaining({ namespace: 'test-ns' }) })
      );
      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({
          status: 'ready',
          provider: 'opensandbox',
          providerState: expect.objectContaining(providerState),
        })
      );
      expect(mockGetDefaultThreadForSession).toHaveBeenCalledWith('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'user-123');
      expect(createAgentPvc).not.toHaveBeenCalled();
      expect(createAgentApiKeySecret).not.toHaveBeenCalled();
      expect(createSessionWorkspacePod).not.toHaveBeenCalled();
      expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    });

    it('destroys a freshly provisioned remote runtime when ready-state persistence fails', async () => {
      const runtime = mockOpenSandboxRuntime();
      const providerState = {
        sandboxId: 'sbx-leaked-unless-destroyed',
        lifecycleBaseUrl: 'https://opensandbox.example.test/v1',
      };
      runtime.provision.mockResolvedValueOnce({
        providerState,
        capabilitySnapshot: { backend: 'opensandbox' },
        podNameAlias: 'sbx-leaked-unless-destroyed',
      });
      mockResolveWorkspaceRuntimePlan.mockResolvedValueOnce(
        buildRuntimePlan({
          kind: 'chat',
          runtimeConfig: {
            workspaceBackend: buildWorkspaceBackendConfig('opensandbox'),
          } as Partial<WorkspaceRuntimePlan>['runtimeConfig'],
          servicePlan: { workspaceRepos: [], services: undefined, selectedServices: [] },
        })
      );
      const chatSession = buildChatRuntimeSession();
      mockSessionQuery.findOne.mockResolvedValueOnce(chatSession);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
      queuePatchedSession(chatSession);
      const persistenceError = new Error('ready state persistence failed');
      mockSessionQuery.patchAndFetchById.mockRejectedValueOnce(persistenceError);
      queuePatchedSession({ ...chatSession, workspaceStatus: AgentWorkspaceStatus.FAILED });
      runtime.destroy.mockRejectedValueOnce(new Error('remote cleanup also failed'));

      await expect(
        AgentSessionService.provisionChatRuntime({
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userId: 'sample-user',
          userIdentity: { userId: 'sample-user', githubUsername: 'sample-user' } as any,
          githubToken: 'sample-gh-token',
        })
      ).rejects.toBe(persistenceError);

      expect(runtime.destroy).toHaveBeenCalledWith(expect.objectContaining(providerState));
      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({
          status: 'failed',
          error: expect.objectContaining({
            stage: 'connect_runtime',
            message: expect.stringContaining('ready state persistence failed'),
          }),
        })
      );
      expectNoCreateSessionKubernetesHelpersCalled();
    });

    it('preserves a reattached sandbox when ready-state persistence fails for the same handle', async () => {
      const runtime = mockOpenSandboxRuntime();
      const persistedState = {
        sandboxId: 'sbx-123',
        lifecycleBaseUrl: 'https://opensandbox.example.test/v1',
      };
      runtime.reattach.mockResolvedValueOnce({
        providerState: persistedState,
        capabilitySnapshot: { backend: 'opensandbox' },
      });
      mockOpenSandboxSandboxRow();
      mockResolveWorkspaceRuntimePlan.mockResolvedValueOnce(
        buildRuntimePlan({
          kind: 'chat',
          runtimeConfig: {
            workspaceBackend: buildWorkspaceBackendConfig('opensandbox'),
          } as Partial<WorkspaceRuntimePlan>['runtimeConfig'],
          servicePlan: { workspaceRepos: [], services: undefined, selectedServices: [] },
        })
      );
      const failedSession = buildChatRuntimeSession({
        namespace: 'chat-aaaaaaaa',
        podName: 'sbx-123',
        workspaceStatus: AgentWorkspaceStatus.FAILED,
      });
      mockSessionQuery.findOne.mockResolvedValueOnce(failedSession);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(failedSession);
      queuePatchedSession(failedSession);
      const persistenceError = new Error('ready state persistence failed');
      mockSessionQuery.patchAndFetchById.mockRejectedValueOnce(persistenceError);
      queuePatchedSession({ ...failedSession, workspaceStatus: AgentWorkspaceStatus.FAILED });

      await expect(
        AgentSessionService.provisionChatRuntime({
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userId: 'sample-user',
          userIdentity: { userId: 'sample-user', githubUsername: 'sample-user' } as any,
          githubToken: 'sample-gh-token',
        })
      ).rejects.toBe(persistenceError);

      expect(runtime.reattach).toHaveBeenCalledWith(persistedState, undefined);
      expect(runtime.provision).not.toHaveBeenCalled();
      expect(runtime.destroy).not.toHaveBeenCalled();
      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({
          status: 'failed',
          error: expect.objectContaining({
            stage: 'connect_runtime',
            message: expect.stringContaining('ready state persistence failed'),
          }),
        })
      );
      expectNoCreateSessionKubernetesHelpersCalled();
    });

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

    it('destroys the sandbox on archiveSession and clears any leftover chat namespace', async () => {
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
      mockTeardownSession(chatSession);
      queueArchivedSession(chatSession, { devModeSnapshots: {}, podName: null, pvcName: null });

      await AgentSessionService.archiveSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      expect(runtime.destroy).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxId: 'sbx-123',
          lifecycleBaseUrl: 'https://opensandbox.example.test/v1',
        })
      );
      // Belt-and-braces: retries can leave a K8s namespace alongside the remote sandbox.
      expect(mockDeleteNamespace).toHaveBeenCalledWith('chat-aaaaaaaa');
      expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();
      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        321,
        expect.objectContaining({ status: 'archived', podName: null, pvcName: null })
      );
      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({ provider: 'opensandbox', status: 'ended' })
      );
    });

    it('tears down the K8s workspace when a stale remote stamp has no persisted handle', async () => {
      const runtime = mockOpenSandboxRuntime();
      // Stale stamp: a failed remote attempt left the row stamped opensandbox but never persisted a handle.
      const staleRow = {
        id: 654,
        sessionId: 321,
        generation: 1,
        provider: 'opensandbox',
        status: 'ready',
        providerState: {},
        metadata: {},
        endedAt: null,
      };
      mockSandboxQuery.first.mockImplementation(async () => {
        const latestPayload = sandboxWritePayloads().at(-1);
        return latestPayload ? { ...staleRow, ...latestPayload } : staleRow;
      });
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
        podName: 'agent-chat',
        pvcName: 'agent-pvc-chat',
        forwardedAgentSecretProviders: [],
        devModeSnapshots: {},
      };
      mockTeardownSession(chatSession);
      queueReleasedSession(chatSession, { namespace: null });

      await AgentSessionService.releaseWorkspace('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      expect(runtime.destroy).not.toHaveBeenCalled();
      expect(mockDeleteNamespace).toHaveBeenCalledWith('chat-aaaaaaaa');
      // The cleanup claim restamps the winning backend so the stale stamp self-heals.
      expect(sandboxWritePayloads()).toContainEqual(expect.objectContaining({ provider: 'lifecycle_kubernetes' }));
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

  describe('chat preview publication', () => {
    const readyChatSession = {
      id: 321,
      uuid: 'session-1',
      userId: 'user-1',
      sessionKind: AgentSessionKind.CHAT,
      status: 'active',
      chatStatus: AgentChatStatus.READY,
      workspaceStatus: AgentWorkspaceStatus.READY,
      namespace: 'chat-session',
      podName: 'agent-session',
    } as AgentSession;

    it.each([
      [null, 'Session not found'],
      [
        { ...readyChatSession, sessionKind: AgentSessionKind.ENVIRONMENT },
        'HTTP publishing is only supported for chat sessions',
      ],
      [
        { ...readyChatSession, workspaceStatus: AgentWorkspaceStatus.PROVISIONING },
        'Workspace runtime is not ready yet',
      ],
    ])('rejects invalid publication state before endpoint resolution', async (session, message) => {
      mockSessionQuery.findOne.mockResolvedValueOnce(session);
      const resolveEndpointSpy = jest.spyOn(AgentSandboxService, 'resolveWorkspaceGatewayEndpoint');

      await expect(
        AgentSessionService.publishChatHttpPort({ sessionId: 'session-1', userId: 'user-1', port: 3000 })
      ).rejects.toThrow(message);
      expect(resolveEndpointSpy).not.toHaveBeenCalled();
      resolveEndpointSpy.mockRestore();
    });

    it('rejects publication when the ready workspace has no gateway endpoint', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(readyChatSession);
      const resolveEndpointSpy = jest
        .spyOn(AgentSandboxService, 'resolveWorkspaceGatewayEndpoint')
        .mockResolvedValueOnce(null);
      const recordExposureSpy = jest.spyOn(AgentSandboxService, 'recordPreviewExposure');

      await expect(
        AgentSessionService.publishChatHttpPort({ sessionId: 'session-1', userId: 'user-1', port: 3000 })
      ).rejects.toThrow('Workspace gateway endpoint is not available');
      expect(recordExposureSpy).not.toHaveBeenCalled();
      resolveEndpointSpy.mockRestore();
      recordExposureSpy.mockRestore();
    });

    it('publishes the preview with an unhealthy probe result when the upstream is unreachable', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(readyChatSession);
      const resolveEndpointSpy = jest
        .spyOn(AgentSandboxService, 'resolveWorkspaceGatewayEndpoint')
        .mockResolvedValueOnce({ url: 'http://workspace-gateway.test', headers: {} });
      const recordExposureSpy = jest
        .spyOn(AgentSandboxService, 'recordPreviewExposure')
        .mockResolvedValueOnce({} as any);
      const fetchMock = jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('connection refused'));
      const times = [0, 0, 10_000, 10_000, 10_000];
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => times.shift() ?? 10_000);

      const publication = await AgentSessionService.publishChatHttpPort({
        sessionId: 'session-1',
        userId: 'user-1',
        port: 3000,
      });

      expect(publication.upstreamHealth).toMatchObject({
        status: 'unhealthy',
        reachable: false,
        ok: false,
        attempts: 1,
        statusCode: null,
        error: 'connection refused',
        message: 'Preview target did not pass the reachability check before timeout: connection refused.',
      });
      expect(recordExposureSpy).toHaveBeenCalledWith(readyChatSession, {
        port: 3000,
        url: 'http://3000--abcdef1234567890abcdef1234567890.localhost:5001/',
        endpointUrl: 'http://workspace-gateway.test/preview/3000',
        attachmentKind: 'workspace_gateway_preview',
        previewSlug: 'abcdef1234567890abcdef1234567890',
      });
      nowSpy.mockRestore();
      fetchMock.mockRestore();
      resolveEndpointSpy.mockRestore();
      recordExposureSpy.mockRestore();
    });

    it('reports a reachable HTTP failure with its upstream status and no synthetic headers', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(readyChatSession);
      const resolveEndpointSpy = jest
        .spyOn(AgentSandboxService, 'resolveWorkspaceGatewayEndpoint')
        .mockResolvedValueOnce({ url: 'http://workspace-gateway.test' });
      const recordExposureSpy = jest
        .spyOn(AgentSandboxService, 'recordPreviewExposure')
        .mockResolvedValueOnce({} as any);
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        body: null,
      } as Response);
      const times = [0, 10_000, 10_000, 10_000];
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => times.shift() ?? 10_000);

      const publication = await AgentSessionService.publishChatHttpPort({
        sessionId: 'session-1',
        userId: 'user-1',
        port: 3000,
      });

      expect(fetchMock).toHaveBeenCalledWith('http://workspace-gateway.test/preview/3000', {
        method: 'GET',
        headers: {},
        signal: expect.any(AbortSignal),
      });
      expect(publication.upstreamHealth).toMatchObject({
        status: 'unhealthy',
        reachable: true,
        ok: false,
        attempts: 1,
        statusCode: 503,
        statusText: 'Service Unavailable',
        error: null,
        message: 'Preview target did not pass the reachability check before timeout: HTTP 503 Service Unavailable.',
      });
      expect(recordExposureSpy).toHaveBeenCalled();
      nowSpy.mockRestore();
      fetchMock.mockRestore();
      resolveEndpointSpy.mockRestore();
      recordExposureSpy.mockRestore();
    });

    it('retries a transiently unreachable upstream before publishing a healthy result', async () => {
      jest.useFakeTimers();
      mockSessionQuery.findOne.mockResolvedValueOnce(readyChatSession);
      const resolveEndpointSpy = jest
        .spyOn(AgentSandboxService, 'resolveWorkspaceGatewayEndpoint')
        .mockResolvedValueOnce({ url: 'http://workspace-gateway.test', headers: {} });
      const recordExposureSpy = jest
        .spyOn(AgentSandboxService, 'recordPreviewExposure')
        .mockResolvedValueOnce({} as any);
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockRejectedValueOnce('connection reset')
        .mockResolvedValueOnce({
          ok: true,
          status: 204,
          statusText: '',
          body: { cancel: jest.fn().mockRejectedValue(new Error('body already closed')) },
        } as any);

      const publicationPromise = AgentSessionService.publishChatHttpPort({
        sessionId: 'session-1',
        userId: 'user-1',
        port: 3000,
      });

      try {
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(500);

        await expect(publicationPromise).resolves.toMatchObject({
          upstreamHealth: {
            status: 'healthy',
            reachable: true,
            ok: true,
            attempts: 2,
            statusCode: 204,
            statusText: null,
            error: null,
            message: 'Preview target responded with a successful HTTP status.',
          },
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
        fetchMock.mockRestore();
        resolveEndpointSpy.mockRestore();
        recordExposureSpy.mockRestore();
      }
    });

    it('aborts a probe that exceeds the single-attempt timeout before publishing an unhealthy result', async () => {
      jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
      mockSessionQuery.findOne.mockResolvedValueOnce(readyChatSession);
      const resolveEndpointSpy = jest
        .spyOn(AgentSandboxService, 'resolveWorkspaceGatewayEndpoint')
        .mockResolvedValueOnce({ url: 'http://workspace-gateway.test', headers: {} });
      const recordExposureSpy = jest
        .spyOn(AgentSandboxService, 'recordPreviewExposure')
        .mockResolvedValueOnce({} as any);
      const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('probe request aborted')));
          })
      );

      const publicationPromise = AgentSessionService.publishChatHttpPort({
        sessionId: 'session-1',
        userId: 'user-1',
        port: 3000,
      });

      try {
        await jest.advanceTimersByTimeAsync(10_000);

        await expect(publicationPromise).resolves.toMatchObject({
          upstreamHealth: {
            status: 'unhealthy',
            reachable: false,
            ok: false,
            error: 'probe request aborted',
          },
        });
        expect(fetchMock).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
        fetchMock.mockRestore();
        resolveEndpointSpy.mockRestore();
        recordExposureSpy.mockRestore();
      }
    });
  });

  describe('remote chat runtime settlement', () => {
    const hibernatedSession = buildChatRuntimeSession({
      namespace: 'chat-aaaaaaaa',
      podName: 'sbx-123',
      pvcName: null,
      workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
    });

    it('settles a successful remote suspend with the provider-returned handle', async () => {
      const runtime = mockOpenSandboxRuntime();
      const suspendedProviderState = {
        sandboxId: 'snapshot-456',
        lifecycleBaseUrl: 'https://opensandbox.example.test/v1',
      };
      runtime.suspend.mockResolvedValueOnce({
        providerState: suspendedProviderState,
        capabilitySnapshot: { backend: 'opensandbox', hibernateResume: true },
        podNameAlias: 'snapshot-456',
      });
      mockOpenSandboxSandboxRow();
      const readySession = {
        ...hibernatedSession,
        workspaceStatus: AgentWorkspaceStatus.READY,
      };
      const settledSession = {
        ...readySession,
        workspaceStatus: AgentWorkspaceStatus.HIBERNATED,
      };
      mockSessionQuery.findOne.mockResolvedValueOnce(readySession);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(readySession);
      queuePatchedSession(readySession);
      queuePatchedSession(settledSession);

      await expect(
        AgentSessionService.suspendChatRuntime({
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userId: 'sample-user',
        })
      ).resolves.toMatchObject({ workspaceStatus: AgentWorkspaceStatus.HIBERNATED, pvcName: null });

      expect(runtime.suspend).toHaveBeenCalledWith(expect.objectContaining({ sandboxId: 'sbx-123' }), {
        retainForMs: 25 * 60 * 60 * 1000,
      });
      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({
          status: 'suspended',
          provider: 'opensandbox',
          providerState: suspendedProviderState,
          metadata: expect.not.objectContaining({ runtimeLifecycle: expect.any(Object) }),
        })
      );
      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
    });

    it('returns an already-hibernated session without consulting its backend', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(hibernatedSession);
      const deriveSpy = jest.spyOn(AgentSandboxService, 'deriveWorkspaceBackendForAction');

      await expect(
        AgentSessionService.suspendChatRuntime({
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userId: 'sample-user',
        })
      ).resolves.toBe(hibernatedSession);
      expect(deriveSpy).not.toHaveBeenCalled();
      deriveSpy.mockRestore();
    });

    it.each([
      [null, 'Session not found'],
      [{ ...hibernatedSession, status: 'archived' }, 'Only active chat sessions can be suspended'],
    ])('rejects invalid suspend state before backend work', async (session, message) => {
      mockSessionQuery.findOne.mockResolvedValueOnce(session);
      const deriveSpy = jest.spyOn(AgentSandboxService, 'deriveWorkspaceBackendForAction');

      await expect(
        AgentSessionService.suspendChatRuntime({
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userId: 'sample-user',
        })
      ).rejects.toThrow(message);
      expect(deriveSpy).not.toHaveBeenCalled();
      deriveSpy.mockRestore();
    });

    it('rejects a remote suspend when the workspace references are not ready', async () => {
      mockOpenSandboxRuntime();
      mockOpenSandboxSandboxRow();
      const incompleteSession = {
        ...hibernatedSession,
        workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
        namespace: null,
      };
      mockSessionQuery.findOne.mockResolvedValueOnce(incompleteSession);

      await expect(
        AgentSessionService.suspendChatRuntime({
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userId: 'sample-user',
        })
      ).rejects.toThrow('Workspace runtime is not ready');
      expect(mockSessionQuery.patchAndFetchById).not.toHaveBeenCalled();
    });

    it.each([
      [null, 'Session not found'],
      [{ ...hibernatedSession, status: 'archived' }, 'Only active chat sessions can provision a workspace runtime'],
    ])('rejects invalid resume state before backend work', async (session, message) => {
      mockSessionQuery.findOne.mockResolvedValueOnce(session);
      const deriveSpy = jest.spyOn(AgentSandboxService, 'deriveWorkspaceBackendForAction');

      await expect(
        AgentSessionService.resumeChatRuntime({
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userId: 'sample-user',
          userIdentity: { userId: 'sample-user', githubUsername: 'sample-user' } as any,
          githubToken: 'sample-gh-token',
        })
      ).rejects.toThrow(message);
      expect(deriveSpy).not.toHaveBeenCalled();
      deriveSpy.mockRestore();
    });

    it('settles an expired remote runtime and provisions a fresh workspace in the same call', async () => {
      const runtime = mockOpenSandboxRuntime();
      runtime.resume.mockRejectedValueOnce(new WorkspaceRuntimeGoneError('sandbox expired'));
      mockOpenSandboxSandboxRow();
      mockSessionQuery.findOne.mockResolvedValueOnce(hibernatedSession);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(hibernatedSession);
      queuePatchedSession(hibernatedSession);
      queuePatchedSession({
        ...hibernatedSession,
        workspaceStatus: AgentWorkspaceStatus.NONE,
        podName: null,
        pvcName: null,
      });
      const freshSession = {
        ...hibernatedSession,
        workspaceStatus: AgentWorkspaceStatus.READY,
        podName: 'sbx-fresh',
      } as AgentSession;
      const provisionSpy = jest.spyOn(AgentSessionService, 'provisionChatRuntime').mockResolvedValueOnce(freshSession);

      await expect(
        AgentSessionService.resumeChatRuntime({
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userId: 'sample-user',
          userIdentity: { userId: 'sample-user', githubUsername: 'sample-user' } as any,
          githubToken: 'sample-gh-token',
        })
      ).resolves.toBe(freshSession);

      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({
          status: 'ended',
          provider: 'opensandbox',
          metadata: expect.not.objectContaining({ runtimeLifecycle: expect.any(Object) }),
        })
      );
      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      expect(provisionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          failureOrigin: 'chat_runtime',
          failureStage: 'prepare_infrastructure',
          failureRetryable: true,
          workspaceAction: 'provision',
        })
      );
      provisionSpy.mockRestore();
    });

    it('destroys a replacement runtime when persistence fails and records a retryable resume failure', async () => {
      const runtime = mockOpenSandboxRuntime();
      const replacementState = {
        sandboxId: 'sbx-replacement',
        lifecycleBaseUrl: 'https://opensandbox.example.test/v1',
      };
      runtime.resume.mockResolvedValueOnce({
        providerState: replacementState,
        capabilitySnapshot: { backend: 'opensandbox' },
        podNameAlias: 'sbx-replacement',
      });
      mockOpenSandboxSandboxRow();
      mockSessionQuery.findOne.mockResolvedValueOnce(hibernatedSession);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(hibernatedSession);
      queuePatchedSession(hibernatedSession);
      const persistenceError = new Error('state persistence failed');
      mockSessionQuery.patchAndFetchById.mockRejectedValueOnce(persistenceError);
      queuePatchedSession({ ...hibernatedSession, workspaceStatus: AgentWorkspaceStatus.FAILED });

      await expect(
        AgentSessionService.resumeChatRuntime({
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userId: 'sample-user',
          userIdentity: { userId: 'sample-user', githubUsername: 'sample-user' } as any,
          githubToken: 'sample-gh-token',
        })
      ).rejects.toBe(persistenceError);

      expect(runtime.destroy).toHaveBeenCalledWith(replacementState);
      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({
          status: 'failed',
          error: expect.objectContaining({
            stage: 'resume',
            origin: 'resume',
            message: expect.stringContaining('state persistence failed'),
            retryable: true,
          }),
        })
      );
      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });

    it('records remote resume security failures as non-retryable', async () => {
      const runtime = mockOpenSandboxRuntime();
      runtime.resume.mockRejectedValueOnce(new WorkspaceRuntimeSecurityError('gateway did not enforce auth'));
      mockOpenSandboxSandboxRow();
      mockSessionQuery.findOne.mockResolvedValueOnce(hibernatedSession);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(hibernatedSession);
      queuePatchedSession(hibernatedSession);
      queuePatchedSession({ ...hibernatedSession, workspaceStatus: AgentWorkspaceStatus.FAILED });

      await expect(
        AgentSessionService.resumeChatRuntime({
          sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          userId: 'sample-user',
          userIdentity: { userId: 'sample-user', githubUsername: 'sample-user' } as any,
          githubToken: 'sample-gh-token',
        })
      ).rejects.toThrow('gateway did not enforce auth');

      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({
          status: 'failed',
          error: expect.objectContaining({ stage: 'resume', origin: 'resume', retryable: false }),
        })
      );
      expect(runtime.destroy).not.toHaveBeenCalled();
    });
  });

  describe('message readiness', () => {
    it.each([
      [AgentSessionKind.CHAT, AgentChatStatus.READY, AgentWorkspaceStatus.NONE, true],
      [AgentSessionKind.ENVIRONMENT, AgentChatStatus.READY, AgentWorkspaceStatus.READY, true],
      [AgentSessionKind.CHAT, AgentChatStatus.ERROR, AgentWorkspaceStatus.READY, false],
      [AgentSessionKind.ENVIRONMENT, AgentChatStatus.READY, AgentWorkspaceStatus.PROVISIONING, false],
    ])(
      'reports whether %s sessions with chat=%s and workspace=%s can accept messages',
      (sessionKind, chatStatus, workspaceStatus, expected) => {
        expect(
          AgentSessionService.canAcceptMessages({
            sessionKind,
            chatStatus,
            workspaceStatus,
          } as AgentSession)
        ).toBe(expected);
      }
    );

    it.each([
      [
        {
          sessionKind: AgentSessionKind.CHAT,
          status: 'active',
          chatStatus: AgentChatStatus.READY,
          workspaceStatus: AgentWorkspaceStatus.NONE,
        },
        '',
      ],
      [
        {
          sessionKind: AgentSessionKind.ENVIRONMENT,
          status: 'starting',
          chatStatus: AgentChatStatus.READY,
          workspaceStatus: AgentWorkspaceStatus.PROVISIONING,
        },
        'Wait for the session to finish starting before sending a message.',
      ],
      [
        {
          sessionKind: AgentSessionKind.ENVIRONMENT,
          status: 'starting',
          chatStatus: AgentChatStatus.ERROR,
          workspaceStatus: AgentWorkspaceStatus.FAILED,
        },
        'Wait for the session to finish starting before sending a message.',
      ],
      [
        {
          sessionKind: AgentSessionKind.CHAT,
          status: 'error',
          chatStatus: AgentChatStatus.ERROR,
          workspaceStatus: AgentWorkspaceStatus.FAILED,
        },
        'This session is no longer available for new messages.',
      ],
    ])('returns the caller-facing message block reason', (session, expected) => {
      expect(AgentSessionService.getMessageBlockReason(session as AgentSession)).toBe(expected);
    });
  });

  describe('enrichSessions', () => {
    it('returns an empty list without querying builds, deploys, sandboxes, or Redis', async () => {
      await expect(AgentSessionService.enrichSessions([])).resolves.toEqual([]);

      expect(Build.query).not.toHaveBeenCalled();
      expect(Deploy.query).not.toHaveBeenCalled();
      expect(AgentSandbox.query).not.toHaveBeenCalled();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('summarizes current and legacy session metadata using the documented precedence', async () => {
      const builds = [
        {
          uuid: 'build-direct-pr',
          pullRequest: { fullName: 'org/direct-pr', branchName: 'direct-pr-branch' },
          baseBuild: null,
        },
        {
          uuid: 'build-nested-pr',
          pullRequest: { repository: { fullName: 'org/nested-pr' }, branchName: 'nested-pr-branch' },
          baseBuild: null,
        },
        {
          uuid: 'build-direct-base',
          pullRequest: null,
          baseBuild: {
            uuid: 'base-direct',
            pullRequest: { fullName: 'org/direct-base', branchName: 'direct-base-branch' },
          },
        },
        {
          uuid: 'build-nested-base',
          pullRequest: null,
          baseBuild: {
            uuid: 'base-nested',
            pullRequest: { repository: { fullName: 'org/nested-base' }, branchName: 'nested-base-branch' },
          },
        },
      ];
      const liveDeploys = [
        {
          id: 31,
          devModeSessionId: 3,
          deployable: { name: 'live-api' },
          repository: { fullName: 'org/live-repo' },
          branchName: 'live-branch',
        },
        {
          id: 32,
          devModeSessionId: null,
          deployable: { name: 'orphaned-service' },
          repository: { fullName: 'org/orphaned' },
          branchName: 'orphaned-branch',
        },
      ];
      const snapshotDeploys = [
        {
          id: 55,
          devModeSessionId: null,
          deployable: { name: 'snapshot-worker' },
          repository: { fullName: 'org/snapshot-repo' },
          branchName: 'snapshot-branch',
        },
      ];
      const buildWithGraphFetched = jest.fn().mockResolvedValue(builds);
      const buildWhereIn = jest.fn().mockReturnValue({ withGraphFetched: buildWithGraphFetched });
      (Build.query as jest.Mock) = jest.fn().mockReturnValue({ whereIn: buildWhereIn });
      const liveWithGraphFetched = jest.fn().mockResolvedValue(liveDeploys);
      const snapshotWithGraphFetched = jest.fn().mockResolvedValue(snapshotDeploys);
      (Deploy.query as jest.Mock) = jest
        .fn()
        .mockReturnValueOnce({
          whereIn: jest.fn().mockReturnValue({ withGraphFetched: liveWithGraphFetched }),
        })
        .mockReturnValueOnce({
          whereIn: jest.fn().mockReturnValue({ withGraphFetched: snapshotWithGraphFetched }),
        });
      const baseSession = {
        buildUuid: null,
        workspaceRepos: [],
        selectedServices: [],
        devModeSnapshots: {},
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
      };
      const sessions = [
        {
          ...baseSession,
          id: 1,
          uuid: 'workspace-session',
          status: 'active',
          workspaceRepos: [
            { repo: 'org/workspace', branch: 'workspace-branch', mountPath: '/workspace', primary: true },
          ],
          selectedServices: [{ name: 'persisted-api', deployId: 1 }],
        },
        {
          ...baseSession,
          id: 2,
          uuid: 'selected-session',
          status: 'active',
          selectedServices: [{ name: 'selected-web', deployId: 2, repo: 'org/selected', branch: 'selected-branch' }],
        },
        { ...baseSession, id: 3, uuid: 'live-session', status: 'starting' },
        { ...baseSession, id: 4, uuid: 'direct-pr-session', status: 'archived', buildUuid: 'build-direct-pr' },
        { ...baseSession, id: 5, uuid: 'nested-pr-session', status: 'archived', buildUuid: 'build-nested-pr' },
        { ...baseSession, id: 6, uuid: 'direct-base-session', status: 'archived', buildUuid: 'build-direct-base' },
        { ...baseSession, id: 7, uuid: 'nested-base-session', status: 'archived', buildUuid: 'build-nested-base' },
        {
          ...baseSession,
          id: 8,
          uuid: 'snapshot-session',
          status: 'archived',
          devModeSnapshots: { '55': buildDevModeSnapshot('snapshot-worker'), invalid: buildDevModeSnapshot() },
        },
        { ...baseSession, id: 9, uuid: 'empty-session', status: 'archived' },
      ] as unknown as AgentSession[];

      const result = await AgentSessionService.enrichSessions(sessions);
      const byId = new Map(result.map((session) => [session.uuid, session]));

      expect(buildWhereIn).toHaveBeenCalledWith('uuid', [
        'build-direct-pr',
        'build-nested-pr',
        'build-direct-base',
        'build-nested-base',
      ]);
      expect(byId.get('workspace-session')).toMatchObject({
        id: 'workspace-session',
        repo: 'org/workspace',
        branch: 'workspace-branch',
        services: ['persisted-api'],
        startupFailure: null,
      });
      expect(byId.get('selected-session')).toMatchObject({
        repo: 'org/selected',
        branch: 'selected-branch',
        services: ['selected-web'],
      });
      expect(byId.get('live-session')).toMatchObject({
        repo: 'org/live-repo',
        branch: 'live-branch',
        services: ['live-api'],
      });
      expect(byId.get('direct-pr-session')).toMatchObject({
        repo: 'org/direct-pr',
        branch: 'direct-pr-branch',
        baseBuildUuid: null,
      });
      expect(byId.get('nested-pr-session')).toMatchObject({
        repo: 'org/nested-pr',
        branch: 'nested-pr-branch',
      });
      expect(byId.get('direct-base-session')).toMatchObject({
        repo: 'org/direct-base',
        branch: 'direct-base-branch',
        baseBuildUuid: 'base-direct',
      });
      expect(byId.get('nested-base-session')).toMatchObject({
        repo: 'org/nested-base',
        branch: 'nested-base-branch',
        baseBuildUuid: 'base-nested',
      });
      expect(byId.get('snapshot-session')).toMatchObject({
        repo: 'org/snapshot-repo',
        branch: 'snapshot-branch',
        services: ['snapshot-worker'],
      });
      expect(byId.get('empty-session')).toMatchObject({
        repo: null,
        branch: null,
        services: [],
      });
      expect(liveWithGraphFetched).toHaveBeenCalledWith('[deployable, repository]');
      expect(snapshotWithGraphFetched).toHaveBeenCalledWith('[deployable, repository]');
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('prefers the newest durable sandbox failure and only consults Redis for missing durable failures', async () => {
      const durableFailure = {
        stage: 'attach_services',
        title: 'Durable failure',
        message: 'service failed',
        recordedAt: '2026-08-25T10:00:00.000Z',
        retryable: false,
        origin: 'agent_session',
      };
      const sandboxRows = [
        { sessionId: 1, status: 'failed', error: durableFailure },
        {
          sessionId: 1,
          status: 'failed',
          error: { ...durableFailure, title: 'Older durable failure', recordedAt: '2026-08-24T10:00:00.000Z' },
        },
        { sessionId: 2, status: 'failed', error: null },
      ];
      const secondOrderBy = jest.fn().mockResolvedValue(sandboxRows);
      const firstOrderBy = jest.fn().mockReturnValue({ orderBy: secondOrderBy });
      const whereIn = jest.fn().mockReturnValue({ orderBy: firstOrderBy });
      (AgentSandbox.query as jest.Mock) = jest.fn().mockReturnValue({ whereIn });
      mockRedis.get.mockImplementation(async (key: string) =>
        key.endsWith(':error-redis')
          ? JSON.stringify({
              sessionId: 'error-redis',
              stage: 'connect_runtime',
              title: 'Redis failure',
              message: 'runtime failed',
              recordedAt: '2026-08-26T10:00:00.000Z',
            })
          : null
      );
      const sessions = [
        { id: 1, uuid: 'error-durable', status: 'error', buildUuid: null, devModeSnapshots: {} },
        { id: 2, uuid: 'error-legacy', status: 'error', buildUuid: null, devModeSnapshots: {} },
        { id: 3, uuid: 'error-redis', status: 'error', buildUuid: null, devModeSnapshots: {} },
      ] as AgentSession[];

      const result = await AgentSessionService.enrichSessions(sessions);

      expect(whereIn).toHaveBeenCalledWith('sessionId', [1, 2, 3]);
      expect(result[0].startupFailure).toMatchObject({ title: 'Durable failure', origin: 'agent_session' });
      expect(result[1].startupFailure).toMatchObject({ origin: 'legacy', retryable: false });
      expect(result[2].startupFailure).toMatchObject({ title: 'Redis failure', origin: 'agent_session' });
      expect(mockRedis.get).toHaveBeenCalledTimes(1);
      expect(mockRedis.get).toHaveBeenCalledWith('lifecycle:agent:session:startup-failure:error-redis');
    });

    it('falls back to Redis when the durable failure lookup is unavailable', async () => {
      const secondOrderBy = jest.fn().mockRejectedValue(new Error('sandbox table unavailable'));
      const firstOrderBy = jest.fn().mockReturnValue({ orderBy: secondOrderBy });
      (AgentSandbox.query as jest.Mock) = jest.fn().mockReturnValue({
        whereIn: jest.fn().mockReturnValue({ orderBy: firstOrderBy }),
      });
      mockRedis.get.mockResolvedValue(
        JSON.stringify({
          sessionId: 'error-session',
          stage: 'connect_runtime',
          title: 'Redis fallback',
          message: 'runtime failed',
          recordedAt: '2026-08-26T10:00:00.000Z',
        })
      );

      const [result] = await AgentSessionService.enrichSessions([
        { id: 1, uuid: 'error-session', status: 'error', buildUuid: null, devModeSnapshots: {} } as AgentSession,
      ]);

      expect(result.startupFailure).toMatchObject({ title: 'Redis fallback', origin: 'agent_session' });
    });

    it('returns an enriched error session when both failure stores are unavailable', async () => {
      const secondOrderBy = jest.fn().mockRejectedValue(new Error('sandbox table unavailable'));
      const firstOrderBy = jest.fn().mockReturnValue({ orderBy: secondOrderBy });
      (AgentSandbox.query as jest.Mock) = jest.fn().mockReturnValue({
        whereIn: jest.fn().mockReturnValue({ orderBy: firstOrderBy }),
      });
      mockRedis.get.mockRejectedValueOnce(new Error('redis unavailable'));

      const [result] = await AgentSessionService.enrichSessions([
        { id: 1, uuid: 'error-session', status: 'error', buildUuid: null, devModeSnapshots: {} } as AgentSession,
      ]);

      expect(result).toMatchObject({ uuid: 'error-session', startupFailure: null });
      expect(mockRedis.get).toHaveBeenCalledWith('lifecycle:agent:session:startup-failure:error-session');
    });
  });

  describe('active environment session lookup', () => {
    it('returns null when the environment has no active session', async () => {
      mockSessionQuery.first.mockResolvedValueOnce(null);

      await expect(AgentSessionService.getEnvironmentActiveSession('build-123', 'viewer')).resolves.toBeNull();
      expect(mockSessionQuery.where).toHaveBeenCalledWith({
        buildUuid: 'build-123',
        buildKind: BuildKind.ENVIRONMENT,
      });
      expect(mockSessionQuery.whereIn).toHaveBeenCalledWith('status', ['starting', 'active']);
    });

    it.each([
      ['owner-user', 'session-owner', true],
      ['other-user', null, false],
    ])('only reveals the active session id to its owner', async (viewerUserId, expectedId, ownedByCurrentUser) => {
      mockSessionQuery.first.mockResolvedValueOnce({
        uuid: 'session-owner',
        userId: 'owner-user',
        ownerGithubUsername: 'owner-handle',
        status: 'active',
      });

      await expect(AgentSessionService.getEnvironmentActiveSession('build-123', viewerUserId)).resolves.toEqual({
        id: expectedId,
        status: 'active',
        ownerGithubUsername: 'owner-handle',
        ownedByCurrentUser,
      });
    });

    it('uses the non-identifying conflict message when the owner has no GitHub username', () => {
      const error = new ActiveEnvironmentSessionError({
        id: null,
        status: 'active',
        ownerGithubUsername: null,
        ownedByCurrentUser: false,
      });

      expect(error.name).toBe('ActiveEnvironmentSessionError');
      expect(error.message).toBe(
        'An active environment session is already running for this environment. Fork the environment into a sandbox instead.'
      );
      expect(error.activeSession).toMatchObject({ id: null, ownedByCurrentUser: false });
    });
  });

  describe('session revival and workspace retention', () => {
    it('rejects unarchive when the user does not own the session', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(null);

      await expect(AgentSessionService.unarchiveSession('missing', 'user-1')).rejects.toThrow('Session not found');
      expect(mockSessionQuery.patchAndFetchById).not.toHaveBeenCalled();
    });

    it('returns an already-live session without writing it', async () => {
      const activeSession = { id: 1, uuid: 'session-1', userId: 'user-1', status: 'active' } as AgentSession;
      mockSessionQuery.findOne.mockResolvedValueOnce(activeSession);

      await expect(AgentSessionService.unarchiveSession('session-1', 'user-1')).resolves.toBe(activeSession);
      expect(mockSessionQuery.patchAndFetchById).not.toHaveBeenCalled();
    });

    it('restores an archived session and records its source state', async () => {
      const archivedSession = {
        id: 321,
        uuid: 'session-1',
        userId: 'user-1',
        status: 'archived',
        chatStatus: AgentChatStatus.READY,
      } as AgentSession;
      const restoredSession = { ...archivedSession, status: 'active', archivedAt: null } as AgentSession;
      mockSessionQuery.findOne.mockResolvedValueOnce(archivedSession);
      mockSessionQuery.patchAndFetchById.mockResolvedValueOnce(restoredSession);
      mockSourceQuery.findOne.mockResolvedValueOnce(null);

      await expect(AgentSessionService.unarchiveSession('session-1', 'user-1')).resolves.toBe(restoredSession);
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(
        321,
        expect.objectContaining({
          status: 'active',
          chatStatus: AgentChatStatus.READY,
          archivedAt: null,
          lastActivity: expect.any(String),
        })
      );
      expect(mockSourceQuery.findOne).toHaveBeenCalledWith({ sessionId: 321 });
    });

    it('turns an environment uniqueness conflict into the public active-session error', async () => {
      const archivedSession = {
        id: 321,
        uuid: 'session-1',
        userId: 'user-1',
        status: 'archived',
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildUuid: 'build-123',
      } as AgentSession;
      const uniqueError = Object.assign(new Error('duplicate session'), {
        code: '23505',
        constraint: 'agent_sessions_active_environment_build_unique',
      });
      const activeSessionQuery = {
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          uuid: 'active-session',
          userId: 'other-user',
          ownerGithubUsername: 'other-owner',
          status: 'active',
        }),
      };
      (AgentSession.query as jest.Mock) = jest
        .fn()
        .mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(archivedSession) })
        .mockReturnValueOnce({ patchAndFetchById: jest.fn().mockRejectedValue(uniqueError) })
        .mockReturnValueOnce(activeSessionQuery);

      await expect(AgentSessionService.unarchiveSession('session-1', 'user-1')).rejects.toMatchObject({
        name: 'ActiveEnvironmentSessionError',
        message: expect.stringContaining('other-owner'),
        activeSession: {
          id: null,
          status: 'active',
          ownerGithubUsername: 'other-owner',
          ownedByCurrentUser: false,
        },
      });
    });

    it('preserves the database error when a uniqueness conflict has no discoverable active session', async () => {
      const archivedSession = {
        id: 321,
        uuid: 'session-1',
        userId: 'user-1',
        status: 'archived',
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildUuid: 'build-123',
      } as AgentSession;
      const uniqueError = Object.assign(new Error('duplicate session'), {
        code: '23505',
        constraint: 'agent_sessions_active_environment_build_unique',
      });
      const activeSessionQuery = {
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(null),
      };
      (AgentSession.query as jest.Mock) = jest
        .fn()
        .mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(archivedSession) })
        .mockReturnValueOnce({ patchAndFetchById: jest.fn().mockRejectedValue(uniqueError) })
        .mockReturnValueOnce(activeSessionQuery);

      await expect(AgentSessionService.unarchiveSession('session-1', 'user-1')).rejects.toBe(uniqueError);
    });

    it('does not rewrite an unchanged keep-workspace preference', async () => {
      const session = { id: 1, uuid: 'session-1', userId: 'user-1', keepWorkspace: true } as AgentSession;
      mockSessionQuery.findOne.mockResolvedValueOnce(session);

      await expect(AgentSessionService.setKeepWorkspace('session-1', 'user-1', true)).resolves.toBe(session);
      expect(mockSessionQuery.patchAndFetchById).not.toHaveBeenCalled();
    });

    it('updates the keep-workspace preference for an owned session', async () => {
      const session = { id: 1, uuid: 'session-1', userId: 'user-1', keepWorkspace: false } as AgentSession;
      const updated = { ...session, keepWorkspace: true } as AgentSession;
      mockSessionQuery.findOne.mockResolvedValueOnce(session);
      mockSessionQuery.patchAndFetchById.mockResolvedValueOnce(updated);

      await expect(AgentSessionService.setKeepWorkspace('session-1', 'user-1', true)).resolves.toBe(updated);
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenCalledWith(1, { keepWorkspace: true });
    });

    it('rejects keep-workspace updates for a missing session', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(null);

      await expect(AgentSessionService.setKeepWorkspace('missing', 'user-1', true)).rejects.toThrow(
        'Session not found'
      );
      expect(mockSessionQuery.patchAndFetchById).not.toHaveBeenCalled();
    });

    it('returns live sessions as-is and delegates archived sessions to unarchive', async () => {
      const liveSession = { id: 1, uuid: 'live', status: 'active' } as AgentSession;
      await expect(AgentSessionService.ensureSessionActive(liveSession, 'user-1')).resolves.toBe(liveSession);

      const archivedSession = { id: 2, uuid: 'archived', status: 'archived' } as AgentSession;
      const restoredSession = { ...archivedSession, status: 'active' } as AgentSession;
      const unarchiveSpy = jest.spyOn(AgentSessionService, 'unarchiveSession').mockResolvedValueOnce(restoredSession);
      await expect(AgentSessionService.ensureSessionActive(archivedSession, 'user-1')).resolves.toBe(restoredSession);
      expect(unarchiveSpy).toHaveBeenCalledWith('archived', 'user-1');
      unarchiveSpy.mockRestore();
    });
  });

  describe('chat runtime public state validation', () => {
    const runtimeOptions = {
      sessionId: 'session-1',
      userId: 'user-1',
      userIdentity: { userId: 'user-1', githubUsername: 'owner' } as any,
      githubToken: 'github-token',
    };

    it('rejects opening a missing session before runtime side effects', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(null);

      await expect(AgentSessionService.openChatRuntime(runtimeOptions)).rejects.toThrow('Session not found');
      expect(mockResolveWorkspaceRuntimePlan).not.toHaveBeenCalled();
    });

    it.each([
      [AgentSessionKind.ENVIRONMENT, 'active', 'Runtime provisioning is only supported for chat sessions'],
      [AgentSessionKind.CHAT, 'archived', 'Only active chat sessions can provision a workspace runtime'],
    ])('rejects opening a %s/%s session before runtime side effects', async (sessionKind, status, message) => {
      mockSessionQuery.findOne.mockResolvedValueOnce(
        buildChatRuntimeSession({ sessionKind, status, workspaceStatus: AgentWorkspaceStatus.NONE })
      );

      await expect(AgentSessionService.openChatRuntime(runtimeOptions)).rejects.toThrow(message);
      expect(mockResolveWorkspaceRuntimePlan).not.toHaveBeenCalled();
    });

    it('reports an idle provisioning row as already provisioning', async () => {
      const session = buildChatRuntimeSession({ workspaceStatus: AgentWorkspaceStatus.PROVISIONING });
      mockSessionQuery.findOne.mockResolvedValueOnce(session);
      const activeActionSpy = jest
        .spyOn(WorkspaceRuntimeStateService, 'assertNoActiveWorkspaceAction')
        .mockResolvedValueOnce(undefined);

      await expect(AgentSessionService.openChatRuntime(runtimeOptions)).rejects.toThrow(
        'Workspace runtime is already provisioning'
      );
      expect(activeActionSpy).toHaveBeenCalledWith(321);
      expect(mockResolveWorkspaceRuntimePlan).not.toHaveBeenCalled();
      activeActionSpy.mockRestore();
    });

    it.each([
      [null, 'Session not found'],
      [
        buildChatRuntimeSession({ sessionKind: AgentSessionKind.SANDBOX }),
        'Runtime provisioning is only supported for chat sessions',
      ],
      [buildChatRuntimeSession({ status: 'archived' }), 'Only active chat sessions can provision a workspace runtime'],
    ])('rejects direct provisioning before any infrastructure work', async (session, message) => {
      mockSessionQuery.findOne.mockResolvedValueOnce(session);

      await expect(AgentSessionService.provisionChatRuntime(runtimeOptions)).rejects.toThrow(message);
      expect(mockResolveWorkspaceRuntimePlan).not.toHaveBeenCalled();
      expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    });

    it('reports an idle provisioning row during direct provisioning', async () => {
      const session = buildChatRuntimeSession({ workspaceStatus: AgentWorkspaceStatus.PROVISIONING });
      mockSessionQuery.findOne.mockResolvedValueOnce(session);
      const activeActionSpy = jest
        .spyOn(WorkspaceRuntimeStateService, 'assertNoActiveWorkspaceAction')
        .mockResolvedValueOnce(undefined);

      await expect(AgentSessionService.provisionChatRuntime(runtimeOptions)).rejects.toThrow(
        'Workspace runtime is already provisioning'
      );
      expect(activeActionSpy).toHaveBeenCalledWith(321);
      expect(mockResolveWorkspaceRuntimePlan).not.toHaveBeenCalled();
      activeActionSpy.mockRestore();
    });

    it('returns a ready Kubernetes runtime without reprovisioning it', async () => {
      const readySession = buildChatRuntimeSession({
        namespace: 'chat-session',
        podName: 'agent-session',
        pvcName: 'agent-pvc-session',
        workspaceStatus: AgentWorkspaceStatus.READY,
      });
      mockSessionQuery.findOne.mockResolvedValueOnce(readySession);

      await expect(AgentSessionService.provisionChatRuntime(runtimeOptions)).resolves.toBe(readySession);
      expect(mockResolveWorkspaceRuntimePlan).not.toHaveBeenCalled();
      expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
      expect(mockSourceQuery.findOne).not.toHaveBeenCalled();
    });

    it('clears a failed network-policy setup so the same namespace can be retried', async () => {
      const chatSession = buildChatRuntimeSession({
        id: 432,
        uuid: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
        userId: 'user-1',
      });
      const readySession = {
        ...chatSession,
        namespace: 'chat-bbbbbbbb',
        podName: 'agent-bbbbbbbb',
        pvcName: 'agent-pvc-bbbbbbbb',
        workspaceStatus: AgentWorkspaceStatus.READY,
      };
      mockSessionQuery.findOne
        .mockResolvedValueOnce(chatSession)
        .mockResolvedValueOnce(chatSession)
        .mockResolvedValueOnce(readySession);
      mockSessionQuery.forUpdate.mockResolvedValue(chatSession);
      queuePatchedSession(chatSession);
      queuePatchedSession({ ...chatSession, workspaceStatus: AgentWorkspaceStatus.FAILED });
      queuePatchedSession(chatSession);
      queuePatchedSession(readySession);
      const createNetworkPolicy = jest.fn().mockRejectedValueOnce({ statusCode: 500, message: 'network API failed' });
      const k8sMock = jest.requireMock('@kubernetes/client-node');
      k8sMock.KubeConfig.mockImplementationOnce(() => ({
        loadFromDefault: jest.fn(),
        makeApiClient: jest.fn().mockReturnValue({ createNamespacedNetworkPolicy: createNetworkPolicy }),
      }));
      const retryOptions = {
        ...runtimeOptions,
        sessionId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      };

      await expect(AgentSessionService.provisionChatRuntime(retryOptions)).rejects.toMatchObject({
        statusCode: 500,
      });
      expect(createNetworkPolicy).toHaveBeenCalledTimes(1);

      await expect(AgentSessionService.provisionChatRuntime(retryOptions)).resolves.toMatchObject({
        workspaceStatus: AgentWorkspaceStatus.READY,
        namespace: 'chat-bbbbbbbb',
      });
      expect(buildAgentNetworkPolicy).toHaveBeenCalledTimes(2);
    });

    it('provisions without gateway-token enforcement when Kubernetes token minting is disabled', async () => {
      const chatSession = buildChatRuntimeSession({
        id: 433,
        uuid: 'cccccccc-dddd-eeee-ffff-000000000000',
        userId: 'user-1',
      });
      const readySession = {
        ...chatSession,
        namespace: 'chat-cccccccc',
        podName: 'agent-cccccccc',
        pvcName: 'agent-pvc-cccccccc',
        workspaceStatus: AgentWorkspaceStatus.READY,
      };
      mockSessionQuery.findOne.mockResolvedValueOnce(chatSession).mockResolvedValueOnce(readySession);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
      queuePatchedSession(chatSession);
      queuePatchedSession(readySession);
      const encryptionMock = jest.requireMock('server/lib/encryption');
      encryptionMock.isEncryptionKeyConfigured.mockReturnValueOnce(false);

      await expect(
        AgentSessionService.provisionChatRuntime({
          ...runtimeOptions,
          sessionId: 'cccccccc-dddd-eeee-ffff-000000000000',
        })
      ).resolves.toMatchObject({ workspaceStatus: AgentWorkspaceStatus.READY });

      const podEnv = (createAgentApiKeySecret as jest.Mock).mock.calls[0][6] as Record<string, string>;
      expect(podEnv).toEqual({ LIFECYCLE_SESSION_MCP_CONFIG_JSON: '[]' });
      expect(sandboxWritePayloads()).toContainEqual(
        expect.objectContaining({
          status: 'ready',
          providerState: expect.not.objectContaining({ gatewayToken: expect.anything() }),
        })
      );
    });

    it('passes the normalized persisted workspace storage request into runtime planning', async () => {
      const chatSession = buildChatRuntimeSession();
      const planError = new Error('runtime plan unavailable');
      mockSessionQuery.findOne.mockResolvedValueOnce(chatSession);
      mockSourceQuery.findOne.mockResolvedValueOnce({
        id: 91,
        sessionId: 321,
        input: { workspace: { storageSize: ' 10Gi ' } },
      });
      mockResolveWorkspaceRuntimePlan.mockImplementationOnce(async (input: Record<string, unknown>) => {
        expect(input.workspaceStorageSize).toBe('10Gi');
        throw planError;
      });
      queuePatchedSession({ ...chatSession, workspaceStatus: AgentWorkspaceStatus.FAILED });
      const recordFailureSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure');

      await expect(AgentSessionService.provisionChatRuntime(runtimeOptions)).rejects.toBe(planError);

      expect(recordFailureSpy).toHaveBeenCalledWith(
        321,
        expect.objectContaining({
          workspaceStorage: undefined,
          failure: expect.objectContaining({ stage: 'prepare_infrastructure' }),
        }),
        {}
      );
      recordFailureSpy.mockRestore();
    });

    it('passes no storage override when the persisted source has no workspace settings', async () => {
      const chatSession = buildChatRuntimeSession();
      const planError = new Error('runtime plan unavailable');
      mockSessionQuery.findOne.mockResolvedValueOnce(chatSession);
      mockSourceQuery.findOne.mockResolvedValueOnce({
        id: 91,
        sessionId: 321,
        input: { initialPrompt: 'Inspect the service' },
      });
      mockResolveWorkspaceRuntimePlan.mockImplementationOnce(async (input: Record<string, unknown>) => {
        expect(input.workspaceStorageSize).toBeNull();
        throw planError;
      });
      queuePatchedSession({ ...chatSession, workspaceStatus: AgentWorkspaceStatus.FAILED });

      await expect(AgentSessionService.provisionChatRuntime(runtimeOptions)).rejects.toBe(planError);
      expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    });

    it('continues runtime planning without a storage override when source lookup fails', async () => {
      const chatSession = buildChatRuntimeSession();
      const planError = new Error('runtime plan unavailable');
      mockSessionQuery.findOne.mockResolvedValueOnce(chatSession);
      mockSourceQuery.findOne.mockRejectedValueOnce(new Error('source database unavailable'));
      mockResolveWorkspaceRuntimePlan.mockImplementationOnce(async (input: Record<string, unknown>) => {
        expect(input.workspaceStorageSize).toBeNull();
        throw planError;
      });
      queuePatchedSession({ ...chatSession, workspaceStatus: AgentWorkspaceStatus.FAILED });

      await expect(AgentSessionService.provisionChatRuntime(runtimeOptions)).rejects.toBe(planError);

      expect(mockResolveWorkspaceRuntimePlan).toHaveBeenCalledTimes(1);
      expect(mockCreateOrUpdateNamespace).not.toHaveBeenCalled();
    });

    it('deletes a stale chat namespace and excludes secret-backed values from the plain secret payload', async () => {
      const chatSession = buildChatRuntimeSession({
        namespace: 'stale-chat-namespace',
        workspaceStatus: AgentWorkspaceStatus.FAILED,
      });
      const readySession = {
        ...chatSession,
        namespace: 'chat-aaaaaaaa',
        podName: 'agent-aaaaaaaa',
        pvcName: 'agent-pvc-aaaaaaaa',
        workspaceStatus: AgentWorkspaceStatus.READY,
      };
      mockSessionQuery.findOne.mockResolvedValueOnce(chatSession).mockResolvedValueOnce(readySession);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
      queuePatchedSession(chatSession);
      queuePatchedSession(readySession);
      (applyForwardedAgentEnvSecrets as jest.Mock).mockResolvedValueOnce({
        env: {
          PLAIN_SETTING: 'plain-value',
          SECRET_SETTING: 'resolved-secret-value',
        },
        secretRefs: [
          {
            envKey: 'SECRET_SETTING',
            secretName: 'forwarded-agent-env',
            secretKey: 'secret-setting',
          },
        ],
        secretProviders: ['example-provider'],
        secretServiceName: 'agent-env-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      });

      await expect(AgentSessionService.provisionChatRuntime(runtimeOptions)).resolves.toBe(readySession);

      expect(mockDeleteNamespace).toHaveBeenCalledWith('stale-chat-namespace');
      expect(createAgentApiKeySecret).toHaveBeenCalledWith(
        'chat-aaaaaaaa',
        'agent-secret-aaaaaaaa',
        expect.any(Object),
        'github-token',
        undefined,
        { PLAIN_SETTING: 'plain-value' },
        expect.any(Object)
      );
      expect(createSessionWorkspacePod).toHaveBeenCalledWith(
        expect.objectContaining({
          forwardedAgentEnv: expect.objectContaining({
            SECRET_SETTING: 'resolved-secret-value',
          }),
          forwardedAgentSecretRefs: [expect.objectContaining({ envKey: 'SECRET_SETTING' })],
        })
      );
    });

    it('cleans up Kubernetes resources when the ready session row disappears after provisioning', async () => {
      const chatSession = buildChatRuntimeSession();
      mockSessionQuery.findOne.mockResolvedValueOnce(chatSession).mockResolvedValueOnce(null);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
      queuePatchedSession(chatSession);
      queuePatchedSession({ ...chatSession, workspaceStatus: AgentWorkspaceStatus.READY });

      await expect(AgentSessionService.provisionChatRuntime(runtimeOptions)).rejects.toThrow(
        'Session not found after runtime provisioning'
      );

      expect(deleteSessionWorkspacePod).toHaveBeenCalledWith('chat-aaaaaaaa', 'agent-aaaaaaaa');
      expect(deleteSessionWorkspaceService).toHaveBeenCalledWith('chat-aaaaaaaa', 'agent-aaaaaaaa');
      expect(deleteAgentApiKeySecret).toHaveBeenCalledWith('chat-aaaaaaaa', 'agent-secret-aaaaaaaa');
      expect(deleteAgentPvc).toHaveBeenCalledWith('chat-aaaaaaaa', 'agent-pvc-aaaaaaaa');
      expect(mockDeleteNamespace).toHaveBeenCalledWith('chat-aaaaaaaa');
    });

    it('reports a remote provisioning failure when its ready session row disappears', async () => {
      const runtime = mockOpenSandboxRuntime();
      runtime.provision.mockResolvedValueOnce({
        providerState: {
          sandboxId: 'sbx-ready-but-session-missing',
          lifecycleBaseUrl: 'https://opensandbox.example.test/v1',
        },
        capabilitySnapshot: { backend: 'opensandbox' },
        podNameAlias: 'sbx-ready-but-session-missing',
      });
      mockResolveWorkspaceRuntimePlan.mockResolvedValueOnce(
        buildRuntimePlan({
          kind: 'chat',
          namespace: 'chat-aaaaaaaa',
          runtimeConfig: {
            workspaceBackend: buildWorkspaceBackendConfig('opensandbox'),
          } as Partial<WorkspaceRuntimePlan>['runtimeConfig'],
          servicePlan: { workspaceRepos: [], services: undefined, selectedServices: [] },
        })
      );
      const chatSession = buildChatRuntimeSession();
      mockSessionQuery.findOne.mockResolvedValueOnce(chatSession).mockResolvedValueOnce(null);
      mockSessionQuery.forUpdate.mockResolvedValueOnce(chatSession);
      queuePatchedSession(chatSession);
      queuePatchedSession({
        ...chatSession,
        namespace: 'chat-aaaaaaaa',
        podName: 'sbx-ready-but-session-missing',
        workspaceStatus: AgentWorkspaceStatus.READY,
      });
      const recordFailureSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure');

      await expect(AgentSessionService.provisionChatRuntime(runtimeOptions)).rejects.toThrow(
        'Session not found after runtime provisioning'
      );

      expect(runtime.destroy).not.toHaveBeenCalled();
      expect(recordFailureSpy).toHaveBeenCalledWith(
        321,
        expect.objectContaining({
          failure: expect.objectContaining({ message: expect.stringContaining('Session not found') }),
        }),
        expect.objectContaining({
          expectedLifecycle: expect.objectContaining({ action: 'provision' }),
        })
      );
      expectNoCreateSessionKubernetesHelpersCalled();
      recordFailureSpy.mockRestore();
    });
  });

  describe('attachServices public preconditions', () => {
    const attachableSession = {
      id: 321,
      uuid: 'session-1',
      status: 'active',
      sessionKind: AgentSessionKind.ENVIRONMENT,
      buildKind: BuildKind.ENVIRONMENT,
      buildUuid: 'build-123',
      namespace: 'test-ns',
      podName: 'agent-session',
      pvcName: 'agent-pvc-session',
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
      skillPlan: { version: 1, skills: [] },
    } as unknown as AgentSession;
    const webCandidate = {
      name: 'web',
      type: 'github',
      deployId: 11,
      devConfig: { image: 'node:20', command: 'pnpm dev' },
      repo: 'example-org/example-repo',
      branch: 'feature/current',
      revision: '0123456789abcdef0123456789abcdef01234567',
      baseDeploy: { id: 11, uuid: 'web-build-uuid' },
    };

    it('treats an empty service request as a no-op without loading the session', async () => {
      await expect(AgentSessionService.attachServices('session-1', [])).resolves.toBeUndefined();

      expect(mockSessionQuery.findOne).not.toHaveBeenCalled();
      expect(loadAgentSessionServiceCandidates).not.toHaveBeenCalled();
    });

    it('rejects a missing session without loading service candidates', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(null);

      await expect(AgentSessionService.attachServices('missing', ['web'])).rejects.toThrow('Session not found');
      expect(loadAgentSessionServiceCandidates).not.toHaveBeenCalled();
    });

    it.each([
      [{ status: 'archived' }, 'Only active sessions can connect services'],
      [
        { buildKind: BuildKind.SANDBOX },
        'Connecting services after startup is only supported for environment sessions',
      ],
      [{ buildUuid: null }, 'Session build context is missing'],
      [{ namespace: null }, 'Session runtime is not ready for service attachment'],
      [{ workspaceRepos: [] }, 'Connecting services after startup is only supported for single-repo sessions'],
      [
        {
          workspaceRepos: [{ repo: '', branch: 'feature/current', mountPath: '/workspace', primary: true }],
        },
        'Session workspace repository metadata is missing',
      ],
    ])('rejects invalid session attachment state before candidate resolution', async (overrides, message) => {
      mockSessionQuery.findOne.mockResolvedValueOnce({ ...attachableSession, ...overrides });

      await expect(AgentSessionService.attachServices('session-1', ['web'])).rejects.toThrow(message);
      expect(loadAgentSessionServiceCandidates).not.toHaveBeenCalled();
      expect(mockEnableDevMode).not.toHaveBeenCalled();
    });

    it('returns without side effects when every requested deploy is already attached', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce({
        ...attachableSession,
        selectedServices: [{ name: 'web', deployId: 11 }],
        devModeSnapshots: {
          '12': buildDevModeSnapshot('worker'),
          invalid: buildDevModeSnapshot('ignored'),
        },
      });
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValueOnce([
        webCandidate,
        { ...webCandidate, name: 'worker', deployId: 12, baseDeploy: { id: 12, uuid: 'worker-build-uuid' } },
      ]);

      await expect(AgentSessionService.attachServices('session-1', ['web', 'worker'])).resolves.toBeUndefined();

      expect(loadAgentSessionServiceCandidates).toHaveBeenCalledWith('build-123');
      expect(mockEnableDevMode).not.toHaveBeenCalled();
      expect(mockSessionQuery.patch).not.toHaveBeenCalled();
    });

    it('preserves previously selected services when attaching another service', async () => {
      const existingSelection = {
        name: 'api',
        deployId: 10,
        repo: 'example-org/example-repo',
        branch: 'feature/current',
        revision: null,
        resourceName: 'api-build-uuid',
        workspacePath: '/workspace',
        workDir: '/workspace',
      };
      mockSessionQuery.findOne.mockResolvedValueOnce({
        ...attachableSession,
        selectedServices: [existingSelection],
      });
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValueOnce([webCandidate]);

      await expect(AgentSessionService.attachServices('session-1', ['web'])).resolves.toBeUndefined();

      expect(mockSessionQuery.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedServices: [
            existingSelection,
            expect.objectContaining({
              name: 'web',
              deployId: 11,
              repo: 'example-org/example-repo',
              branch: 'feature/current',
            }),
          ],
        })
      );
      expect(mockEnableDevMode).toHaveBeenCalledTimes(1);
    });

    it('persists one service selection when the same valid service is requested twice', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(attachableSession);
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValueOnce([webCandidate]);

      await expect(AgentSessionService.attachServices('session-1', ['web', 'web'])).resolves.toBeUndefined();

      const sessionPatch = mockSessionQuery.patch.mock.calls.at(-1)?.[0] as {
        selectedServices?: Array<{ deployId: number }>;
      };
      expect(sessionPatch.selectedServices?.filter((service) => service.deployId === 11)).toHaveLength(1);
      expect(mockEnableDevMode).toHaveBeenCalled();
    });

    it('rejects attachment when same-node placement is required but the agent pod has no node', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce({
        ...attachableSession,
        keepAttachedServicesOnSessionNode: true,
      });
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValueOnce([webCandidate]);
      const k8sMock = jest.requireMock('@kubernetes/client-node');
      k8sMock.KubeConfig.mockImplementationOnce(() => ({
        loadFromDefault: jest.fn(),
        makeApiClient: jest.fn().mockReturnValue({
          readNamespacedPod: jest.fn().mockResolvedValue({ body: { spec: {} } }),
        }),
      }));

      await expect(AgentSessionService.attachServices('session-1', ['web'])).rejects.toThrow(
        'Session workspace pod agent-session did not report a scheduled node'
      );
      expect(mockEnableDevMode).not.toHaveBeenCalled();
      expect(mockSessionQuery.patch).not.toHaveBeenCalled();
    });

    it('surfaces the workspace install command stderr and does not enable the service', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(attachableSession);
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValueOnce([
        {
          ...webCandidate,
          devConfig: {
            ...webCandidate.devConfig,
            installCommand: 'cd /workspace && pnpm install',
          },
        },
      ]);
      mockExecInPod.mockImplementationOnce(
        async (
          _namespace: string,
          _podName: string,
          _containerName: string,
          _command: string[],
          stdout: NodeJS.WritableStream,
          stderr: NodeJS.WritableStream,
          _stdin: unknown,
          _tty: boolean,
          statusCallback?: (status: Record<string, unknown>) => void
        ) => {
          stdout.write('install output');
          stderr.write('dependency install failed');
          statusCallback?.({
            status: 'Failure',
            details: { causes: [{ reason: 'ExitCode', message: '7' }] },
          });
          return {
            on: jest.fn((event: string, callback: () => void) => {
              if (event === 'close') {
                callback();
              }
            }),
          };
        }
      );

      await expect(AgentSessionService.attachServices('session-1', ['web'])).rejects.toThrow(
        'dependency install failed'
      );
      expect(mockEnableDevMode).not.toHaveBeenCalled();
      expect(mockSessionQuery.patch).not.toHaveBeenCalled();
    });

    it('surfaces the Kubernetes status message when an exec failure has no exit code', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(attachableSession);
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValueOnce([
        {
          ...webCandidate,
          devConfig: {
            ...webCandidate.devConfig,
            installCommand: 'pnpm install',
          },
        },
      ]);
      mockExecInPod.mockImplementationOnce(
        async (
          _namespace: string,
          _podName: string,
          _containerName: string,
          _command: string[],
          _stdout: NodeJS.WritableStream,
          _stderr: NodeJS.WritableStream,
          _stdin: unknown,
          _tty: boolean,
          statusCallback?: (status: Record<string, unknown>) => void
        ) => {
          statusCallback?.({ status: 'Failure', message: 'container terminated before command status was reported' });
          return { on: jest.fn() };
        }
      );

      await expect(AgentSessionService.attachServices('session-1', ['web'])).rejects.toThrow(
        'container terminated before command status was reported'
      );
      expect(mockEnableDevMode).not.toHaveBeenCalled();
      expect(mockSessionQuery.patch).not.toHaveBeenCalled();
    });

    it('surfaces an exec transport rejection without enabling the service', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(attachableSession);
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValueOnce([
        {
          ...webCandidate,
          devConfig: { ...webCandidate.devConfig, installCommand: 'pnpm install' },
        },
      ]);
      mockExecInPod.mockRejectedValueOnce(new Error('exec transport unavailable'));

      await expect(AgentSessionService.attachServices('session-1', ['web'])).rejects.toThrow(
        'exec transport unavailable'
      );
      expect(mockEnableDevMode).not.toHaveBeenCalled();
    });

    it('surfaces a workspace exec websocket error before a terminal status arrives', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(attachableSession);
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValueOnce([
        {
          ...webCandidate,
          devConfig: { ...webCandidate.devConfig, installCommand: 'pnpm install' },
        },
      ]);
      mockExecInPod.mockResolvedValueOnce({
        on: jest.fn((event: string, callback: (error?: Error) => void) => {
          if (event === 'error') {
            callback(new Error('exec websocket failed'));
          }
        }),
      });

      await expect(AgentSessionService.attachServices('session-1', ['web'])).rejects.toThrow('exec websocket failed');
      expect(mockEnableDevMode).not.toHaveBeenCalled();
    });

    it('continues attachment when exec closes cleanly without a terminal status callback', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(attachableSession);
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValueOnce([
        {
          ...webCandidate,
          devConfig: { ...webCandidate.devConfig, installCommand: 'pnpm install' },
        },
      ]);
      mockExecInPod.mockResolvedValueOnce({
        on: jest.fn((event: string, callback: () => void) => {
          if (event === 'close') {
            callback();
          }
        }),
      });

      await expect(AgentSessionService.attachServices('session-1', ['web'])).resolves.toBeUndefined();
      expect(mockEnableDevMode).toHaveBeenCalledTimes(1);
      expect(mockSessionQuery.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedServices: expect.arrayContaining([expect.objectContaining({ deployId: 11 })]),
        })
      );
    });

    it('ignores late terminal and websocket error signals after a clean exec close', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(attachableSession);
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValueOnce([
        {
          ...webCandidate,
          devConfig: { ...webCandidate.devConfig, installCommand: 'pnpm install' },
        },
      ]);
      mockExecInPod.mockImplementationOnce(
        async (
          _namespace: string,
          _podName: string,
          _containerName: string,
          _command: string[],
          _stdout: NodeJS.WritableStream,
          _stderr: NodeJS.WritableStream,
          _stdin: unknown,
          _tty: boolean,
          statusCallback?: (status: Record<string, unknown>) => void
        ) => {
          let websocketErrorCallback: ((error: Error) => void) | undefined;
          setImmediate(() => {
            statusCallback?.({ status: 'Success' });
            websocketErrorCallback?.(new Error('late websocket error'));
          });
          return {
            on: jest.fn((event: string, callback: ((error: Error) => void) | (() => void)) => {
              if (event === 'error') {
                websocketErrorCallback = callback as (error: Error) => void;
              }
              if (event === 'close') {
                (callback as () => void)();
              }
            }),
          };
        }
      );

      await expect(AgentSessionService.attachServices('session-1', ['web'])).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockEnableDevMode).toHaveBeenCalledTimes(1);
      expect(mockSessionQuery.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedServices: expect.arrayContaining([expect.objectContaining({ deployId: 11 })]),
        })
      );
    });

    it('bootstraps newly equipped service skills before enabling the service', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(attachableSession);
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValueOnce([
        {
          ...webCandidate,
          devConfig: {
            ...webCandidate.devConfig,
            agentSession: {
              skills: [{ repo: 'example-org/agent-skills', branch: 'main', path: 'skills/web-debugging' }],
            },
          },
        },
      ]);

      await expect(AgentSessionService.attachServices('session-1', ['web'])).resolves.toBeUndefined();

      expect(mockExecInPod).toHaveBeenCalledTimes(1);
      const bootstrapCommand = ((mockExecInPod.mock.calls[0][3] as string[]) || []).join(' ');
      const encodedPlan = bootstrapCommand.match(/skills-bootstrap\.mjs" "([^"]+)"/)?.[1];
      expect(encodedPlan).toBeDefined();
      expect(JSON.parse(Buffer.from(encodedPlan!, 'base64').toString('utf8'))).toMatchObject({
        skills: [expect.objectContaining({ repo: 'example-org/agent-skills', path: 'skills/web-debugging' })],
      });
      expect(mockEnableDevMode).toHaveBeenCalledTimes(1);
      expect(mockSessionQuery.patch).toHaveBeenCalledWith(
        expect.objectContaining({
          skillPlan: expect.objectContaining({
            skills: [expect.objectContaining({ path: 'skills/web-debugging', source: 'service' })],
          }),
        })
      );
    });

    it('preserves the service-enable error when rollback deploy lookup also fails', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(attachableSession);
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValueOnce([
        webCandidate,
        { ...webCandidate, name: 'worker', deployId: 12, baseDeploy: { id: 12, uuid: 'worker-build-uuid' } },
      ]);
      mockEnableDevMode
        .mockResolvedValueOnce(buildDevModeSnapshot('web'))
        .mockRejectedValueOnce(new Error('worker failed to enable'));
      mockDeployQuery.withGraphFetched.mockRejectedValueOnce(new Error('rollback deploy lookup failed'));

      await expect(AgentSessionService.attachServices('session-1', ['web', 'worker'])).rejects.toThrow(
        'worker failed to enable'
      );
      expect(mockDeployQuery.whereIn).toHaveBeenCalledWith('id', [11]);
      expect(mockSessionQuery.patch).not.toHaveBeenCalled();
    });

    it('best-effort reverts deploy rows after a partial persistence failure', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(attachableSession);
      (loadAgentSessionServiceCandidates as jest.Mock).mockResolvedValueOnce([
        webCandidate,
        { ...webCandidate, name: 'worker', deployId: 12, baseDeploy: { id: 12, uuid: 'worker-build-uuid' } },
      ]);
      mockEnableDevMode.mockResolvedValue(buildDevModeSnapshot());
      const persistenceError = new Error('worker deploy row update failed');
      mockDeployQuery.patch
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(persistenceError)
        .mockRejectedValueOnce(new Error('web deploy rollback failed'));
      mockDeployQuery.withGraphFetched.mockResolvedValueOnce([]);

      await expect(AgentSessionService.attachServices('session-1', ['web', 'worker'])).rejects.toBe(persistenceError);

      expect(mockDeployQuery.patch).toHaveBeenNthCalledWith(1, { devMode: true, devModeSessionId: 321 });
      expect(mockDeployQuery.patch).toHaveBeenNthCalledWith(2, { devMode: true, devModeSessionId: 321 });
      expect(mockDeployQuery.patch).toHaveBeenNthCalledWith(3, { devMode: false, devModeSessionId: null });
      expect(mockSessionQuery.patch).not.toHaveBeenCalled();
    });
  });

  describe('teardown boundary paths', () => {
    it('keeps an archived session settled when background deploy restoration fails', async () => {
      const activeSession = {
        id: 321,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildKind: BuildKind.ENVIRONMENT,
        buildUuid: null,
        namespace: 'test-ns',
        podName: 'agent-session',
        pvcName: 'agent-pvc-session',
        forwardedAgentSecretProviders: [],
        devModeSnapshots: { '10': buildDevModeSnapshot('deploy-10') },
      };
      const devModeDeploys = [
        {
          id: 10,
          uuid: 'deploy-10',
          build: { namespace: 'test-ns' },
          deployable: { name: 'web', type: 'github', deploymentDependsOn: [] },
        },
      ];
      mockDeployQuery.withGraphFetched.mockResolvedValueOnce(devModeDeploys);
      const deploy = jest.fn().mockRejectedValueOnce(new Error('redeploy failed'));
      (DeploymentManager as jest.Mock).mockImplementationOnce(() => ({ deploy }));
      mockTeardownSession(activeSession);
      queueArchivedSession(activeSession);

      await expect(AgentSessionService.archiveSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));

      expect(deploy).toHaveBeenCalled();
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenLastCalledWith(
        321,
        expect.objectContaining({ status: 'archived', workspaceStatus: AgentWorkspaceStatus.NONE })
      );
    });

    it('archives a workspace-less session without invoking Kubernetes resource deletion', async () => {
      const workspaceLessSession = {
        id: 321,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.NONE,
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildKind: BuildKind.ENVIRONMENT,
        buildUuid: null,
        namespace: null,
        podName: null,
        pvcName: null,
        forwardedAgentSecretProviders: [],
        devModeSnapshots: {},
      };
      mockTeardownSession(workspaceLessSession);
      queueArchivedSession(workspaceLessSession);

      await AgentSessionService.archiveSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      expect(mockRedis.del).toHaveBeenCalledWith('lifecycle:agent:session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();
      expect(mockDeleteNamespace).not.toHaveBeenCalled();
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenLastCalledWith(
        321,
        expect.objectContaining({ status: 'archived', workspaceStatus: AgentWorkspaceStatus.NONE })
      );
    });

    it('passes the permitted active run through the cleanup claim', async () => {
      const workspaceLessSession = {
        id: 321,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.NONE,
        sessionKind: AgentSessionKind.ENVIRONMENT,
        buildKind: BuildKind.ENVIRONMENT,
        buildUuid: null,
        namespace: null,
        podName: null,
        pvcName: null,
        forwardedAgentSecretProviders: [],
        devModeSnapshots: {},
      };
      mockTeardownSession(workspaceLessSession);
      queueReleasedSession(workspaceLessSession);
      const claimSpy = jest.spyOn(WorkspaceRuntimeStateService, 'claimWorkspaceAction');

      await AgentSessionService.releaseWorkspace(workspaceLessSession.uuid, {
        allowedActiveRunUuid: 'run-current',
      });

      expect(claimSpy).toHaveBeenCalledWith(
        321,
        expect.objectContaining({
          action: 'cleanup',
          allowedActiveRunUuid: 'run-current',
        })
      );
      expect(mockSessionQuery.patchAndFetchById).toHaveBeenLastCalledWith(
        321,
        expect.objectContaining({ status: 'active', workspaceStatus: AgentWorkspaceStatus.NONE })
      );
      claimSpy.mockRestore();
    });

    it('falls back to synchronous build deletion when remote sandbox cleanup enqueue fails', async () => {
      const runtime = mockOpenSandboxRuntime();
      mockOpenSandboxSandboxRow();
      const sandboxSession = {
        id: 321,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.SANDBOX,
        buildKind: BuildKind.SANDBOX,
        buildUuid: 'sandbox-build',
        namespace: 'sandbox-ns',
        podName: 'sbx-123',
        pvcName: null,
        forwardedAgentSecretProviders: [],
        devModeSnapshots: {},
      };
      const build = { id: 99, uuid: 'sandbox-build', kind: BuildKind.SANDBOX };
      (Build.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({ withGraphFetched: jest.fn().mockResolvedValue(build) }),
      });
      mockedBuildServiceModule.enqueueBuildDeletion.mockRejectedValueOnce(new Error('queue unavailable'));
      mockTeardownSession(sandboxSession);
      queueArchivedSession(sandboxSession);

      await AgentSessionService.archiveSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      expect(runtime.destroy).toHaveBeenCalled();
      expect(mockDeleteNamespace).not.toHaveBeenCalled();
      expect(mockedBuildServiceModule.enqueueBuildDeletion).toHaveBeenCalledWith(build, 'agent_session_archive');
      expect(mockedBuildServiceModule.deleteBuild).toHaveBeenCalledWith(build, { rethrow: true });
      expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
    });

    it('falls back to synchronous build deletion when Kubernetes sandbox cleanup enqueue fails', async () => {
      const sandboxSession = {
        id: 321,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        status: 'active',
        chatStatus: AgentChatStatus.READY,
        workspaceStatus: AgentWorkspaceStatus.READY,
        sessionKind: AgentSessionKind.SANDBOX,
        buildKind: BuildKind.SANDBOX,
        buildUuid: 'sandbox-build',
        namespace: 'sandbox-ns',
        podName: 'agent-sandbox',
        pvcName: 'agent-pvc-sandbox',
        forwardedAgentSecretProviders: [],
        devModeSnapshots: {},
      };
      const build = { id: 99, uuid: 'sandbox-build', kind: BuildKind.SANDBOX };
      (Build.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({ withGraphFetched: jest.fn().mockResolvedValue(build) }),
      });
      mockedBuildServiceModule.enqueueBuildDeletion.mockRejectedValueOnce(new Error('queue unavailable'));
      mockTeardownSession(sandboxSession);
      queueArchivedSession(sandboxSession);

      await AgentSessionService.archiveSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      expect(mockedBuildServiceModule.enqueueBuildDeletion).toHaveBeenCalledWith(build, 'agent_session_archive');
      expect(mockedBuildServiceModule.deleteBuild).toHaveBeenCalledWith(build, { rethrow: true });
      expect(deleteSessionWorkspacePod).not.toHaveBeenCalled();
      expect(deleteAgentPvc).not.toHaveBeenCalled();
    });
  });

  describe('getSession', () => {
    it('returns null when the session does not exist', async () => {
      mockSessionQuery.findOne.mockResolvedValueOnce(null);

      await expect(AgentSessionService.getSession('missing')).resolves.toBeNull();
      expect(Deploy.query).not.toHaveBeenCalled();
    });

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
    it('returns null when no startup failure has been recorded', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      await expect(AgentSessionService.getSessionStartupFailure('sess-1')).resolves.toBeNull();
    });

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

    it('still returns the normalized failure when Redis and session lookup are unavailable', async () => {
      mockRedis.setex.mockRejectedValueOnce(new Error('redis write unavailable'));
      mockRedis.del.mockRejectedValueOnce(new Error('redis delete unavailable'));
      mockSessionQuery.findOne.mockRejectedValueOnce(new Error('database unavailable'));
      const recordFailureSpy = jest.spyOn(WorkspaceRuntimeStateService, 'recordWorkspaceFailure');

      await expect(
        AgentSessionService.markSessionRuntimeFailure('sess-1', 'runtime disconnected', 'attach_services')
      ).resolves.toMatchObject({
        stage: 'attach_services',
        origin: 'manual_runtime',
        message: 'runtime disconnected',
        retryable: false,
      });
      expect(recordFailureSpy).not.toHaveBeenCalled();
      recordFailureSpy.mockRestore();
    });
  });

  describe('touchActivity', () => {
    it('does not write when the session no longer exists', async () => {
      (AgentSession.query as jest.Mock) = jest.fn().mockReturnValueOnce({
        findOne: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue(null) }),
      });

      await expect(AgentSessionService.touchActivity('missing')).resolves.toBeUndefined();
      expect(AgentSession.query).toHaveBeenCalledTimes(1);
    });

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
    it('appends the workspace tool inventory for workspace-ready sessions', async () => {
      mockGetEffectiveAgentSessionConfig.mockResolvedValue({
        appendSystemPrompt: 'Use concise responses.',
      });
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
      // Volatile environment state stays out of the system prompt (it arrives as environment_state events).
      expect(systemPrompt.resolveAgentSessionPromptContext).not.toHaveBeenCalled();
      const [configured, sessionLines] = (systemPrompt.combineAgentSessionAppendSystemPrompt as jest.Mock).mock
        .calls[0];
      expect(configured).toBe('Use concise responses.');
      expect(sessionLines).toContain('- equipped tools:');
    });

    it('keeps the system prompt session-stable for build-context chats without a workspace', async () => {
      mockGetEffectiveAgentSessionConfig.mockResolvedValue({
        appendSystemPrompt: 'Use concise responses.',
      });
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
      expect(systemPrompt.resolveAgentSessionPromptContext).not.toHaveBeenCalled();
      const [configured, sessionLines] = (systemPrompt.combineAgentSessionAppendSystemPrompt as jest.Mock).mock
        .calls[0];
      expect(configured).toBe('Use concise responses.');
      expect(sessionLines).toBeUndefined();
    });

    it('adds the skills line when the session has an equipped skill plan', async () => {
      mockGetEffectiveAgentSessionConfig.mockResolvedValue({
        appendSystemPrompt: 'Use concise responses.',
      });
      (systemPrompt.combineAgentSessionAppendSystemPrompt as jest.Mock).mockReturnValue('combined prompt');

      (AgentSession.query as jest.Mock) = jest.fn().mockReturnValue({
        findOne: jest.fn().mockReturnValue({
          select: jest.fn().mockResolvedValue({
            id: 123,
            namespace: null,
            buildUuid: 'build-123',
            skillPlan: { skills: [{ name: 'skill-1' }] },
            workspaceStatus: AgentWorkspaceStatus.NONE,
            podName: null,
          }),
        }),
      });

      await AgentSessionService.getSessionAppendSystemPrompt('sess-1');
      const [, sessionLines] = (systemPrompt.combineAgentSessionAppendSystemPrompt as jest.Mock).mock.calls[0];
      expect(sessionLines).toContain('- equipped skills:');
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
