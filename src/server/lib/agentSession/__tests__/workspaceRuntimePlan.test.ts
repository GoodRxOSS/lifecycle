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

import fs from 'fs';
import path from 'path';
import AgentProviderRegistry from 'server/services/agent/ProviderRegistry';
import {
  resolveAgentSessionRuntimeConfig,
  resolveAgentSessionWorkspaceStorageIntent,
} from 'server/lib/agentSession/runtimeConfig';
import { resolveAgentSessionServicePlan } from 'server/lib/agentSession/servicePlan';
import { resolveAgentSessionSkillPlan } from 'server/lib/agentSession/skillPlan';
import { planForwardedAgentEnv } from 'server/lib/agentSession/forwardedEnv';
import { resolveWorkspaceRuntimePlan, toWorkspaceRuntimePlanMetadata } from '../workspaceRuntimePlan';

jest.mock('server/lib/agentSession/runtimeConfig', () => ({
  resolveAgentSessionRuntimeConfig: jest.fn(),
  resolveAgentSessionWorkspaceStorageIntent: jest.fn(),
}));

jest.mock('server/lib/agentSession/servicePlan', () => ({
  resolveAgentSessionServicePlan: jest.fn(),
}));

jest.mock('server/lib/agentSession/skillPlan', () => ({
  resolveAgentSessionSkillPlan: jest.fn(),
}));

jest.mock('server/lib/agentSession/forwardedEnv', () => ({
  planForwardedAgentEnv: jest.fn(),
}));

jest.mock('server/services/agent/ProviderRegistry', () => ({
  __esModule: true,
  default: {
    resolveSelection: jest.fn(),
    getRequiredProviderApiKey: jest.fn(),
    resolveCredentialEnvMap: jest.fn(),
  },
}));

const mockGetCompatibleReadyPrewarm = jest.fn();
jest.mock('server/services/agentPrewarm', () =>
  jest.fn().mockImplementation(() => ({
    getCompatibleReadyPrewarm: mockGetCompatibleReadyPrewarm,
  }))
);

const mockResolveSessionPodServersForRepo = jest.fn();
jest.mock('server/services/agentRuntime/mcp/config', () => ({
  McpConfigService: jest.fn().mockImplementation(() => ({
    resolveSessionPodServersForRepo: mockResolveSessionPodServersForRepo,
  })),
}));

const sessionUuid = '11111111-1111-4111-8111-111111111111';
const workspaceRepos = [
  {
    repo: 'example-org/sample-service',
    repoUrl: 'https://github.com/example-org/sample-service.git',
    branch: 'main',
    revision: 'rev-1',
    mountPath: '/workspace',
    primary: true,
  },
];
const selectedServices = [
  {
    name: 'sample-service',
    deployId: 10,
    repo: 'example-org/sample-service',
    branch: 'main',
    revision: 'rev-1',
    resourceName: 'sample-service',
    workspacePath: '/workspace',
    workDir: '/workspace',
  },
];
const resolvedServices = [
  {
    name: 'sample-service',
    deployId: 10,
    repo: 'example-org/sample-service',
    branch: 'main',
    revision: 'rev-1',
    resourceName: 'sample-service',
    workspacePath: '/workspace',
    workDir: '/workspace',
    devConfig: {
      image: 'node:20',
      command: 'pnpm dev',
      forwardEnvVarsToAgent: ['NPM_TOKEN'],
    },
  },
];
const runtimeConfig = {
  workspaceImage: 'registry.example.test/workspace:latest',
  workspaceEditorImage: 'registry.example.test/editor:latest',
  workspaceGatewayImage: 'registry.example.test/gateway:latest',
  keepAttachedServicesOnSessionNode: true,
  readiness: {
    timeoutMs: 60000,
    pollMs: 1000,
  },
  resources: {
    workspace: { requests: {}, limits: {} },
    editor: { requests: {}, limits: {} },
    workspaceGateway: { requests: {}, limits: {} },
  },
  workspaceStorage: {
    defaultSize: '10Gi',
    allowedSizes: ['10Gi', '20Gi'],
    allowClientOverride: true,
    accessMode: 'ReadWriteOnce',
  },
  cleanup: {
    activeIdleSuspendMs: 1800000,
    startingTimeoutMs: 900000,
    hibernatedRetentionMs: 86400000,
    intervalMs: 300000,
    redisTtlSeconds: 7200,
  },
  durability: {
    runExecutionLeaseMs: 1800000,
    queuedRunDispatchStaleMs: 30000,
    dispatchRecoveryLimit: 50,
    maxDurablePayloadBytes: 65536,
    payloadPreviewBytes: 16384,
    fileChangePreviewChars: 4000,
  },
};
const storageIntent = {
  requestedSize: null,
  storageSize: '10Gi',
  accessMode: 'ReadWriteOnce',
};
const skillPlan = {
  version: 1 as const,
  skills: [
    {
      repo: 'example-org/sample-skills',
      repoUrl: 'https://github.com/example-org/sample-skills.git',
      branch: 'main',
      path: 'skills/sample',
      source: 'environment' as const,
    },
  ],
};
const forwardedEnvPlan = {
  env: {
    NPM_TOKEN: '{{aws:apps/sample:npmToken}}',
  },
  secretRefs: [
    {
      envKey: 'NPM_TOKEN',
      provider: 'aws',
      path: 'apps/sample',
      key: 'npmToken',
    },
  ],
  secretProviders: ['aws'],
  secretServiceName: 'agent-env-11111111-1111-4111-8111-111111111111',
};

