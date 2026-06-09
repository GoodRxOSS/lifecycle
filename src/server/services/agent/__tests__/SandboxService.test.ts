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

jest.mock('server/models/AgentSandbox', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/models/AgentSandboxExposure', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

const mockFindSession = jest.fn();
const mockOpenChatRuntime = jest.fn();
const mockProvisionChatRuntime = jest.fn();

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: jest.fn(() => ({
      findOne: (...args: unknown[]) => mockFindSession(...args),
    })),
  },
}));

jest.mock('server/services/agentSession', () => ({
  __esModule: true,
  default: {
    openChatRuntime: (...args: unknown[]) => mockOpenChatRuntime(...args),
    provisionChatRuntime: (...args: unknown[]) => mockProvisionChatRuntime(...args),
  },
}));

jest.mock('server/lib/dependencies', () => ({}));

const mockResolveBackendConfig = jest.fn();

jest.mock('server/lib/agentSession/runtimeConfig', () => ({
  __esModule: true,
  resolveAgentSessionWorkspaceBackendConfig: (...args: unknown[]) => mockResolveBackendConfig(...args),
}));

jest.mock('server/lib/agentSession/chatPreviewFactory', () => ({
  buildChatPreviewHostSlug: ({ sessionUuid, port }: { sessionUuid: string; port: number }) =>
    `slug-${sessionUuid}-${port}`,
  resolveChatPreviewPublicPublication: ({ port, previewSlug }: { port: number; previewSlug: string }) => ({
    url: `http://${port}--${previewSlug}.localhost:5001/`,
    host: `${port}--${previewSlug}.localhost:5001`,
    path: '/',
  }),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    warn: jest.fn(),
  })),
}));

jest.mock('server/lib/encryption', () => ({
  encrypt: jest.fn((value: string) => `enc:${value}`),
  decrypt: jest.fn((value: string) => {
    if (!value.startsWith('enc:')) {
      throw new Error('bad ciphertext');
    }
    return value.slice('enc:'.length);
  }),
}));

import type { WorkspaceRuntimeFailure } from 'server/lib/agentSession/startupFailureState';
import AgentSandbox from 'server/models/AgentSandbox';
import AgentSandboxExposure from 'server/models/AgentSandboxExposure';
import AgentSandboxService from '../SandboxService';

const GATEWAY_PORT = parseInt(process.env.AGENT_SESSION_WORKSPACE_GATEWAY_PORT || '13338', 10);

const mockSandboxQuery = AgentSandbox.query as jest.Mock;
const mockExposureQuery = AgentSandboxExposure.query as jest.Mock;

const canonicalFailure: WorkspaceRuntimeFailure = {
  stage: 'connect_runtime',
  title: 'Session workspace connection failed',
  message: 'Lifecycle could not connect to the workspace runtime.',
  recordedAt: '2026-05-09T00:00:00.000Z',
  retryable: false,
  origin: 'agent_session',
};

function buildSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    uuid: 'session-1',
    sessionKind: 'environment',
    buildUuid: 'build-1',
    buildKind: 'environment',
    status: 'error',
    workspaceStatus: 'failed',
    namespace: 'sample-namespace',
    podName: 'sample-pod',
    pvcName: 'sample-pvc',
    selectedServices: [],
    updatedAt: '2026-05-09T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  } as unknown as Parameters<typeof AgentSandboxService.recordSessionSandboxState>[0];
}

function latestSandboxQuery(result: unknown) {
  const query: Record<string, jest.Mock> = {};
  query.where = jest.fn(() => query);
  query.orderBy = jest.fn(() => query);
  query.first = jest.fn().mockResolvedValue(result);
  mockSandboxQuery.mockReturnValueOnce(query);
  return query;
}

function insertSandboxQuery(result: Record<string, unknown>) {
  const insertAndFetch = jest.fn().mockResolvedValue(result);
  mockSandboxQuery.mockReturnValueOnce({ insertAndFetch });
  return insertAndFetch;
}

function patchSandboxQuery(result: Record<string, unknown>) {
  const patchAndFetchById = jest.fn().mockResolvedValue(result);
  mockSandboxQuery.mockReturnValueOnce({ patchAndFetchById });
  return patchAndFetchById;
}

function editorExposureInsertQuery() {
  const existingQuery: Record<string, jest.Mock> = {};
  existingQuery.where = jest.fn(() => existingQuery);
  existingQuery.whereNull = jest.fn(() => existingQuery);
  existingQuery.orderBy = jest.fn(() => existingQuery);
  existingQuery.first = jest.fn().mockResolvedValue(null);

  const insert = jest.fn().mockResolvedValue({ id: 5 });
  mockExposureQuery.mockReturnValueOnce(existingQuery).mockReturnValueOnce({ insert });
  return insert;
}

function editorExposureReviveQuery(existing: Record<string, unknown>) {
  const existingQuery: Record<string, jest.Mock> = {};
  existingQuery.where = jest.fn(() => existingQuery);
  existingQuery.orderBy = jest.fn(() => existingQuery);
  existingQuery.first = jest.fn().mockResolvedValue(existing);

  const patchAndFetchById = jest.fn().mockResolvedValue(existing);
  mockExposureQuery.mockReturnValueOnce(existingQuery).mockReturnValueOnce({ patchAndFetchById });
  return patchAndFetchById;
}

