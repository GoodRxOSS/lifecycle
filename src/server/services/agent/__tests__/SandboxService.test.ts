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

import type { WorkspaceRuntimeFailure } from 'server/lib/agentSession/startupFailureState';
import AgentSandbox from 'server/models/AgentSandbox';
import AgentSandboxExposure from 'server/models/AgentSandboxExposure';
import AgentSandboxService from '../SandboxService';

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
    endedAt: null,
    ...overrides,
  } as Parameters<typeof AgentSandboxService.recordSessionSandboxState>[0];
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
  existingQuery.first = jest.fn().mockResolvedValue(null);

  const insert = jest.fn().mockResolvedValue({ id: 5 });
  mockExposureQuery.mockReturnValueOnce(existingQuery).mockReturnValueOnce({ insert });
  return insert;
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
    ['ended', { status: 'ended', workspaceStatus: 'ended', endedAt: '2026-05-09T00:05:00.000Z' }, 'ended'],
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
});