function mockDefaults() {
  (resolveAgentSessionRuntimeConfig as jest.Mock).mockResolvedValue(runtimeConfig);
  (resolveAgentSessionWorkspaceStorageIntent as jest.Mock).mockReturnValue(storageIntent);
  (resolveAgentSessionServicePlan as jest.Mock).mockReturnValue({
    workspaceRepos,
    services: resolvedServices,
    selectedServices,
  });
  (resolveAgentSessionSkillPlan as jest.Mock).mockReturnValue(skillPlan);
  (AgentProviderRegistry.resolveSelection as jest.Mock).mockResolvedValue({
    provider: 'openai',
    modelId: 'gpt-sample',
  });
  (AgentProviderRegistry.getRequiredProviderApiKey as jest.Mock).mockResolvedValue('provider-secret-value');
  (AgentProviderRegistry.resolveCredentialEnvMap as jest.Mock).mockResolvedValue({
    OPENAI_API_KEY: 'provider-secret-value',
  });
  mockResolveSessionPodServersForRepo.mockResolvedValue([
    {
      slug: 'sample-mcp',
      name: 'Sample MCP',
      transport: {
        type: 'stdio',
        command: 'sample-mcp',
        env: {
          MCP_SECRET: 'mcp-secret-value',
        },
      },
      timeout: 5000,
    },
  ]);
  mockGetCompatibleReadyPrewarm.mockResolvedValue(null);
  (planForwardedAgentEnv as jest.Mock).mockResolvedValue(forwardedEnvPlan);
}

