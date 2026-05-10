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

jest.mock('server/models/AgentRun', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/lib/dependencies', () => ({}));

jest.mock('../RunEventService', () => ({
  __esModule: true,
  default: {
    appendStatusEvent: jest.fn(),
    appendStatusEventForRunInTransaction: jest.fn(),
    appendChunkEventsForRunInTransaction: jest.fn(),
    notifyRunEventsInserted: jest.fn(),
  },
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => {
  const actual = jest.requireActual('server/lib/agentSession/runtimeConfig');
  return {
    __esModule: true,
    ...actual,
    resolveAgentSessionDurabilityConfig: jest.fn().mockResolvedValue({
      runExecutionLeaseMs: 30 * 60 * 1000,
      queuedRunDispatchStaleMs: 30 * 1000,
      dispatchRecoveryLimit: 50,
      maxDurablePayloadBytes: 64 * 1024,
      payloadPreviewBytes: 16 * 1024,
      fileChangePreviewChars: 4000,
    }),
  };
});

import AgentRunService from '../RunService';
import AgentRun from 'server/models/AgentRun';
import AgentSession from 'server/models/AgentSession';
import AgentRunEventService from '../RunEventService';
import { AgentRunOwnershipLostError } from '../AgentRunOwnershipLostError';
import { resolveAgentSessionDurabilityConfig } from 'server/lib/agentSession/runtimeConfig';

const mockRunQuery = AgentRun.query as jest.Mock;
const mockRunTransaction = AgentRun.transaction as jest.Mock;
const mockSessionQuery = AgentSession.query as jest.Mock;
const mockAppendStatusEvent = AgentRunEventService.appendStatusEvent as jest.Mock;
const mockAppendStatusEventForRunInTransaction = AgentRunEventService.appendStatusEventForRunInTransaction as jest.Mock;
const mockAppendChunkEventsForRunInTransaction = AgentRunEventService.appendChunkEventsForRunInTransaction as jest.Mock;
const mockNotifyRunEventsInserted = AgentRunEventService.notifyRunEventsInserted as jest.Mock;
const mockResolveDurabilityConfig = resolveAgentSessionDurabilityConfig as jest.Mock;
const VALID_RUN_UUID = '123e4567-e89b-12d3-a456-426614174000';
const runPlanSnapshot = {
  version: 1,
  capturedAt: '2026-05-01T00:00:00.000Z',
  agent: {
    id: 'system.freeform',
    label: 'Free-form',
    sourceKind: 'freeform_chat',
  },
  source: {
    id: 'source-1',
    adapter: 'blank_workspace',
    status: 'ready',
    sessionKind: 'chat',
    buildUuid: 'build-1',
    repoFullName: 'example-org/example-repo',
    branch: 'feature-branch',
    namespace: 'sample-namespace',
    freshness: {
      capturedAt: '2026-05-01T00:00:00.000Z',
      freshnessSource: 'source',
    },
  },
  model: {
    requestedProvider: null,
    requestedModel: null,
    resolvedProvider: 'openai',
    resolvedModel: 'gpt-5.4',
  },
  runtime: {
    requestedHarness: null,
    resolvedHarness: 'lifecycle_ai_sdk',
    sandboxRequirement: { filesystem: 'persistent' },
    runtimeOptions: { maxIterations: 12 },
    approvalPolicy: { defaultMode: 'require_approval', rules: {} },
  },
  prompt: {
    instructionRefs: [],
    renderedSummary: 'Sample prompt summary',
    renderedHash: 'sha256:sample-rendered-prompt',
  },
  capabilities: {
    provisionalCapabilityIds: ['read_context', 'workspace_files'],
    resolvedCapabilityAccess: [
      {
        capabilityId: 'read_context',
        availability: 'all_users',
        allowed: true,
        runtimeCapabilityKey: 'read',
        approvalMode: 'allow',
      },
      {
        capabilityId: 'workspace_files',
        availability: 'admin_only',
        allowed: false,
        reason: 'sample denied reason',
        runtimeCapabilityKey: 'workspace_write',
        approvalMode: 'require_approval',
      },
    ],
    selectedRuntimeToolChoiceIds: ['choice-read-context'],
    selectedRuntimeMcpChoiceIds: ['choice-sample-mcp'],
    selectedRuntimeCapabilityIds: ['read_context'],
    selectedRuntimeMcpConnectionRefs: ['user:sample-mcp'],
  },
  warnings: [{ code: 'sample_warning', message: 'Sample warning', detail: { hidden: true } }],
} as const;

describe('AgentRunService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunTransaction.mockImplementation(async (callback) => callback({ trx: true }));
    mockResolveDurabilityConfig.mockResolvedValue({
      runExecutionLeaseMs: 30 * 60 * 1000,
      queuedRunDispatchStaleMs: 30 * 1000,
      dispatchRecoveryLimit: 50,
      maxDurablePayloadBytes: 64 * 1024,
      payloadPreviewBytes: 16 * 1024,
      fileChangePreviewChars: 4000,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getOwnedRun', () => {
    it('rejects invalid run UUIDs before querying the database', async () => {
      await expect(AgentRunService.getOwnedRun('unavailable', 'sample-user')).rejects.toThrow('Agent run not found');

      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('queries valid run UUIDs', async () => {
      const first = jest.fn().mockResolvedValue({
        id: 1,
        uuid: VALID_RUN_UUID,
      });
      const select = jest.fn();
      const query = {
        where: jest.fn(),
        select,
      };
      const joinRelated = jest.fn().mockReturnValue(query);
      const alias = jest.fn().mockReturnValue({ joinRelated });

      query.where.mockReturnValue(query);
      select.mockReturnValue({ first });

      mockRunQuery.mockReturnValue({ alias });

      await AgentRunService.getOwnedRun(VALID_RUN_UUID, 'sample-user');

      expect(mockRunQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRunByUuid', () => {
    it('returns undefined for invalid run UUIDs without querying the database', async () => {
      await expect(AgentRunService.getRunByUuid('unavailable')).resolves.toBeUndefined();

      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('queries a valid run UUID', async () => {
      const findOne = jest.fn().mockResolvedValue({
        id: 1,
        uuid: VALID_RUN_UUID,
      });

      mockRunQuery.mockReturnValue({ findOne });

      await expect(AgentRunService.getRunByUuid(VALID_RUN_UUID)).resolves.toEqual({
        id: 1,
        uuid: VALID_RUN_UUID,
      });

      expect(findOne).toHaveBeenCalledWith({ uuid: VALID_RUN_UUID });
    });
  });

  describe('hasPriorCompletedDebugIntentRun', () => {
    it('returns false for invalid thread ids without querying the database', async () => {
      await expect(
        AgentRunService.hasPriorCompletedDebugIntentRun({
          threadId: 0,
          intents: ['diagnose'],
        })
      ).resolves.toBe(false);

      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('returns false for empty intent lists without querying the database', async () => {
      await expect(
        AgentRunService.hasPriorCompletedDebugIntentRun({
          threadId: 7,
          intents: [],
        })
      ).resolves.toBe(false);

      expect(mockRunQuery).not.toHaveBeenCalled();
    });

    it('queries completed Debug run snapshots by resolved intent', async () => {
      const query: any = {
        where: jest.fn().mockReturnThis(),
        whereRaw: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ id: 1 }),
      };
      mockRunQuery.mockReturnValue(query);

      await expect(
        AgentRunService.hasPriorCompletedDebugIntentRun({
          threadId: 7,
          intents: ['diagnose', 'investigate'],
        })
      ).resolves.toBe(true);

      expect(query.where).toHaveBeenCalledWith({ threadId: 7, status: 'completed' });
      expect(query.whereRaw).toHaveBeenCalledWith(`"runPlanSnapshot"->'agent'->>'id' = ?`, ['system.debug']);
      expect(query.whereIn).toHaveBeenCalledWith(expect.anything(), ['diagnose', 'investigate']);
      expect(query.first).toHaveBeenCalled();
    });
  });

  describe('serializeRun', () => {
    const baseRun = {
      uuid: VALID_RUN_UUID,
      threadId: 7,
      sessionId: 17,
      status: 'queued',
      requestedHarness: null,
      resolvedHarness: 'lifecycle_ai_sdk',
      requestedProvider: null,
      requestedModel: null,
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.4',
      provider: 'openai',
      model: 'gpt-5.4',
      sandboxRequirement: {},
      sandboxGeneration: null,
      queuedAt: '2026-05-01T00:00:00.000Z',
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      usageSummary: {},
      policySnapshot: { defaultMode: 'require_approval', rules: {} },
      error: null,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };

    it('returns runPlan: null for historical runs without snapshots', () => {
      expect(AgentRunService.serializeRun({ ...baseRun, runPlanSnapshot: null } as any)).toEqual(
        expect.objectContaining({
          runPlan: null,
          recovery: null,
        })
      );
    });

    it('exposes structured recovery metadata when a run is paused for manual recovery', () => {
      const serialized = AgentRunService.serializeRun({
        ...baseRun,
        runPlanSnapshot: null,
        error: {
          code: 'run_auto_resume_ineligible',
          message: 'Manual recovery required.',
          details: {
            recovery: {
              decision: 'manual_recovery_required',
              reason: 'write_capability',
              previousStatus: 'running',
              previousOwner: 'worker-1',
              evaluatedAt: '2026-05-08T12:00:00.000Z',
              resumeAttemptId: 'resume-1',
            },
          },
        },
      } as any);

      expect(serialized.recovery).toEqual({
        decision: 'manual_recovery_required',
        reason: 'write_capability',
        previousStatus: 'running',
        previousOwner: 'worker-1',
        evaluatedAt: '2026-05-08T12:00:00.000Z',
        resumeAttemptId: 'resume-1',
      });
    });

    it('returns a safe runPlan summary for versioned snapshots', () => {
      const serialized = AgentRunService.serializeRun({ ...baseRun, runPlanSnapshot } as any);

      expect(serialized).not.toHaveProperty('runPlanSnapshot');
      expect(serialized.runPlan).toEqual({
        version: 1,
        agent: {
          id: 'system.freeform',
          label: 'Free-form',
          sourceKind: 'freeform_chat',
        },
        source: {
          kind: 'freeform_chat',
          repoFullName: 'example-org/example-repo',
          branch: 'feature-branch',
          buildUuid: 'build-1',
          namespace: 'sample-namespace',
        },
        model: {
          provider: 'openai',
          model: 'gpt-5.4',
        },
        runtime: {
          harness: 'lifecycle_ai_sdk',
          maxIterations: 12,
        },
        approval: {
          defaultMode: 'require_approval',
        },
        capabilities: {
          effective: [
            {
              capabilityId: 'read_context',
              availability: 'all_users',
              allowed: true,
              approvalMode: 'allow',
            },
            {
              capabilityId: 'workspace_files',
              availability: 'admin_only',
              allowed: false,
              approvalMode: 'require_approval',
            },
          ],
          selected: {
            capabilityIds: ['read_context'],
            toolChoiceIds: ['choice-read-context'],
            mcpChoiceIds: ['choice-sample-mcp'],
          },
        },
        warnings: [{ code: 'sample_warning', message: 'Sample warning' }],
      });
      const runPlanJson = JSON.stringify(serialized.runPlan);
      for (const forbidden of [
        'renderedHash',
        'renderedSummary',
        'sha256:sample-rendered-prompt',
        'selectedRuntimeMcpConnectionRefs',
        'runtimeCapabilityKey',
        'workspace.read_file',
        'sample denied reason',
        'rules',
      ]) {
        expect(runPlanJson).not.toContain(forbidden);
      }
    });

    it('exposes only the resolved Debug intent in public run-plan summaries', () => {
      const serialized = AgentRunService.serializeRun({
        ...baseRun,
        runPlanSnapshot: {
          ...runPlanSnapshot,
          agent: {
            id: 'system.debug',
            label: 'Debug',
            sourceKind: 'build_context_chat',
          },
          debug: {
            requestedIntent: 'repair',
            resolvedIntent: 'diagnose',
            decisionSource: 'repair_guard',
            reasonCode: 'repair_requires_prior_diagnosis',
          },
        },
      } as any);

      expect(serialized.runPlan?.debug).toEqual({
        intent: 'diagnose',
      });
      const runPlanJson = JSON.stringify(serialized.runPlan);
      expect(runPlanJson).not.toContain('requestedIntent');
      expect(runPlanJson).not.toContain('decisionSource');
      expect(runPlanJson).not.toContain('reasonCode');
      expect(runPlanJson).not.toContain('repair_requires_prior_diagnosis');
    });

    it('defaults missing selected runtime choice arrays to empty arrays', () => {
      const snapshotWithoutSelections = {
        ...runPlanSnapshot,
        capabilities: {
          ...runPlanSnapshot.capabilities,
          selectedRuntimeToolChoiceIds: undefined,
          selectedRuntimeMcpChoiceIds: undefined,
          selectedRuntimeCapabilityIds: undefined,
          selectedRuntimeMcpConnectionRefs: undefined,
        },
      };

      const serialized = AgentRunService.serializeRun({
        ...baseRun,
        runPlanSnapshot: snapshotWithoutSelections,
      } as any);

      expect(serialized.runPlan?.capabilities.selected).toEqual({
        capabilityIds: [],
        toolChoiceIds: [],
        mcpChoiceIds: [],
      });
    });

    it('returns runPlan: null for snapshots missing resolved capability access', () => {
      const incompleteSnapshot = {
        ...runPlanSnapshot,
        capabilities: {
          provisionalCapabilityIds: runPlanSnapshot.capabilities.provisionalCapabilityIds,
          selectedRuntimeToolChoiceIds: ['choice-read-context'],
          selectedRuntimeMcpChoiceIds: ['choice-sample-mcp'],
          selectedRuntimeMcpConnectionRefs: ['user:sample-mcp'],
        },
      };

      const serialized = AgentRunService.serializeRun({
        ...baseRun,
        runPlanSnapshot: incompleteSnapshot,
      } as any);

      expect(serialized.runPlan).toBeNull();
    });
  });

  describe('listRunsNeedingDispatch', () => {
    it('finds stale queued runs and expired execution leases', async () => {
      const staleQueuedBuilder: any = {
        where: jest.fn().mockReturnThis(),
      };
      const expiredLeaseBuilder: any = {
        whereIn: jest.fn().mockReturnThis(),
        whereNotNull: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
      };
      const runs = [{ uuid: VALID_RUN_UUID }];
      const query: any = {
        where: jest.fn((callback) => {
          callback(staleQueuedBuilder);
          return query;
        }),
        orWhere: jest.fn((callback) => {
          callback(expiredLeaseBuilder);
          return query;
        }),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(runs),
      };
      mockRunQuery.mockReturnValue(query);

      const now = new Date('2026-04-24T12:00:00.000Z');
      await expect(
        AgentRunService.listRunsNeedingDispatch({
          now,
          queuedStaleMs: 10_000,
          limit: 25,
        })
      ).resolves.toBe(runs);

      expect(staleQueuedBuilder.where).toHaveBeenNthCalledWith(1, 'status', 'queued');
      expect(staleQueuedBuilder.where).toHaveBeenNthCalledWith(2, 'queuedAt', '<', '2026-04-24T11:59:50.000Z');
      expect(expiredLeaseBuilder.whereIn).toHaveBeenCalledWith('status', ['starting', 'running']);
      expect(expiredLeaseBuilder.whereNotNull).toHaveBeenCalledWith('leaseExpiresAt');
      expect(expiredLeaseBuilder.where).toHaveBeenCalledWith('leaseExpiresAt', '<=', '2026-04-24T12:00:00.000Z');
      expect(query.orderBy).toHaveBeenCalledWith('updatedAt', 'asc');
      expect(query.limit).toHaveBeenCalledWith(25);
    });
  });

  describe('cancelRun', () => {
    it('records cancellation through the shared status patch path', async () => {
      const runningRun = {
        id: 1,
        uuid: VALID_RUN_UUID,
        status: 'running',
      };
      const cancelledRun = {
        ...runningRun,
        status: 'cancelled',
      };
      const getOwnedRun = jest
        .spyOn(AgentRunService, 'getOwnedRun')
        .mockResolvedValueOnce(runningRun as Awaited<ReturnType<typeof AgentRunService.getOwnedRun>>)
        .mockResolvedValueOnce(cancelledRun as Awaited<ReturnType<typeof AgentRunService.getOwnedRun>>);
      const patchStatus = jest
        .spyOn(AgentRunService, 'patchStatus')
        .mockResolvedValue(cancelledRun as Awaited<ReturnType<typeof AgentRunService.patchStatus>>);

      await expect(AgentRunService.cancelRun(VALID_RUN_UUID, 'sample-user')).resolves.toBe(cancelledRun);

      expect(patchStatus).toHaveBeenCalledWith(
        VALID_RUN_UUID,
        'cancelled',
        expect.objectContaining({
          cancelledAt: expect.any(String),
          completedAt: expect.any(String),
        })
      );
      expect(getOwnedRun).toHaveBeenCalledTimes(2);
    });
  });

  describe('markFailed', () => {
    it('uses the same serialized error on the run and run.failed event payload', async () => {
      const findOne = jest.fn().mockResolvedValue({
        id: 17,
        uuid: VALID_RUN_UUID,
      });
      const patchAndFetchById = jest.fn().mockImplementation((_id, patch) =>
        Promise.resolve({
          id: 17,
          uuid: VALID_RUN_UUID,
          status: 'failed',
          ...patch,
        })
      );
      mockRunQuery.mockReturnValueOnce({ findOne }).mockReturnValueOnce({ patchAndFetchById });
      const error = Object.assign(new Error('Sample run failure.'), {
        name: 'SampleRunError',
        code: 'sample_failure',
        details: {
          reason: 'sample',
        },
      });

      const failedRun = await AgentRunService.markFailed(VALID_RUN_UUID, error, {
        totalTokens: 12,
      });
      const patch = patchAndFetchById.mock.calls[0][1];
      const eventPayload = mockAppendStatusEvent.mock.calls[0][2];

      expect(failedRun.error).toEqual(patch.error);
      expect(eventPayload.error).toEqual(failedRun.error);
      expect(mockAppendStatusEvent).toHaveBeenCalledWith(
        VALID_RUN_UUID,
        'run.failed',
        expect.objectContaining({
          status: 'failed',
          error: failedRun.error,
          usageSummary: {
            totalTokens: 12,
          },
        })
      );
    });
  });

  describe('markWaitingForInputForRecovery', () => {
    const eligibility = {
      decision: 'manual_recovery_required' as const,
      reason: 'write_capability' as const,
      previousStatus: 'running' as const,
      previousOwner: 'worker-1',
      leaseExpiresAt: '2026-05-08T11:59:00.000Z',
      evaluatedAt: '2026-05-08T12:00:00.000Z',
    };

    it('pauses an expired active run and appends a recovery status event', async () => {
      const run = {
        id: 17,
        uuid: VALID_RUN_UUID,
        status: 'running',
        executionOwner: 'worker-1',
        leaseExpiresAt: '2026-05-08T11:59:00.000Z',
        heartbeatAt: '2026-05-08T11:58:00.000Z',
        usageSummary: {},
      };
      const pausedRun = {
        ...run,
        status: 'waiting_for_input',
        executionOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        error: {
          code: 'run_auto_resume_ineligible',
          message:
            'Lifecycle paused this run because automatic recovery is not safe. Review the run and continue manually.',
          details: {
            recovery: expect.any(Object),
          },
        },
      };
      const findOne = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(run),
      });
      const patchAndFetchById = jest.fn().mockResolvedValue(pausedRun);
      mockAppendStatusEventForRunInTransaction.mockResolvedValue(44);
      mockRunQuery.mockReturnValueOnce({ findOne }).mockReturnValueOnce({ patchAndFetchById });

      await expect(
        AgentRunService.markWaitingForInputForRecovery(VALID_RUN_UUID, eligibility, {
          now: new Date('2026-05-08T12:00:00.000Z'),
          expectedExecutionOwner: 'worker-1',
          resumeAttemptId: 'resume-1',
        })
      ).resolves.toBe(pausedRun);

      expect(patchAndFetchById).toHaveBeenCalledWith(
        17,
        expect.objectContaining({
          status: 'waiting_for_input',
          executionOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          error: expect.objectContaining({
            code: 'run_auto_resume_ineligible',
            details: {
              recovery: expect.objectContaining({
                decision: 'manual_recovery_required',
                reason: 'write_capability',
                previousStatus: 'running',
                previousOwner: 'worker-1',
                resumeAttemptId: 'resume-1',
              }),
            },
          }),
        })
      );
      expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
        pausedRun,
        'run.updated',
        expect.objectContaining({
          status: 'waiting_for_input',
          error: pausedRun.error,
        }),
        { trx: true }
      );
      expect(mockNotifyRunEventsInserted).toHaveBeenCalledWith(VALID_RUN_UUID, 44);
    });

    it('does not pause when the run has been claimed by a new owner', async () => {
      const run = {
        id: 17,
        uuid: VALID_RUN_UUID,
        status: 'running',
        executionOwner: 'worker-2',
        leaseExpiresAt: '2026-05-08T11:59:00.000Z',
      };
      const findOne = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(run),
      });
      mockRunQuery.mockReturnValueOnce({ findOne });

      await expect(
        AgentRunService.markWaitingForInputForRecovery(VALID_RUN_UUID, eligibility, {
          now: new Date('2026-05-08T12:00:00.000Z'),
          expectedExecutionOwner: 'worker-1',
        })
      ).resolves.toBeNull();

      expect(mockRunQuery).toHaveBeenCalledTimes(1);
      expect(mockAppendStatusEventForRunInTransaction).not.toHaveBeenCalled();
    });

    it('can pause an owner-fenced resume run before the active lease expires', async () => {
      const run = {
        id: 17,
        uuid: VALID_RUN_UUID,
        status: 'running',
        executionOwner: 'worker-1',
        leaseExpiresAt: '2026-05-08T12:01:00.000Z',
        heartbeatAt: '2026-05-08T12:00:10.000Z',
        usageSummary: {},
      };
      const pausedRun = {
        ...run,
        status: 'waiting_for_input',
        executionOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        error: {
          code: 'run_resume_state_invalid',
          message: 'Saved state is invalid.',
          details: {
            recovery: expect.any(Object),
          },
        },
      };
      const findOne = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(run),
      });
      const patchAndFetchById = jest.fn().mockResolvedValue(pausedRun);
      mockAppendStatusEventForRunInTransaction.mockResolvedValue(45);
      mockRunQuery.mockReturnValueOnce({ findOne }).mockReturnValueOnce({ patchAndFetchById });

      await expect(
        AgentRunService.markWaitingForInputForRecovery(VALID_RUN_UUID, eligibility, {
          now: new Date('2026-05-08T12:00:30.000Z'),
          expectedExecutionOwner: 'worker-1',
          allowActiveLease: true,
          errorCode: 'run_resume_state_invalid',
          message: 'Saved state is invalid.',
          dispatchAttemptId: 'attempt-1',
        })
      ).resolves.toBe(pausedRun);

      expect(patchAndFetchById).toHaveBeenCalledWith(
        17,
        expect.objectContaining({
          status: 'waiting_for_input',
          error: expect.objectContaining({
            code: 'run_resume_state_invalid',
            details: {
              recovery: expect.objectContaining({
                decision: 'manual_recovery_required',
                previousOwner: 'worker-1',
                leaseExpiresAt: '2026-05-08T12:01:00.000Z',
                dispatchAttemptId: 'attempt-1',
              }),
            },
          }),
        })
      );
      expect(mockNotifyRunEventsInserted).toHaveBeenCalledWith(VALID_RUN_UUID, 45);
    });
  });

  describe('patchStatus', () => {
    it('emits canonical run status event names for approval waits and resumed runs', async () => {
      const findOne = jest.fn().mockResolvedValue({
        id: 17,
        uuid: VALID_RUN_UUID,
      });
      const patchAndFetchById = jest.fn().mockImplementation((_id, patch) =>
        Promise.resolve({
          id: 17,
          uuid: VALID_RUN_UUID,
          usageSummary: {},
          error: null,
          ...patch,
        })
      );
      mockRunQuery
        .mockReturnValueOnce({ findOne })
        .mockReturnValueOnce({ patchAndFetchById })
        .mockReturnValueOnce({ findOne })
        .mockReturnValueOnce({ patchAndFetchById });

      await AgentRunService.patchStatus(VALID_RUN_UUID, 'waiting_for_approval');
      await AgentRunService.patchStatus(VALID_RUN_UUID, 'queued');

      expect(mockAppendStatusEvent).toHaveBeenNthCalledWith(
        1,
        VALID_RUN_UUID,
        'run.waiting_for_approval',
        expect.objectContaining({
          status: 'waiting_for_approval',
        })
      );
      expect(mockAppendStatusEvent).toHaveBeenNthCalledWith(
        2,
        VALID_RUN_UUID,
        'run.queued',
        expect.objectContaining({
          status: 'queued',
        })
      );
    });
  });

  describe('owner-aware execution helpers', () => {
    it('updates a matching owner terminal status and emits one status event after the transition', async () => {
      const ownedRun = {
        id: 17,
        uuid: VALID_RUN_UUID,
        status: 'running',
        executionOwner: 'worker-1',
      };
      const completedRun = {
        ...ownedRun,
        status: 'completed',
        executionOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        usageSummary: {
          totalTokens: 12,
        },
      };
      const findOne = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(ownedRun),
      });
      const patchAndFetchById = jest.fn().mockResolvedValue(completedRun);
      mockAppendStatusEventForRunInTransaction.mockResolvedValue(12);

      mockRunQuery.mockReturnValueOnce({ findOne }).mockReturnValueOnce({ patchAndFetchById });

      await expect(
        AgentRunService.markCompletedForExecutionOwner(VALID_RUN_UUID, 'worker-1', {
          totalTokens: 12,
        })
      ).resolves.toBe(completedRun);

      expect(patchAndFetchById).toHaveBeenCalledWith(
        17,
        expect.objectContaining({
          status: 'completed',
          executionOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          usageSummary: {
            totalTokens: 12,
          },
        })
      );
      expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledTimes(1);
      expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
        completedRun,
        'run.completed',
        expect.objectContaining({
          status: 'completed',
          usageSummary: {
            totalTokens: 12,
          },
        }),
        { trx: true }
      );
      expect(mockNotifyRunEventsInserted).toHaveBeenCalledWith(VALID_RUN_UUID, 12);
    });

    it('throws ownership loss without patching or appending a status event when the owner is stale', async () => {
      const run = {
        id: 17,
        uuid: VALID_RUN_UUID,
        status: 'running',
        executionOwner: 'worker-2',
      };
      const findOne = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(run),
      });

      mockRunQuery.mockReturnValueOnce({ findOne });

      let error: unknown;
      try {
        await AgentRunService.markCompletedForExecutionOwner(VALID_RUN_UUID, 'worker-1', {
          totalTokens: 12,
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(AgentRunOwnershipLostError);
      expect(error).toMatchObject({
        runUuid: VALID_RUN_UUID,
        expectedExecutionOwner: 'worker-1',
        currentStatus: 'running',
        currentExecutionOwner: 'worker-2',
      });

      expect(mockRunQuery).toHaveBeenCalledTimes(1);
      expect(mockAppendStatusEvent).not.toHaveBeenCalled();
      expect(mockAppendStatusEventForRunInTransaction).not.toHaveBeenCalled();
    });

    it('does not append stream chunks when the owner is stale', async () => {
      const run = {
        id: 17,
        uuid: VALID_RUN_UUID,
        status: 'running',
        executionOwner: 'worker-2',
      };
      const findOne = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(run),
      });
      const beforeAppendChunks = jest.fn();

      mockRunQuery.mockReturnValueOnce({ findOne });

      await expect(
        AgentRunService.appendStreamChunksForExecutionOwner(
          VALID_RUN_UUID,
          'worker-1',
          [{ type: 'text-delta', id: 'text-1', delta: 'stale' } as any],
          { beforeAppendChunks }
        )
      ).rejects.toBeInstanceOf(AgentRunOwnershipLostError);

      expect(beforeAppendChunks).not.toHaveBeenCalled();
      expect(mockAppendChunkEventsForRunInTransaction).not.toHaveBeenCalled();
    });

    it('does not run final message sync when the owner is stale', async () => {
      const run = {
        id: 17,
        uuid: VALID_RUN_UUID,
        status: 'running',
        executionOwner: 'worker-2',
      };
      const findOne = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(run),
      });
      const finalize = jest.fn();

      mockRunQuery.mockReturnValueOnce({ findOne });

      await expect(
        AgentRunService.finalizeRunForExecutionOwner(VALID_RUN_UUID, 'worker-1', finalize)
      ).rejects.toBeInstanceOf(AgentRunOwnershipLostError);

      expect(finalize).not.toHaveBeenCalled();
      expect(mockAppendStatusEventForRunInTransaction).not.toHaveBeenCalled();
    });

    it('releases ownership when finalization queues a resolved approval continuation', async () => {
      const ownedRun = {
        id: 17,
        uuid: VALID_RUN_UUID,
        status: 'running',
        executionOwner: 'worker-1',
      };
      const queuedRun = {
        ...ownedRun,
        status: 'queued',
        executionOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      };
      const findOne = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(ownedRun),
      });
      const patchAndFetchById = jest.fn().mockResolvedValue(queuedRun);
      const finalize = jest.fn().mockResolvedValue({
        status: 'queued',
        patch: {
          queuedAt: '2026-04-24T12:00:00.000Z',
        },
      });
      mockAppendStatusEventForRunInTransaction.mockResolvedValue(31);

      mockRunQuery.mockReturnValueOnce({ findOne }).mockReturnValueOnce({ patchAndFetchById });

      await expect(AgentRunService.finalizeRunForExecutionOwner(VALID_RUN_UUID, 'worker-1', finalize)).resolves.toBe(
        queuedRun
      );

      expect(patchAndFetchById).toHaveBeenCalledWith(
        17,
        expect.objectContaining({
          status: 'queued',
          queuedAt: '2026-04-24T12:00:00.000Z',
          executionOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        })
      );
      expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
        queuedRun,
        'run.queued',
        expect.objectContaining({
          status: 'queued',
          executionOwner: 'worker-1',
        }),
        { trx: true }
      );
      expect(mockNotifyRunEventsInserted).toHaveBeenCalledWith(VALID_RUN_UUID, 31);
    });
  });

  describe('heartbeatRunExecution', () => {
    it('throws ownership loss when the conditional heartbeat update matches no rows', async () => {
      const patch = jest.fn().mockResolvedValue(0);
      const heartbeatQuery = {
        where: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        patch,
      };
      const findOne = jest.fn().mockResolvedValue({
        uuid: VALID_RUN_UUID,
        status: 'running',
        executionOwner: 'worker-2',
      });
      mockRunQuery.mockReturnValueOnce(heartbeatQuery).mockReturnValueOnce({ findOne });

      await expect(AgentRunService.heartbeatRunExecution(VALID_RUN_UUID, 'worker-1')).rejects.toMatchObject({
        runUuid: VALID_RUN_UUID,
        expectedExecutionOwner: 'worker-1',
        currentStatus: 'running',
        currentExecutionOwner: 'worker-2',
      });
    });
  });

  describe('claimQueuedRunForExecution', () => {
    it('claims a queued run under a session row lock', async () => {
      const run = {
        id: 17,
        uuid: VALID_RUN_UUID,
        sessionId: 23,
        status: 'queued',
      };
      const findOne = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(run),
      });
      const patchAndFetchById = jest.fn().mockResolvedValue({
        ...run,
        status: 'starting',
        executionOwner: 'worker-1',
      });
      mockRunQuery.mockReturnValueOnce({ findOne }).mockReturnValueOnce({ patchAndFetchById });
      mockSessionQuery.mockReturnValue({
        findById: jest.fn().mockReturnValue({
          forUpdate: jest.fn().mockResolvedValue({ id: 23 }),
        }),
      });

      await expect(
        AgentRunService.claimQueuedRunForExecution(VALID_RUN_UUID, 'worker-1', 30 * 60 * 1000)
      ).resolves.toEqual(
        expect.objectContaining({
          status: 'starting',
          executionOwner: 'worker-1',
        })
      );

      expect(findOne).toHaveBeenCalledWith({ uuid: VALID_RUN_UUID });
      expect(patchAndFetchById).toHaveBeenCalledWith(
        17,
        expect.objectContaining({
          status: 'starting',
          executionOwner: 'worker-1',
          leaseExpiresAt: expect.any(String),
          heartbeatAt: expect.any(String),
        })
      );
    });

    it('skips a run that is already owned and not stale', async () => {
      const run = {
        id: 17,
        uuid: VALID_RUN_UUID,
        sessionId: 23,
        status: 'running',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const findOne = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(run),
      });
      mockRunQuery.mockReturnValueOnce({ findOne });

      await expect(
        AgentRunService.claimQueuedRunForExecution(VALID_RUN_UUID, 'worker-1', 30 * 60 * 1000)
      ).resolves.toBeNull();
    });
  });
});