function previewExposureListQuery(exposures: Array<Record<string, unknown>>) {
  const query: Record<string, jest.Mock> = {};
  query.where = jest.fn(() => query);
  query.whereNotNull = jest.fn(() => query);
  query.orderBy = jest.fn().mockResolvedValue(exposures);
  mockExposureQuery.mockReturnValueOnce(query);
  return query;
}

function closeExposureQuery() {
  const query: Record<string, jest.Mock> = {};
  query.where = jest.fn(() => query);
  query.whereNull = jest.fn(() => query);
  query.patch = jest.fn().mockResolvedValue(1);
  mockExposureQuery.mockReturnValueOnce(query);
  return query.patch;
}

describe('AgentSandboxService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindSession.mockReset();
    mockOpenChatRuntime.mockReset();
    mockProvisionChatRuntime.mockReset();
    mockResolveBackendConfig.mockReset();
    mockResolveBackendConfig.mockResolvedValue({ provider: 'lifecycle_kubernetes', opensandbox: {} });
  });

  it('persists an explicit canonical failure when inserting a failed sandbox row', async () => {
    latestSandboxQuery(null);
    const insertAndFetch = insertSandboxQuery({
      id: 9,
      status: 'failed',
      providerState: {},
      error: canonicalFailure,
    });
    editorExposureInsertQuery();

    await AgentSandboxService.recordSessionSandboxState(buildSession(), { failure: canonicalFailure });

    expect(insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 17,
        status: 'failed',
        error: canonicalFailure,
      })
    );
  });

  it('persists a failed sandbox row without runtime identifiers when a failure is provided', async () => {
    latestSandboxQuery(null);
    const insertAndFetch = insertSandboxQuery({
      id: 9,
      status: 'failed',
      providerState: {},
      error: canonicalFailure,
    });

    await AgentSandboxService.recordSessionSandboxState(
      buildSession({
        namespace: null,
        podName: null,
        pvcName: null,
      }),
      { failure: canonicalFailure }
    );

    expect(insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        providerState: {},
        error: canonicalFailure,
      })
    );
    expect(mockExposureQuery).not.toHaveBeenCalled();
  });

  it('leaves sessions without runtime identifiers and without failure unchanged', async () => {
    const existingSandbox = {
      id: 9,
      status: 'ready',
      providerState: {},
      error: null,
    };
    latestSandboxQuery(existingSandbox);

    await expect(
      AgentSandboxService.recordSessionSandboxState(
        buildSession({
          status: 'active',
          workspaceStatus: 'none',
          namespace: null,
          podName: null,
          pvcName: null,
        })
      )
    ).resolves.toBe(existingSandbox);

    expect(mockSandboxQuery).toHaveBeenCalledTimes(1);
    expect(mockExposureQuery).not.toHaveBeenCalled();
  });

  it('replaces a generic failure with canonical failure and preserves workspace storage on patch', async () => {
    latestSandboxQuery({
      id: 9,
      providerState: {
        workspaceStorage: {
          size: '10Gi',
          accessMode: 'ReadWriteOnce',
          pvcName: 'sample-pvc',
        },
      },
      error: { message: 'Sandbox failed' },
    });
    const patchAndFetchById = patchSandboxQuery({ id: 9, status: 'failed', error: canonicalFailure });

    await AgentSandboxService.recordSessionSandboxState(
      buildSession({
        podName: null,
      }),
      { failure: canonicalFailure }
    );

    expect(patchAndFetchById).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        status: 'failed',
        providerState: expect.objectContaining({
          namespace: 'sample-namespace',
          pvcName: 'sample-pvc',
          workspaceStorage: {
            size: '10Gi',
            accessMode: 'ReadWriteOnce',
            pvcName: 'sample-pvc',
          },
        }),
        error: canonicalFailure,
      })
    );
  });

  it('normalizes missing and legacy failed sandbox details instead of writing a generic message', async () => {
    latestSandboxQuery({
      id: 9,
      providerState: {},
      error: { message: 'Sandbox failed' },
    });
    const patchAndFetchById = patchSandboxQuery({ id: 9, status: 'failed' });

    await AgentSandboxService.recordSessionSandboxState(
      buildSession({
        podName: null,
      })
    );

    expect(patchAndFetchById).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        error: expect.objectContaining({
          stage: 'connect_runtime',
          title: 'Workspace could not be opened',
          message: 'Lifecycle could not open the workspace.',
          retryable: false,
          origin: 'legacy',
        }),
      })
    );
    expect(patchAndFetchById.mock.calls[0][1].error).not.toEqual({ message: 'Sandbox failed' });
  });

  it.each([
    ['ready', { status: 'active', workspaceStatus: 'ready' }, 'ready'],
    ['suspended', { status: 'active', workspaceStatus: 'hibernated' }, 'suspended'],
    ['ended', { status: 'archived', workspaceStatus: 'none', archivedAt: '2026-05-09T00:05:00.000Z' }, 'ended'],
  ])('clears failed sandbox errors when the session records %s state', async (_label, sessionState, sandboxStatus) => {
    latestSandboxQuery({
      id: 9,
      providerState: {},
      error: canonicalFailure,
    });
    const patchAndFetchById = patchSandboxQuery({ id: 9, status: sandboxStatus, error: null });
    if (sandboxStatus === 'suspended' || sandboxStatus === 'ended') {
      closeExposureQuery();
    }

    await AgentSandboxService.recordSessionSandboxState(
      buildSession({
        ...sessionState,
        podName: null,
      })
    );

    expect(patchAndFetchById).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        status: sandboxStatus,
        error: null,
      })
    );
  });

  it('opens missing chat sandbox runtime through the canonical openChatRuntime policy', async () => {
    const userIdentity = {
      userId: 'sample-user',
      githubUsername: 'sample-user',
    };
    const chatSession = buildSession({
      id: 17,
      uuid: 'sample-session',
      userId: 'sample-user',
      sessionKind: 'chat',
      status: 'active',
      workspaceStatus: 'none',
      namespace: null,
      podName: null,
      pvcName: null,
    });
    const readySession = buildSession({
      id: 17,
      uuid: 'sample-session',
      userId: 'sample-user',
      sessionKind: 'chat',
      status: 'active',
      workspaceStatus: 'ready',
      namespace: 'sample-namespace',
      podName: 'sample-pod',
      pvcName: 'sample-pvc',
    });
    mockFindSession.mockResolvedValueOnce(chatSession);
    mockOpenChatRuntime.mockResolvedValueOnce(readySession);
    mockProvisionChatRuntime.mockResolvedValueOnce(readySession);
    latestSandboxQuery(null);
    insertSandboxQuery({
      id: 9,
      status: 'ready',
      providerState: {},
      error: null,
    });
    editorExposureInsertQuery();

    const result = await AgentSandboxService.ensureChatSandbox({
      sessionId: 'sample-session',
      userId: 'sample-user',
      userIdentity: userIdentity as any,
      githubToken: 'sample-gh-token',
    });

    expect(mockOpenChatRuntime).toHaveBeenCalledWith({
      sessionId: 'sample-session',
      userId: 'sample-user',
      userIdentity,
      githubToken: 'sample-gh-token',
    });
    expect(mockProvisionChatRuntime).not.toHaveBeenCalled();
    expect(result.session).toBe(readySession);
  });

  it('passes the allowed active run id through canonical chat runtime open', async () => {
    const userIdentity = {
      userId: 'sample-user',
      githubUsername: 'sample-user',
    };
    const chatSession = buildSession({
      id: 17,
      uuid: 'sample-session',
      userId: 'sample-user',
      sessionKind: 'chat',
      status: 'active',
      workspaceStatus: 'none',
      namespace: null,
      podName: null,
      pvcName: null,
    });
    const readySession = buildSession({
      id: 17,
      uuid: 'sample-session',
      userId: 'sample-user',
      sessionKind: 'chat',
      status: 'active',
      workspaceStatus: 'ready',
      namespace: 'sample-namespace',
      podName: 'sample-pod',
      pvcName: 'sample-pvc',
    });
    mockFindSession.mockResolvedValueOnce(chatSession);
    mockOpenChatRuntime.mockResolvedValueOnce(readySession);
    latestSandboxQuery(null);
    insertSandboxQuery({
      id: 9,
      status: 'ready',
      providerState: {},
      error: null,
    });
    editorExposureInsertQuery();

    await AgentSandboxService.ensureChatSandbox({
      sessionId: 'sample-session',
      userId: 'sample-user',
      userIdentity: userIdentity as any,
      githubToken: 'sample-gh-token',
      allowedActiveRunUuid: 'run-current',
    });

    expect(mockOpenChatRuntime).toHaveBeenCalledWith({
      sessionId: 'sample-session',
      userId: 'sample-user',
      userIdentity,
      githubToken: 'sample-gh-token',
      allowedActiveRunUuid: 'run-current',
    });
  });

  it('persists only allowlisted providerState breadcrumbs from current session inputs', async () => {
    latestSandboxQuery(null);
    const insertAndFetch = insertSandboxQuery({
      id: 9,
      status: 'failed',
      providerState: {},
      error: canonicalFailure,
    });
    editorExposureInsertQuery();

    await AgentSandboxService.recordSessionSandboxState(
      buildSession({
        selectedServices: [
          {
            name: 'sample-service',
            repo: 'example-org/example-repo',
            branch: 'main',
            deployableName: 'sample-service',
            deployUuid: 'deploy-1',
            secretValue: 'do-not-store',
          },
        ],
      }),
      {
        failure: canonicalFailure,
        workspaceStorage: {
          storageSize: '10Gi',
          accessMode: 'ReadWriteOnce',
        },
      }
    );

    const providerState = insertAndFetch.mock.calls[0][0].providerState;
    expect(providerState).toEqual({
      namespace: 'sample-namespace',
      podName: 'sample-pod',
      pvcName: 'sample-pvc',
      workspaceStorage: {
        size: '10Gi',
        accessMode: 'ReadWriteOnce',
        pvcName: 'sample-pvc',
      },
      selectedServices: [
        {
          name: 'sample-service',
          repositoryFullName: 'example-org/example-repo',
          branch: 'main',
          deployableName: 'sample-service',
          deployUuid: 'deploy-1',
        },
      ],
    });
    expect(providerState).not.toHaveProperty('sourceAdapter');
    expect(providerState).not.toHaveProperty('correlationId');
    expect(providerState).not.toHaveProperty('requestId');
    expect(JSON.stringify(providerState)).not.toContain('do-not-store');
  });

  it('persists non-secret runtime plan PVC ownership metadata when provided', async () => {
    latestSandboxQuery(null);
    const insertAndFetch = insertSandboxQuery({
      id: 9,
      status: 'ready',
      providerState: {},
      metadata: {},
      error: null,
    });
    editorExposureInsertQuery();

    const runtimePlanMetadata = {
      version: 1,
      pvcName: 'prewarm-pvc',
      ownsPvc: false,
      skipWorkspaceBootstrap: true,
      compatiblePrewarmUuid: 'prewarm-1',
    };

    await AgentSandboxService.recordSessionSandboxState(
      buildSession({
        status: 'active',
        workspaceStatus: 'ready',
        pvcName: 'prewarm-pvc',
      }),
      {
        runtimePlanMetadata,
      } as any
    );

    const metadata = insertAndFetch.mock.calls[0][0].metadata;
    expect(metadata).toEqual(
      expect.objectContaining({
        sessionKind: 'environment',
        buildUuid: 'build-1',
        buildKind: 'environment',
        runtimePlan: {
          version: 1,
          pvc: {
            name: 'prewarm-pvc',
            ownsPvc: false,
            skipWorkspaceBootstrap: true,
            compatiblePrewarmUuid: 'prewarm-1',
          },
        },
      })
    );
    expect(JSON.stringify(metadata)).not.toContain('sample-provider-key');
    expect(JSON.stringify(metadata)).not.toContain('sample-github-token');
    expect(JSON.stringify(metadata)).not.toContain('SECRET_TOKEN');
    expect(JSON.stringify(metadata)).not.toContain('sample-forwarded-env-value');
    expect(JSON.stringify(metadata)).not.toContain('sample-mcp-secret');
  });

  it('records an internal sandbox status override without changing the public workspace status', async () => {
    latestSandboxQuery(null);
    const insertAndFetch = insertSandboxQuery({
      id: 9,
      status: 'suspending',
      providerState: {},
      metadata: {},
      error: null,
    });

    const session = buildSession({
      status: 'active',
      workspaceStatus: 'ready',
      podName: null,
    });

    await AgentSandboxService.recordSessionSandboxState(session, {
      sandboxStatus: 'suspending',
    });

    expect(insertAndFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'suspending',
      })
    );
    expect(session.workspaceStatus).toBe('ready');
  });

  it('merges runtime lifecycle metadata while preserving runtime plan PVC metadata', async () => {
    latestSandboxQuery({
      id: 9,
      providerState: {},
      error: null,
      metadata: {
        runtimePlan: {
          version: 1,
          pvc: {
            name: 'prewarm-pvc',
            ownsPvc: false,
            skipWorkspaceBootstrap: true,
            compatiblePrewarmUuid: 'prewarm-1',
          },
        },
      },
    });
    const patchAndFetchById = patchSandboxQuery({ id: 9, status: 'ready', error: null });

    await AgentSandboxService.recordSessionSandboxState(
      buildSession({
        status: 'active',
        workspaceStatus: 'ready',
        podName: null,
        pvcName: 'prewarm-pvc',
      }),
      {
        runtimeLifecycle: {
          currentAction: 'suspend',
          claimedAt: '2026-05-09T00:10:00.000Z',
        },
      }
    );

    expect(patchAndFetchById).toHaveBeenCalledWith(
      9,
      expect.objectContaining({
        metadata: expect.objectContaining({
          runtimePlan: {
            version: 1,
            pvc: {
              name: 'prewarm-pvc',
              ownsPvc: false,
              skipWorkspaceBootstrap: true,
              compatiblePrewarmUuid: 'prewarm-1',
            },
          },
          runtimeLifecycle: {
            currentAction: 'suspend',
            claimedAt: '2026-05-09T00:10:00.000Z',
          },
        }),
      })
    );
  });

  it('clears runtime lifecycle metadata without dropping safe metadata', async () => {
    latestSandboxQuery({
      id: 9,
      providerState: {},
      error: null,
      metadata: {
        runtimePlan: {
          version: 1,
          pvc: {
            name: 'prewarm-pvc',
            ownsPvc: false,
            skipWorkspaceBootstrap: true,
            compatiblePrewarmUuid: 'prewarm-1',
          },
        },
        runtimeLifecycle: {
          currentAction: 'cleanup',
          claimedAt: '2026-05-09T00:10:00.000Z',
        },
      },
    });
    const patchAndFetchById = patchSandboxQuery({ id: 9, status: 'ready', error: null });

    await AgentSandboxService.recordSessionSandboxState(
      buildSession({
        status: 'active',
        workspaceStatus: 'ready',
        podName: null,
        pvcName: 'prewarm-pvc',
      }),
      {
        runtimeLifecycle: null,
      }
    );

    const metadata = patchAndFetchById.mock.calls[0][1].metadata;
    expect(metadata).toEqual({
      sessionKind: 'environment',
      buildUuid: 'build-1',
      buildKind: 'environment',
      runtimePlan: {
        version: 1,
        pvc: {
          name: 'prewarm-pvc',
          ownsPvc: false,
          skipWorkspaceBootstrap: true,
          compatiblePrewarmUuid: 'prewarm-1',
        },
      },
    });
    expect(metadata).not.toHaveProperty('runtimeLifecycle');
  });

  it('reads latest runtime plan PVC metadata from the durable sandbox row', async () => {
    latestSandboxQuery({
      id: 9,
      metadata: {
        runtimePlan: {
          version: 1,
          pvc: {
            name: 'prewarm-pvc',
            ownsPvc: false,
            skipWorkspaceBootstrap: true,
            compatiblePrewarmUuid: 'prewarm-1',
          },
        },
      },
    });

    await expect(AgentSandboxService.getLatestRuntimePlanPvcMetadata(17)).resolves.toEqual({
      name: 'prewarm-pvc',
      ownsPvc: false,
      skipWorkspaceBootstrap: true,
      compatiblePrewarmUuid: 'prewarm-1',
    });
  });

  it('returns null when durable runtime plan PVC metadata is missing or malformed', async () => {
    latestSandboxQuery({
      id: 9,
      metadata: {
        runtimePlan: {
          version: 1,
          pvc: {
            name: 'prewarm-pvc',
            ownsPvc: 'false',
            skipWorkspaceBootstrap: true,
          },
        },
      },
    });

    await expect(AgentSandboxService.getLatestRuntimePlanPvcMetadata(17)).resolves.toBeNull();
  });

  describe('resolveWorkspaceGatewayEndpoint', () => {
    it('returns null when the session is missing', async () => {
      mockFindSession.mockResolvedValueOnce(null);

      await expect(AgentSandboxService.resolveWorkspaceGatewayEndpoint('session-1')).resolves.toBeNull();
      expect(mockSandboxQuery).not.toHaveBeenCalled();
    });

    it('returns null when the session is not active', async () => {
      mockFindSession.mockResolvedValueOnce(buildSession({ status: 'archived' }));

      await expect(AgentSandboxService.resolveWorkspaceGatewayEndpoint('session-1')).resolves.toBeNull();
      expect(mockSandboxQuery).not.toHaveBeenCalled();
    });

    it('returns null when no sandbox row exists', async () => {
      mockFindSession.mockResolvedValueOnce(buildSession({ status: 'active', workspaceStatus: 'ready' }));
      latestSandboxQuery(null);

      await expect(AgentSandboxService.resolveWorkspaceGatewayEndpoint('session-1')).resolves.toBeNull();
    });

    it('resolves an opensandbox gateway endpoint with access headers without writing sandbox state', async () => {
      const recordSpy = jest.spyOn(AgentSandboxService, 'recordSessionSandboxState');
      mockResolveBackendConfig.mockResolvedValue({
        provider: 'lifecycle_kubernetes',
        opensandbox: { apiKey: 'osb-key' },
      });
      mockFindSession.mockResolvedValueOnce(buildSession({ status: 'active', workspaceStatus: 'ready' }));
      latestSandboxQuery({
        id: 9,
        provider: 'opensandbox',
        providerState: {
          sandboxId: 'sb-1',
          lifecycleBaseUrl: 'https://osb.example/v1',
          gatewayUrl: 'https://gw.example',
          gatewayHeaders: { Host: 'gw.internal' },
        },
      });

      await expect(AgentSandboxService.resolveWorkspaceGatewayEndpoint('session-1')).resolves.toEqual({
        url: 'https://gw.example',
        headers: {
          'OPEN-SANDBOX-API-KEY': 'osb-key',
          Host: 'gw.internal',
        },
      });

      expect(recordSpy).not.toHaveBeenCalled();
      expect(mockSandboxQuery).toHaveBeenCalledTimes(1);
      expect(mockExposureQuery).not.toHaveBeenCalled();
      recordSpy.mockRestore();
    });

    it('returns null for an opensandbox sandbox without a gateway url', async () => {
      mockFindSession.mockResolvedValueOnce(buildSession({ status: 'active', workspaceStatus: 'ready' }));
      latestSandboxQuery({
        id: 9,
        provider: 'opensandbox',
        providerState: { sandboxId: 'sb-1', lifecycleBaseUrl: 'https://osb.example/v1' },
      });

      await expect(AgentSandboxService.resolveWorkspaceGatewayEndpoint('session-1')).resolves.toBeNull();
    });

    it('adds the decrypted gateway bearer header for kubernetes rows that carry a token', async () => {
      mockFindSession.mockResolvedValueOnce(buildSession({ status: 'active', workspaceStatus: 'ready' }));
      latestSandboxQuery({
        id: 9,
        provider: 'lifecycle_kubernetes',
        providerState: { podName: 'state-pod', namespace: 'state-ns', gatewayToken: 'enc:k8s-token' },
      });

      await expect(AgentSandboxService.resolveWorkspaceGatewayEndpoint('session-1')).resolves.toEqual({
        url: `http://state-pod.state-ns.svc.cluster.local:${GATEWAY_PORT}`,
        headers: { Authorization: 'Bearer k8s-token', 'x-lifecycle-gateway-token': 'k8s-token' },
      });
    });

    it('adds the gateway bearer header alongside opensandbox access headers', async () => {
      mockResolveBackendConfig.mockResolvedValue({
        provider: 'lifecycle_kubernetes',
        opensandbox: { apiKey: 'osb-key' },
      });
      mockFindSession.mockResolvedValueOnce(buildSession({ status: 'active', workspaceStatus: 'ready' }));
      latestSandboxQuery({
        id: 9,
        provider: 'opensandbox',
        providerState: {
          sandboxId: 'sb-1',
          lifecycleBaseUrl: 'https://osb.example/v1',
          gatewayUrl: 'https://gw.example',
          gatewayHeaders: { Host: 'gw.internal' },
          gatewayToken: 'enc:osb-token',
        },
      });

      await expect(AgentSandboxService.resolveWorkspaceGatewayEndpoint('session-1')).resolves.toEqual({
        url: 'https://gw.example',
        headers: {
          'OPEN-SANDBOX-API-KEY': 'osb-key',
          Host: 'gw.internal',
          Authorization: 'Bearer osb-token',
          'x-lifecycle-gateway-token': 'osb-token',
        },
      });
    });

    it('fails clearly when the persisted gateway token cannot be decrypted', async () => {
      mockFindSession.mockResolvedValueOnce(buildSession({ status: 'active', workspaceStatus: 'ready' }));
      latestSandboxQuery({
        id: 9,
        provider: 'lifecycle_kubernetes',
        providerState: { podName: 'state-pod', namespace: 'state-ns', gatewayToken: 'garbled' },
      });

      await expect(AgentSandboxService.resolveWorkspaceGatewayEndpoint('session-1')).rejects.toThrow(
        'could not be decrypted'
      );
    });

    it('resolves kubernetes pod DNS from sandbox provider state', async () => {
      mockFindSession.mockResolvedValueOnce(buildSession({ status: 'active', workspaceStatus: 'ready' }));
      latestSandboxQuery({
        id: 9,
        provider: 'lifecycle_kubernetes',
        providerState: { podName: 'state-pod', namespace: 'state-ns' },
      });

      await expect(AgentSandboxService.resolveWorkspaceGatewayEndpoint('session-1')).resolves.toEqual({
        url: `http://state-pod.state-ns.svc.cluster.local:${GATEWAY_PORT}`,
      });
    });

    it('falls back to session pod fields when kubernetes provider state lacks them', async () => {
      mockFindSession.mockResolvedValueOnce(buildSession({ status: 'active', workspaceStatus: 'ready' }));
      latestSandboxQuery({ id: 9, provider: 'lifecycle_kubernetes', providerState: {} });

      await expect(AgentSandboxService.resolveWorkspaceGatewayEndpoint('session-1')).resolves.toEqual({
        url: `http://sample-pod.sample-namespace.svc.cluster.local:${GATEWAY_PORT}`,
      });
    });

    it('returns null when neither provider state nor session identify the pod', async () => {
      mockFindSession.mockResolvedValueOnce(
        buildSession({ status: 'active', workspaceStatus: 'ready', podName: null, namespace: null })
      );
      latestSandboxQuery({ id: 9, provider: 'lifecycle_kubernetes', providerState: {} });

      await expect(AgentSandboxService.resolveWorkspaceGatewayEndpoint('session-1')).resolves.toBeNull();
    });
  });

  describe('resolveGatewayEndpointForSandbox', () => {
    it('mints auth from the given sandbox row, not the latest generation', async () => {
      mockResolveBackendConfig.mockResolvedValue({
        provider: 'lifecycle_kubernetes',
        opensandbox: { apiKey: 'osb-key' },
      });

      // Older-generation sandbox (the one a preview exposure points at) — no session/latest lookup.
      const endpoint = await AgentSandboxService.resolveGatewayEndpointForSandbox({
        id: 3,
        provider: 'opensandbox',
        providerState: {
          sandboxId: 'sb-old',
          lifecycleBaseUrl: 'https://osb.example/v1',
          gatewayUrl: 'https://gw-old.example',
          gatewayToken: 'enc:old-generation-token',
        },
      } as never);

      expect(endpoint).toEqual({
        url: 'https://gw-old.example',
        headers: {
          'OPEN-SANDBOX-API-KEY': 'osb-key',
          Authorization: 'Bearer old-generation-token',
          'x-lifecycle-gateway-token': 'old-generation-token',
        },
      });
      expect(mockFindSession).not.toHaveBeenCalled();
      expect(mockSandboxQuery).not.toHaveBeenCalled();
    });

    it('falls back to session pod fields for kubernetes rows without them', async () => {
      const endpoint = await AgentSandboxService.resolveGatewayEndpointForSandbox(
        { id: 3, provider: 'lifecycle_kubernetes', providerState: {} } as never,
        { podName: 'session-pod', namespace: 'session-ns' } as never
      );

      expect(endpoint).toEqual({
        url: `http://session-pod.session-ns.svc.cluster.local:${GATEWAY_PORT}`,
      });
    });
  });

  describe('deriveWorkspaceBackendForAction', () => {
    it('derives the remote backend when the stamped provider has a persisted handle', async () => {
      mockResolveBackendConfig.mockResolvedValue({
        provider: 'lifecycle_kubernetes',
        opensandbox: { apiKey: 'osb-key' },
      });
      latestSandboxQuery({
        id: 9,
        provider: 'opensandbox',
        providerState: { sandboxId: 'sb-1', lifecycleBaseUrl: 'https://osb.example/v1' },
      });

      const derived = await AgentSandboxService.deriveWorkspaceBackendForAction(
        buildSession({ status: 'active', workspaceStatus: 'ready' })
      );

      expect(derived.backendId).toBe('opensandbox');
      expect(derived.provider).not.toBeNull();
      expect(derived.state).toEqual({ sandboxId: 'sb-1', lifecycleBaseUrl: 'https://osb.example/v1' });
    });

    it('derives kubernetes for a stale remote stamp without a persisted handle', async () => {
      mockResolveBackendConfig.mockResolvedValue({
        provider: 'lifecycle_kubernetes',
        opensandbox: { apiKey: 'osb-key' },
      });
      latestSandboxQuery({ id: 9, provider: 'opensandbox', providerState: {} });

      const derived = await AgentSandboxService.deriveWorkspaceBackendForAction(buildSession());

      expect(derived).toMatchObject({ backendId: 'lifecycle_kubernetes', provider: null });
    });

    it('derives kubernetes when no sandbox row exists', async () => {
      latestSandboxQuery(null);

      const derived = await AgentSandboxService.deriveWorkspaceBackendForAction(buildSession());

      expect(derived).toMatchObject({ backendId: 'lifecycle_kubernetes', provider: null });
    });

    it('derives kubernetes for an unknown backend stamp instead of throwing', async () => {
      latestSandboxQuery({ id: 9, provider: 'no-such-backend', providerState: {} });

      const derived = await AgentSandboxService.deriveWorkspaceBackendForAction(buildSession());

      expect(derived).toMatchObject({ backendId: 'lifecycle_kubernetes', provider: null });
    });

    it('keeps failing loudly when an unknown stamp still looks like a live remote handle', async () => {
      latestSandboxQuery({ id: 9, provider: 'no-such-backend', providerState: { sandboxId: 'sb-live' } });

      await expect(AgentSandboxService.deriveWorkspaceBackendForAction(buildSession())).rejects.toThrow(
        'no-such-backend'
      );
    });
  });

  describe('resolveWorkspaceEditorEndpoint', () => {
    it('returns null for kubernetes sandboxes', async () => {
      mockFindSession.mockResolvedValueOnce(buildSession({ status: 'active', workspaceStatus: 'ready' }));
      latestSandboxQuery({
        id: 9,
        provider: 'lifecycle_kubernetes',
        providerState: { podName: 'state-pod', namespace: 'state-ns' },
      });

      await expect(AgentSandboxService.resolveWorkspaceEditorEndpoint('session-1')).resolves.toBeNull();
    });

    it('returns null for an opensandbox sandbox without an editor url', async () => {
      mockFindSession.mockResolvedValueOnce(buildSession({ status: 'active', workspaceStatus: 'ready' }));
      latestSandboxQuery({
        id: 9,
        provider: 'opensandbox',
        providerState: { sandboxId: 'sb-1', lifecycleBaseUrl: 'https://osb.example/v1' },
      });

      await expect(AgentSandboxService.resolveWorkspaceEditorEndpoint('session-1')).resolves.toBeNull();
    });

    it('resolves the opensandbox editor url with access headers but never the gateway bearer token', async () => {
      mockResolveBackendConfig.mockResolvedValue({
        provider: 'lifecycle_kubernetes',
        opensandbox: { apiKey: 'osb-key' },
      });
      mockFindSession.mockResolvedValueOnce(buildSession({ status: 'active', workspaceStatus: 'ready' }));
      latestSandboxQuery({
        id: 9,
        provider: 'opensandbox',
        providerState: {
          sandboxId: 'sb-1',
          lifecycleBaseUrl: 'https://osb.example/v1',
          editorUrl: 'https://editor.example',
          editorHeaders: { Host: 'editor.internal' },
          gatewayToken: 'enc:osb-token',
        },
      });

      // Exact match: the editor is a separate process, so no Authorization header may leak here.
      await expect(AgentSandboxService.resolveWorkspaceEditorEndpoint('session-1')).resolves.toEqual({
        url: 'https://editor.example',
        headers: {
          'OPEN-SANDBOX-API-KEY': 'osb-key',
          Host: 'editor.internal',
        },
      });
    });
  });

  describe('gateway token persistence', () => {
    it('carries the encrypted gateway token over kubernetes provider-state rewrites', async () => {
      latestSandboxQuery({
        id: 9,
        provider: 'lifecycle_kubernetes',
        providerState: { namespace: 'sample-namespace', podName: 'sample-pod', gatewayToken: 'enc:tok-1' },
        metadata: {},
        error: null,
      });
      const patchAndFetchById = patchSandboxQuery({
        id: 9,
        status: 'ready',
        error: null,
        suspendedAt: null,
        endedAt: null,
      });
      editorExposureInsertQuery();

      await AgentSandboxService.recordSessionSandboxState(buildSession({ status: 'active', workspaceStatus: 'ready' }));

      expect(patchAndFetchById).toHaveBeenCalledWith(
        9,
        expect.objectContaining({
          providerState: expect.objectContaining({ gatewayToken: 'enc:tok-1', podName: 'sample-pod' }),
        })
      );
    });

    it('replaces the carried token when a state write provides a fresh ciphertext', async () => {
      latestSandboxQuery({
        id: 9,
        provider: 'lifecycle_kubernetes',
        providerState: { namespace: 'sample-namespace', podName: 'sample-pod', gatewayToken: 'enc:tok-1' },
        metadata: {},
        error: null,
      });
      const patchAndFetchById = patchSandboxQuery({
        id: 9,
        status: 'ready',
        error: null,
        suspendedAt: null,
        endedAt: null,
      });
      editorExposureInsertQuery();

      await AgentSandboxService.recordSessionSandboxState(
        buildSession({ status: 'active', workspaceStatus: 'ready' }),
        {
          providerState: { gatewayToken: 'enc:tok-2' },
        }
      );

      expect(patchAndFetchById).toHaveBeenCalledWith(
        9,
        expect.objectContaining({
          providerState: expect.objectContaining({ gatewayToken: 'enc:tok-2' }),
        })
      );
    });
  });

  it('revives an ended editor exposure row instead of inserting a duplicate', async () => {
    latestSandboxQuery({
      id: 9,
      provider: 'lifecycle_kubernetes',
      providerState: {},
      metadata: {},
      error: null,
    });
    patchSandboxQuery({ id: 9, status: 'ready', error: null, suspendedAt: null, endedAt: null });
    const patchExposure = editorExposureReviveQuery({
      id: 42,
      kind: 'editor',
      status: 'ended',
      endedAt: '2026-05-09T00:00:00.000Z',
    });

    await AgentSandboxService.recordSessionSandboxState(buildSession({ status: 'active', workspaceStatus: 'ready' }));

    expect(patchExposure).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        status: 'ready',
        url: '/api/agent-session/workspace-editor/session-1/',
        lastVerifiedAt: expect.any(String),
        endedAt: null,
      })
    );
    expect(mockExposureQuery).toHaveBeenCalledTimes(2);
    const exposureResults = mockExposureQuery.mock.results.map((result) => result.value);
    expect(exposureResults.some((query) => query.insert)).toBe(false);
  });

  it('revives an ended preview exposure row instead of inserting a duplicate', async () => {
    latestSandboxQuery({
      id: 9,
      provider: 'e2b',
      providerState: { sandboxId: 'sb-1' },
      metadata: {},
      error: null,
    });
    const patchExposure = editorExposureReviveQuery({
      id: 44,
      kind: 'preview',
      targetPort: 3000,
      status: 'ended',
      endedAt: '2026-05-09T00:00:00.000Z',
    });

    await AgentSandboxService.recordPreviewExposure(buildSession({ status: 'active', workspaceStatus: 'ready' }), {
      port: 3000,
      url: 'http://3000--stable-slug.localhost:5001/',
      endpointUrl: 'https://3000-sb-1.e2b.app',
      attachmentKind: 'e2b_endpoint',
      previewSlug: 'stable-slug',
    });

    expect(patchExposure).toHaveBeenCalledWith(
      44,
      expect.objectContaining({
        status: 'ready',
        targetPort: 3000,
        url: 'http://3000--stable-slug.localhost:5001/',
        metadata: expect.objectContaining({ previewSlug: 'stable-slug' }),
        // Auth headers are never persisted at rest; the proxy re-resolves them per request.
        providerState: {
          url: 'https://3000-sb-1.e2b.app',
        },
        lastVerifiedAt: expect.any(String),
        endedAt: null,
      })
    );
  });

  it('restores previously published preview ports through the current workspace gateway after resume', async () => {
    latestSandboxQuery({
      id: 9,
      provider: 'lifecycle_kubernetes',
      status: 'ready',
      providerState: { podName: 'state-pod', namespace: 'state-ns', gatewayToken: 'enc:k8s-token' },
      metadata: {},
      error: null,
    });
    previewExposureListQuery([
      {
        id: 45,
        kind: 'preview',
        targetPort: 3000,
        status: 'ended',
        metadata: { previewSlug: 'stable-slug' },
      },
      {
        id: 43,
        kind: 'preview',
        targetPort: 3000,
        status: 'ended',
        metadata: { previewSlug: 'older-slug' },
      },
    ]);
    const patchExposure = editorExposureReviveQuery({
      id: 45,
      kind: 'preview',
      targetPort: 3000,
      status: 'ended',
      endedAt: '2026-05-09T00:00:00.000Z',
    });
    mockFindSession.mockResolvedValueOnce(buildSession({ status: 'active', workspaceStatus: 'ready' }));
    latestSandboxQuery({
      id: 9,
      provider: 'lifecycle_kubernetes',
      status: 'ready',
      providerState: { podName: 'state-pod', namespace: 'state-ns', gatewayToken: 'enc:k8s-token' },
      metadata: {},
      error: null,
    });

    await expect(
      AgentSandboxService.restorePreviewExposures(buildSession({ status: 'active', workspaceStatus: 'ready' }))
    ).resolves.toBe(1);

    expect(patchExposure).toHaveBeenCalledWith(
      45,
      expect.objectContaining({
        status: 'ready',
        url: 'http://3000--stable-slug.localhost:5001/',
        metadata: expect.objectContaining({ previewSlug: 'stable-slug' }),
        // The decrypted gateway bearer token must NOT be persisted at rest — only the endpoint URL.
        providerState: {
          url: `http://state-pod.state-ns.svc.cluster.local:${GATEWAY_PORT}/preview/3000`,
        },
        endedAt: null,
      })
    );
  });
});
