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

const mockRedis = {
  get: jest.fn(),
  setex: jest.fn(),
};

const mockLaunch = jest.fn();

jest.mock('server/lib/redisClient', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getRedis: () => mockRedis,
    })),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
  })),
}));

jest.mock('server/lib/encryption', () => ({
  decrypt: jest.fn((value: string) => `decrypted:${value}`),
}));

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {},
  AgentSessionStartupError: class AgentSessionStartupError extends Error {
    public readonly sessionId: string;
    public readonly buildUuid: string | null;
    public readonly namespace: string;
    public readonly failure: Record<string, unknown>;

    constructor(params: {
      sessionId: string;
      buildUuid?: string | null;
      namespace: string;
      failure: Record<string, unknown>;
      cause: Error;
    }) {
      super(params.cause.message);
      this.name = 'AgentSessionStartupError';
      this.sessionId = params.sessionId;
      this.buildUuid = params.buildUuid ?? null;
      this.namespace = params.namespace;
      this.failure = params.failure;
    }
  },
}));

jest.mock('server/services/agentSandboxSession', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    launch: mockLaunch,
  })),
  formatRequestedSandboxServicesLabel: jest.fn(() => 'sample-service'),
}));

import { AgentSessionStartupError } from 'server/services/agentSession';
import { getSandboxLaunchState, setSandboxLaunchState } from 'server/lib/agentSession/sandboxLaunchState';
import { processAgentSandboxSessionLaunch } from '../agentSandboxSessionLaunch';

describe('agentSandboxSessionLaunch', () => {
  let redisStore: Map<string, string>;

  beforeEach(() => {
    jest.clearAllMocks();
    redisStore = new Map();
    mockRedis.get.mockImplementation(async (key: string) => redisStore.get(key) ?? null);
    mockRedis.setex.mockImplementation(async (key: string, _ttlSeconds: number, value: string) => {
      redisStore.set(key, value);
      return 'OK';
    });
  });

  function buildJob(overrides: Record<string, unknown> = {}) {
    return {
      data: {
        launchId: 'launch-1',
        userId: 'sample-user',
        userIdentity: {
          userId: 'sample-user',
          githubUsername: 'sample-user',
          preferredUsername: 'sample-user',
          email: 'sample-user@example.com',
          displayName: 'Sample User',
        },
        encryptedGithubToken: 'encrypted-token',
        baseBuildUuid: 'base-build-1',
        services: ['sample-service'],
        model: 'sample-model',
        workspaceImage: 'sample-workspace-image',
        workspaceEditorImage: 'sample-editor-image',
        workspaceGatewayImage: 'sample-gateway-image',
        nodeSelector: { role: 'sample-node' },
        keepAttachedServicesOnSessionNode: true,
        readiness: { timeoutMs: 60000, pollMs: 2000 },
        resources: {
          workspace: { requests: {}, limits: {} },
          editor: { requests: {}, limits: {} },
          workspaceGateway: { requests: {}, limits: {} },
        },
        workspaceStorage: {
          storageSize: '10Gi',
          accessMode: 'ReadWriteOnce',
          requestedSize: '10Gi',
        },
        redisTtlSeconds: 7200,
        ...overrides,
      },
    } as any;
  }

  it('links opening-session createSession failures to the persisted failed session', async () => {
    const failure = {
      stage: 'connect_runtime',
      title: 'Workspace did not start',
      message: 'workspace pod failed',
      recordedAt: '2026-05-09T16:00:00.000Z',
      retryable: false,
      origin: 'sandbox_launch',
    };

    await setSandboxLaunchState(mockRedis as any, {
      launchId: 'launch-1',
      userId: 'sample-user',
      status: 'running',
      stage: 'opening_session',
      message: 'Opening sandbox for sample-service',
      createdAt: '2026-05-09T15:59:00.000Z',
      updatedAt: '2026-05-09T15:59:30.000Z',
      baseBuildUuid: 'base-build-1',
      service: 'sample-service',
      buildUuid: 'sandbox-build-1',
      namespace: 'sample-namespace',
      sessionId: null,
      focusUrl: null,
      error: null,
      workspaceFailure: null,
    });
    mockLaunch.mockRejectedValue(
      new AgentSessionStartupError({
        sessionId: 'session-1',
        buildUuid: 'sandbox-build-1',
        namespace: 'sample-namespace',
        failure,
        cause: new Error('workspace pod failed'),
      } as any)
    );

    await expect(processAgentSandboxSessionLaunch(buildJob())).rejects.toThrow('workspace pod failed');

    await expect(getSandboxLaunchState(mockRedis as any, 'launch-1')).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
        stage: 'error',
        message: 'workspace pod failed',
        buildUuid: 'sandbox-build-1',
        namespace: 'sample-namespace',
        sessionId: 'session-1',
        focusUrl: '/environments/sandbox-build-1/agent-session/session-1?baseBuildUuid=base-build-1',
        error: 'workspace pod failed',
        workspaceFailure: failure,
      })
    );
  });

  it('keeps pre-session launch errors local to launch progress', async () => {
    await setSandboxLaunchState(mockRedis as any, {
      launchId: 'launch-1',
      userId: 'sample-user',
      status: 'running',
      stage: 'resolving_base_build',
      message: 'Resolving base build',
      createdAt: '2026-05-09T15:59:00.000Z',
      updatedAt: '2026-05-09T15:59:30.000Z',
      baseBuildUuid: 'base-build-1',
      service: 'sample-service',
      buildUuid: null,
      namespace: null,
      sessionId: null,
      focusUrl: null,
      error: null,
      workspaceFailure: null,
    });
    mockLaunch.mockRejectedValue(new Error('Base build not found'));

    await expect(processAgentSandboxSessionLaunch(buildJob())).rejects.toThrow('Base build not found');

    await expect(getSandboxLaunchState(mockRedis as any, 'launch-1')).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
        stage: 'error',
        message: 'Base build not found',
        buildUuid: null,
        namespace: null,
        sessionId: null,
        focusUrl: null,
        error: 'Base build not found',
        workspaceFailure: null,
      })
    );
  });
});