describe('workspaceRuntimePlan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDefaults();
  });

  it('resolves workspace startup inputs before resource application', async () => {
    const plan = await resolveWorkspaceRuntimePlan({
      kind: 'environment',
      sessionUuid,
      namespace: 'sample-ns',
      userId: 'sample-user',
      userIdentity: {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      },
      buildUuid: 'build-123',
      provider: 'openai',
      model: 'gpt-sample',
      githubToken: 'github-secret-value',
      repoUrl: 'https://github.com/example-org/sample-service.git',
      branch: 'main',
      revision: 'rev-1',
      services: resolvedServices,
      environmentSkillRefs: skillPlan.skills,
    });

    expect(plan).toMatchObject({
      version: 1,
      kind: 'environment',
      sessionUuid,
      namespace: 'sample-ns',
      podName: 'agent-build-123',
      apiKeySecretName: 'agent-secret-11111111',
      runtimeConfig,
      workspaceStorage: storageIntent,
      servicePlan: {
        workspaceRepos,
        services: resolvedServices,
        selectedServices,
      },
      skillPlan,
      provider: {
        selection: {
          provider: 'openai',
          modelId: 'gpt-sample',
        },
        apiKey: 'provider-secret-value',
        credentialEnv: {
          OPENAI_API_KEY: 'provider-secret-value',
        },
      },
      startupMcp: {
        servers: expect.any(Array),
        serializedConfig: expect.stringContaining('sample-mcp'),
      },
      forwardedEnv: forwardedEnvPlan,
      prewarm: {
        compatiblePrewarm: null,
        pvcName: 'agent-pvc-11111111',
        skipWorkspaceBootstrap: false,
        ownsPvc: true,
      },
      credentials: {
        hasGitHubToken: true,
        githubToken: 'github-secret-value',
      },
    });
    expect(resolveAgentSessionRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(resolveAgentSessionWorkspaceStorageIntent).toHaveBeenCalledWith({
      requestedSize: null,
      storage: runtimeConfig.workspaceStorage,
    });
    expect(AgentProviderRegistry.resolveSelection).toHaveBeenCalledWith({
      repoFullName: 'example-org/sample-service',
      requestedProvider: 'openai',
      requestedModelId: 'gpt-sample',
    });
    expect(mockResolveSessionPodServersForRepo).toHaveBeenCalledWith(
      'example-org/sample-service',
      undefined,
      expect.objectContaining({ userId: 'sample-user' })
    );
    expect(planForwardedAgentEnv).toHaveBeenCalledWith(resolvedServices, sessionUuid);
    expect(mockGetCompatibleReadyPrewarm).toHaveBeenCalledWith({
      buildUuid: 'build-123',
      requestedServices: ['sample-service'],
      revision: 'rev-1',
      workspaceRepos,
      requestedServiceRefs: selectedServices,
    });
  });

  it('snapshots compatible ready prewarm ownership', async () => {
    mockGetCompatibleReadyPrewarm.mockResolvedValue({
      uuid: 'prewarm-123',
      pvcName: 'agent-prewarm-pvc',
    });

    const plan = await resolveWorkspaceRuntimePlan({
      kind: 'environment',
      sessionUuid,
      namespace: 'sample-ns',
      userId: 'sample-user',
      buildUuid: 'build-123',
      repoUrl: 'https://github.com/example-org/sample-service.git',
      branch: 'main',
      services: resolvedServices,
    });

    expect(plan.prewarm).toEqual({
      compatiblePrewarm: {
        uuid: 'prewarm-123',
        pvcName: 'agent-prewarm-pvc',
      },
      pvcName: 'agent-prewarm-pvc',
      skipWorkspaceBootstrap: true,
      ownsPvc: false,
    });
  });

  it('disables prewarm reuse when workspace storage is overridden', async () => {
    (resolveAgentSessionWorkspaceStorageIntent as jest.Mock).mockReturnValue({
      requestedSize: '20Gi',
      storageSize: '20Gi',
      accessMode: 'ReadWriteOnce',
    });
    mockGetCompatibleReadyPrewarm.mockResolvedValue({
      uuid: 'prewarm-123',
      pvcName: 'agent-prewarm-pvc',
    });

    const plan = await resolveWorkspaceRuntimePlan({
      kind: 'environment',
      sessionUuid,
      namespace: 'sample-ns',
      userId: 'sample-user',
      buildUuid: 'build-123',
      repoUrl: 'https://github.com/example-org/sample-service.git',
      branch: 'main',
      workspaceStorageSize: '20Gi',
      services: resolvedServices,
    });

    expect(mockGetCompatibleReadyPrewarm).not.toHaveBeenCalled();
    expect(plan.prewarm).toEqual({
      compatiblePrewarm: null,
      pvcName: 'agent-pvc-11111111',
      skipWorkspaceBootstrap: false,
      ownsPvc: true,
    });
  });

  it('redacts secrets from persisted metadata', async () => {
    const plan = await resolveWorkspaceRuntimePlan({
      kind: 'environment',
      sessionUuid,
      namespace: 'sample-ns',
      userId: 'sample-user',
      userIdentity: {
        userId: 'sample-user',
        githubUsername: 'sample-user',
      },
      buildUuid: 'build-123',
      githubToken: 'github-secret-value',
      repoUrl: 'https://github.com/example-org/sample-service.git',
      branch: 'main',
      services: resolvedServices,
    });

    const metadata = toWorkspaceRuntimePlanMetadata(plan);
    const serializedMetadata = JSON.stringify(metadata);

    expect(metadata).toEqual({
      version: 1,
      pvcName: 'agent-pvc-11111111',
      ownsPvc: true,
      skipWorkspaceBootstrap: false,
      compatiblePrewarmUuid: null,
    });
    expect(serializedMetadata).not.toContain('provider-secret-value');
    expect(serializedMetadata).not.toContain('github-secret-value');
    expect(serializedMetadata).not.toContain('{{aws:apps/sample:npmToken}}');
    expect(serializedMetadata).not.toContain('mcp-secret-value');
  });

  it('does not depend on AI RunPlanResolver or secret application paths', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'workspaceRuntimePlan.ts'), 'utf8');

    expect(source).not.toMatch(/RunPlanResolver/);
    expect(source).not.toMatch(/processEnvSecrets/);
    expect(source).not.toMatch(/waitForSecretSync/);
    expect(source).not.toMatch(/applyExternalSecret/);
  });
});
