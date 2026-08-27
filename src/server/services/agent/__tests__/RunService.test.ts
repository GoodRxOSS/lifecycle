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
    knex: jest.fn(),
  },
}));

jest.mock('server/models/AgentSession', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/models/AgentThread', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
  },
}));

jest.mock('server/models/AgentPendingAction', () => ({
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
    appendEventsForChunks: jest.fn(),
    notifyRunEventsInserted: jest.fn(),
  },
}));

jest.mock('../runInterruptedMessagePersistence', () => ({
  persistInterruptedRunAssistantMessage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('server/lib/agentSession/runtimeConfig', () => {
  return {
    __esModule: true,
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

import AgentRunService, { ActiveAgentRunError, InvalidAgentRunDefaultsError } from '../RunService';
import AgentRun from 'server/models/AgentRun';
import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';
import AgentPendingAction from 'server/models/AgentPendingAction';
import AgentRunEventService from '../RunEventService';
import { AgentRunOwnershipLostError } from '../AgentRunOwnershipLostError';
import { resolveAgentSessionDurabilityConfig } from 'server/lib/agentSession/runtimeConfig';
import { persistInterruptedRunAssistantMessage } from '../runInterruptedMessagePersistence';

const mockRunQuery = AgentRun.query as jest.Mock;
const mockPendingActionQuery = AgentPendingAction.query as jest.Mock;
const mockRunTransaction = AgentRun.transaction as jest.Mock;
const mockRunKnex = AgentRun.knex as jest.Mock;
const mockSessionQuery = AgentSession.query as jest.Mock;
const mockThreadQuery = AgentThread.query as jest.Mock;
const mockAppendStatusEvent = AgentRunEventService.appendStatusEvent as jest.Mock;
const mockAppendStatusEventForRunInTransaction = AgentRunEventService.appendStatusEventForRunInTransaction as jest.Mock;
const mockAppendChunkEventsForRunInTransaction = AgentRunEventService.appendChunkEventsForRunInTransaction as jest.Mock;
const mockAppendEventsForChunks = AgentRunEventService.appendEventsForChunks as jest.Mock;
const mockNotifyRunEventsInserted = AgentRunEventService.notifyRunEventsInserted as jest.Mock;
const mockResolveDurabilityConfig = resolveAgentSessionDurabilityConfig as jest.Mock;
const mockPersistInterruptedRunAssistantMessage = persistInterruptedRunAssistantMessage as jest.Mock;
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
    mockRunKnex.mockReturnValue({ raw: jest.fn().mockResolvedValue(undefined) });
    mockPendingActionQuery.mockReturnValue({
      where: jest.fn().mockReturnValue({ delete: jest.fn().mockResolvedValue(0) }),
    });
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
      expect(query.whereRaw).toHaveBeenCalledWith(`"runPlanSnapshot"->'agent'->>'sourceKind' = ?`, [
        'build_context_chat',
      ]);
      expect(query.whereIn).toHaveBeenCalledWith(expect.anything(), ['diagnose', 'investigate']);
      expect(query.first).toHaveBeenCalled();
    });

    it('scopes completed Debug run snapshots to the current build and selected deploy', async () => {
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
          buildUuid: 'build-1',
          selectedDeployUuid: 'deploy-1',
        })
      ).resolves.toBe(true);

      expect(query.whereRaw).toHaveBeenCalledWith(`"runPlanSnapshot"->'agent'->>'sourceKind' = ?`, [
        'build_context_chat',
      ]);
      expect(query.whereRaw).toHaveBeenCalledWith(`"runPlanSnapshot"->'source'->>'buildUuid' = ?`, ['build-1']);
      expect(query.whereRaw).toHaveBeenCalledWith(
        `"runPlanSnapshot"->'source'->'selectedDeploy'->>'selectedDeployUuid' = ?`,
        ['deploy-1']
      );
      expect(query.first).toHaveBeenCalled();
    });
  });

  describe('createQueuedContinuationRunInTransaction', () => {
    it('creates a queued continuation run while excluding the locked source run from active-run checks', async () => {
      const thread = {
        id: 7,
        uuid: 'thread-1',
        metadata: {
          selectedAgentDefinitionId: 'system.develop',
        },
      };
      const session = {
        id: 17,
        uuid: 'session-1',
      };
      const sourceRun = {
        id: 11,
      };
      const queuedRun = {
        id: 12,
        uuid: 'run-continuation-1',
        status: 'queued',
        queuedAt: '2026-05-01T00:00:06.000Z',
      };
      const sessionForUpdate = jest.fn().mockResolvedValue(session);
      const findById = jest.fn().mockReturnValue({ forUpdate: sessionForUpdate });
      const activeRunQuery = {
        where: jest.fn().mockReturnThis(),
        whereNot: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(null),
      };
      const insertAndFetch = jest.fn().mockResolvedValue(queuedRun);
      const patchAndFetchById = jest.fn().mockResolvedValue(undefined);
      mockSessionQuery.mockReturnValue({ findById });
      mockRunQuery.mockReturnValueOnce(activeRunQuery).mockReturnValueOnce({ insertAndFetch });
      mockThreadQuery.mockReturnValue({ patchAndFetchById });
      mockAppendStatusEventForRunInTransaction.mockResolvedValue(77);

      await expect(
        AgentRunService.createQueuedContinuationRunInTransaction({
          thread: thread as any,
          session: session as any,
          sourceRun: sourceRun as any,
          policy: { defaultMode: 'require_approval', rules: {} as any },
          requestedHarness: null,
          requestedProvider: null,
          requestedModel: null,
          resolvedHarness: 'lifecycle_ai_sdk',
          resolvedProvider: 'openai',
          resolvedModel: 'gpt-5.4',
          sandboxRequirement: { filesystem: 'persistent' },
          runPlanSnapshot: runPlanSnapshot as any,
          trx: { trx: true } as any,
        })
      ).resolves.toEqual({
        run: queuedRun,
        queuedEventSequence: 77,
      });

      expect(findById).toHaveBeenCalledWith(17);
      expect(activeRunQuery.where).toHaveBeenCalledWith({ sessionId: 17 });
      expect(activeRunQuery.whereNot).toHaveBeenCalledWith('id', 11);
      expect(activeRunQuery.whereNotIn).toHaveBeenCalledWith('status', [
        'transitioned',
        'completed',
        'failed',
        'cancelled',
      ]);
      expect(insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 7,
          sessionId: 17,
          status: 'queued',
          resolvedHarness: 'lifecycle_ai_sdk',
          resolvedProvider: 'openai',
          resolvedModel: 'gpt-5.4',
          transition: null,
          error: null,
        })
      );
      expect(patchAndFetchById).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          metadata: expect.objectContaining({
            selectedAgentDefinitionId: 'system.develop',
            latestRunId: 'run-continuation-1',
          }),
        })
      );
      expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
        queuedRun,
        'run.queued',
        {
          threadId: 'thread-1',
          sessionId: 'session-1',
        },
        { trx: true }
      );
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
      transition: null,
      error: null,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };

    it('returns runPlan: null for historical runs without snapshots', () => {
      expect(AgentRunService.serializeRun({ ...baseRun, runPlanSnapshot: null } as any)).toEqual(
        expect.objectContaining({
          runPlan: null,
          recovery: null,
          transition: null,
        })
      );
    });

    it('exposes workspace escalation transition metadata', () => {
      const transition = {
        kind: 'workspace_escalation',
        reason: 'create a React app',
        toolCallId: 'tool-provision',
        workspaceStatus: 'provisioning',
        targetAgentDefinitionId: 'system.develop',
        createdAt: '2026-05-01T00:00:05.000Z',
        continuation: {
          status: 'ui_auto_continue_fallback',
          targetAgentDefinitionId: 'system.develop',
          runId: null,
        },
      };

      expect(
        AgentRunService.serializeRun({
          ...baseRun,
          status: 'transitioned',
          completedAt: '2026-05-01T00:00:05.000Z',
          transition,
          runPlanSnapshot: null,
        } as any)
      ).toEqual(
        expect.objectContaining({
          status: 'transitioned',
          transition,
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
        profile: {
          kind: 'answer',
          intent: 'chat',
          workspaceCore: 'absent',
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
    it('finds stale queued runs, expired execution leases, and heartbeat-stale runs', async () => {
      const staleQueuedBuilder: any = {
        where: jest.fn().mockReturnThis(),
      };
      const expiredLeaseBuilder: any = {
        whereIn: jest.fn().mockReturnThis(),
        whereNotNull: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
      };
      // Heartbeat-stale branch: starting/running runs past the staleness cutoff by heartbeat (or startedAt fallback).
      const heartbeatFallbackBuilder: any = {
        whereNull: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
      };
      const heartbeatPredicateBuilder: any = {
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn((callback) => {
          callback(heartbeatFallbackBuilder);
          return heartbeatPredicateBuilder;
        }),
      };
      const heartbeatStaleBuilder: any = {
        whereIn: jest.fn().mockReturnThis(),
        where: jest.fn((callback) => {
          callback(heartbeatPredicateBuilder);
          return heartbeatStaleBuilder;
        }),
      };
      const orWhereBuilders = [expiredLeaseBuilder, heartbeatStaleBuilder];
      const runs = [{ uuid: VALID_RUN_UUID }];
      const query: any = {
        where: jest.fn((callback) => {
          callback(staleQueuedBuilder);
          return query;
        }),
        orWhere: jest.fn((callback) => {
          callback(orWhereBuilders.shift());
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
      // Cutoff = now - heartbeatStaleMs; 30-min lease derives a 3-min window, so 12:00:00 - 3m = 11:57:00.
      expect(heartbeatStaleBuilder.whereIn).toHaveBeenCalledWith('status', ['starting', 'running']);
      expect(heartbeatPredicateBuilder.where).toHaveBeenCalledWith('heartbeatAt', '<=', '2026-04-24T11:57:00.000Z');
      expect(heartbeatFallbackBuilder.whereNull).toHaveBeenCalledWith('heartbeatAt');
      expect(heartbeatFallbackBuilder.where).toHaveBeenCalledWith('startedAt', '<=', '2026-04-24T11:57:00.000Z');
      expect(query.orderBy).toHaveBeenCalledWith('updatedAt', 'asc');
      expect(query.limit).toHaveBeenCalledWith(25);
    });
  });

  describe('cancelRun', () => {
    it('records cancellation atomically with a recovery status event when the run is still active', async () => {
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
      const findById = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(runningRun),
      });
      const patchAndFetchById = jest.fn().mockResolvedValue(cancelledRun);
      mockAppendStatusEventForRunInTransaction.mockResolvedValue(7);
      mockRunQuery.mockReturnValueOnce({ findById }).mockReturnValueOnce({ patchAndFetchById });
      const raw = jest.fn().mockResolvedValue(undefined);
      mockRunKnex.mockReturnValue({ raw });
      const pendingDelete = jest.fn().mockResolvedValue(1);
      const pendingWhere = jest.fn().mockReturnValue({ delete: pendingDelete });
      mockPendingActionQuery.mockReturnValue({ where: pendingWhere });

      await expect(AgentRunService.cancelRun(VALID_RUN_UUID, 'sample-user')).resolves.toBe(cancelledRun);

      expect(pendingWhere).toHaveBeenCalledWith({ runId: 1, status: 'pending' });
      expect(pendingDelete).toHaveBeenCalled();
      expect(findById).toHaveBeenCalledWith(1);
      expect(patchAndFetchById).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          status: 'cancelled',
          cancelledAt: expect.any(String),
          completedAt: expect.any(String),
          executionOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
        })
      );
      expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
        cancelledRun,
        'run.cancelled',
        expect.objectContaining({
          status: 'cancelled',
        }),
        { trx: true }
      );
      expect(mockNotifyRunEventsInserted).toHaveBeenCalledWith(VALID_RUN_UUID, 7);
      // Fast cross-process abort is broadcast on the dedicated cancel channel.
      expect(raw).toHaveBeenCalledWith('select pg_notify(?, ?)', [
        'agent_run_cancel',
        JSON.stringify({ runId: VALID_RUN_UUID }),
      ]);
      expect(mockAppendStatusEvent).not.toHaveBeenCalled();
      expect(getOwnedRun).toHaveBeenCalledTimes(2);
    });

    it('does not rewrite a terminal run as cancelled when completion wins the race', async () => {
      const completedRun = {
        id: 1,
        uuid: VALID_RUN_UUID,
        status: 'completed',
      };
      const getOwnedRun = jest
        .spyOn(AgentRunService, 'getOwnedRun')
        .mockResolvedValueOnce(completedRun as Awaited<ReturnType<typeof AgentRunService.getOwnedRun>>)
        .mockResolvedValueOnce(completedRun as Awaited<ReturnType<typeof AgentRunService.getOwnedRun>>);
      const patchAndFetchById = jest.fn();
      const findById = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(completedRun),
      });
      mockRunQuery.mockReturnValueOnce({ findById });
      const raw = jest.fn().mockResolvedValue(undefined);
      mockRunKnex.mockReturnValue({ raw });

      await expect(AgentRunService.cancelRun(VALID_RUN_UUID, 'sample-user')).resolves.toBe(completedRun);

      expect(mockRunQuery).toHaveBeenCalledTimes(1);
      expect(findById).toHaveBeenCalledWith(1);
      expect(patchAndFetchById).not.toHaveBeenCalled();
      expect(mockAppendStatusEvent).not.toHaveBeenCalled();
      expect(mockAppendStatusEventForRunInTransaction).not.toHaveBeenCalled();
      expect(mockNotifyRunEventsInserted).not.toHaveBeenCalled();
      // No cancellation transition occurred, so no cross-process abort is broadcast.
      expect(raw).not.toHaveBeenCalled();
      expect(getOwnedRun).toHaveBeenCalledTimes(2);
    });
  });

  describe('supersedeRecoveryPausedRunForSession', () => {
    const buildPausedLookup = (paused: unknown) => {
      const first = jest.fn().mockResolvedValue(paused);
      const orderBy = jest.fn().mockReturnValue({ first });
      const whereStatus = jest.fn().mockReturnValue({ orderBy });
      const whereSession = jest.fn().mockReturnValue({ where: whereStatus });
      mockRunQuery.mockReturnValueOnce({ where: whereSession });
      return { whereSession, whereStatus };
    };

    it('cancels a waiting_for_input run so a new message is not dead-ended', async () => {
      const { whereSession, whereStatus } = buildPausedLookup({
        id: 5,
        uuid: VALID_RUN_UUID,
        status: 'waiting_for_input',
      });
      const cancelSpy = jest
        .spyOn(AgentRunService, 'cancelRun')
        .mockResolvedValue({ uuid: VALID_RUN_UUID } as Awaited<ReturnType<typeof AgentRunService.cancelRun>>);

      await AgentRunService.supersedeRecoveryPausedRunForSession(42, 'sample-user');

      expect(whereSession).toHaveBeenCalledWith({ sessionId: 42 });
      expect(whereStatus).toHaveBeenCalledWith('status', 'waiting_for_input');
      expect(cancelSpy).toHaveBeenCalledWith(VALID_RUN_UUID, 'sample-user');
    });

    it('no-ops when the session has no paused run', async () => {
      buildPausedLookup(undefined);
      const cancelSpy = jest.spyOn(AgentRunService, 'cancelRun');

      await AgentRunService.supersedeRecoveryPausedRunForSession(42, 'sample-user');

      expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('resolves an owned session by uuid before superseding', async () => {
      const findOne = jest.fn().mockResolvedValue({ id: 42 });
      const select = jest.fn().mockReturnValue({ findOne });
      mockSessionQuery.mockReturnValueOnce({ select });
      const supersedeSpy = jest
        .spyOn(AgentRunService, 'supersedeRecoveryPausedRunForSession')
        .mockResolvedValue(undefined);

      await AgentRunService.supersedeRecoveryPausedRunForSessionUuid('session-1', 'sample-user');

      expect(findOne).toHaveBeenCalledWith({ uuid: 'session-1', userId: 'sample-user' });
      expect(supersedeSpy).toHaveBeenCalledWith(42, 'sample-user');
      supersedeSpy.mockRestore();
    });

    it('does not supersede when the session uuid is not owned by the user', async () => {
      const findOne = jest.fn().mockResolvedValue(undefined);
      const select = jest.fn().mockReturnValue({ findOne });
      mockSessionQuery.mockReturnValueOnce({ select });
      const supersedeSpy = jest
        .spyOn(AgentRunService, 'supersedeRecoveryPausedRunForSession')
        .mockResolvedValue(undefined);

      await AgentRunService.supersedeRecoveryPausedRunForSessionUuid('session-1', 'other-user');

      expect(supersedeSpy).not.toHaveBeenCalled();
      supersedeSpy.mockRestore();
    });
  });

  describe('cross-process cancel listener', () => {
    it('listens on the cancel channel and aborts the local controller on a cancel notification', async () => {
      const listeners: Record<string, (arg: any) => void> = {};
      const connection = {
        on: jest.fn((event: string, listener: (arg: any) => void) => {
          listeners[event] = listener;
        }),
        query: jest.fn().mockResolvedValue(undefined),
      };
      const acquireConnection = jest.fn().mockResolvedValue(connection);
      mockRunKnex.mockReturnValue({ client: { acquireConnection, releaseConnection: jest.fn() } });

      const controller = new AbortController();
      const abortSpy = jest.spyOn(controller, 'abort');
      // registerAbortController lazily opens the (first) shared listen connection.
      AgentRunService.registerAbortController(VALID_RUN_UUID, controller);
      await new Promise((resolve) => setImmediate(resolve));

      expect(acquireConnection).toHaveBeenCalledTimes(1);
      expect(connection.query).toHaveBeenCalledWith('LISTEN agent_run_cancel');

      listeners['notification']({ channel: 'agent_run_cancel', payload: undefined });
      listeners['notification']({ channel: 'agent_run_cancel', payload: '{not-json' });
      listeners['notification']({ channel: 'agent_run_cancel', payload: JSON.stringify({ runId: 17 }) });
      listeners['notification']({ channel: 'agent_run_cancel', payload: JSON.stringify({ runId: 'not-a-uuid' }) });
      listeners['notification']({
        channel: 'agent_run_cancel',
        payload: JSON.stringify({ runId: '223e4567-e89b-12d3-a456-426614174000' }),
      });
      expect(abortSpy).not.toHaveBeenCalled();

      // A cancel notification for the registered run aborts its controller.
      listeners['notification']({
        channel: 'agent_run_cancel',
        payload: JSON.stringify({ runId: VALID_RUN_UUID }),
      });
      expect(abortSpy).toHaveBeenCalled();

      AgentRunService.clearAbortController(VALID_RUN_UUID);
    });

    it('keeps local controller registration usable when the shared listener cannot start', async () => {
      const ensureListener = jest
        .spyOn(AgentRunService as any, 'ensureCancelNotificationListener')
        .mockRejectedValue(new Error('listen unavailable'));
      const controller = new AbortController();

      AgentRunService.registerAbortController(VALID_RUN_UUID, controller);
      await Promise.resolve();
      await Promise.resolve();
      expect(ensureListener).toHaveBeenCalledTimes(1);

      AgentRunService.clearAbortController(VALID_RUN_UUID);
      expect(controller.signal.aborted).toBe(true);
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

    it('pauses a heartbeat-stale run whose lease has not yet expired', async () => {
      // Active lease (1m out) but heartbeat 5m stale past the 3-min window: orphaned run must pause without waiting for lease expiry.
      const run = {
        id: 17,
        uuid: VALID_RUN_UUID,
        status: 'running',
        executionOwner: 'worker-1',
        leaseExpiresAt: '2026-05-08T12:01:00.000Z',
        heartbeatAt: '2026-05-08T11:55:00.000Z',
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
      mockAppendStatusEventForRunInTransaction.mockResolvedValue(46);
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
        })
      );
      expect(mockNotifyRunEventsInserted).toHaveBeenCalledWith(VALID_RUN_UUID, 46);
    });

    it('does not pause a run with an active lease and a fresh heartbeat', async () => {
      const run = {
        id: 17,
        uuid: VALID_RUN_UUID,
        status: 'running',
        executionOwner: 'worker-1',
        leaseExpiresAt: '2026-05-08T12:01:00.000Z',
        heartbeatAt: '2026-05-08T11:59:30.000Z',
        usageSummary: {},
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

    it('settles pending approval actions when a run fails, not just on cancel', async () => {
      const ownedRun = {
        id: 17,
        uuid: VALID_RUN_UUID,
        status: 'running',
        executionOwner: 'worker-1',
      };
      const failedRun = { ...ownedRun, status: 'failed', executionOwner: null };
      const findOne = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(ownedRun),
      });
      const patchAndFetchById = jest.fn().mockResolvedValue(failedRun);
      mockAppendStatusEventForRunInTransaction.mockResolvedValue(14);
      mockRunQuery.mockReturnValueOnce({ findOne }).mockReturnValueOnce({ patchAndFetchById });
      const pendingDelete = jest.fn().mockResolvedValue(1);
      const pendingWhere = jest.fn().mockReturnValue({ delete: pendingDelete });
      mockPendingActionQuery.mockReturnValue({ where: pendingWhere });

      await AgentRunService.markFailedForExecutionOwner(VALID_RUN_UUID, 'worker-1', new Error('boom'));

      expect(pendingWhere).toHaveBeenCalledWith({ runId: 17, status: 'pending' });
      expect(pendingDelete).toHaveBeenCalled();
    });

    it('finalizes a transitioned run as terminal and emits run.transitioned', async () => {
      const ownedRun = {
        id: 17,
        uuid: VALID_RUN_UUID,
        status: 'running',
        executionOwner: 'worker-1',
      };
      const transition = {
        kind: 'workspace_escalation',
        reason: 'create a React app',
        toolCallId: 'tool-provision',
        workspaceStatus: 'provisioning',
        targetAgentDefinitionId: 'system.develop',
        createdAt: '2026-05-01T00:00:05.000Z',
        continuation: {
          status: 'ui_auto_continue_fallback',
          targetAgentDefinitionId: 'system.develop',
          runId: null,
        },
      };
      const transitionedRun = {
        ...ownedRun,
        status: 'transitioned',
        executionOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        usageSummary: {
          totalTokens: 12,
        },
        transition,
      };
      const findOne = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(ownedRun),
      });
      const patchAndFetchById = jest.fn().mockResolvedValue(transitionedRun);
      mockAppendStatusEventForRunInTransaction.mockResolvedValue(13);

      mockRunQuery.mockReturnValueOnce({ findOne }).mockReturnValueOnce({ patchAndFetchById });

      await expect(
        AgentRunService.finalizeRunForExecutionOwner(VALID_RUN_UUID, 'worker-1', async () => ({
          status: 'transitioned',
          patch: {
            usageSummary: {
              totalTokens: 12,
            },
            transition,
          } as any,
        }))
      ).resolves.toBe(transitionedRun);

      expect(patchAndFetchById).toHaveBeenCalledWith(
        17,
        expect.objectContaining({
          status: 'transitioned',
          executionOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          transition,
        })
      );
      expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
        transitionedRun,
        'run.transitioned',
        expect.objectContaining({
          status: 'transitioned',
          transition,
        }),
        { trx: true }
      );
      expect(mockNotifyRunEventsInserted).toHaveBeenCalledWith(VALID_RUN_UUID, 13);
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
        heartbeatAt: new Date(Date.now() - 30_000).toISOString(),
      };
      const findOne = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(run),
      });
      mockRunQuery.mockReturnValueOnce({ findOne });

      await expect(
        AgentRunService.claimQueuedRunForExecution(VALID_RUN_UUID, 'worker-1', 30 * 60 * 1000)
      ).resolves.toBeNull();
    });

    it('reclaims a heartbeat-stale running run even when its lease is still active', async () => {
      // Active lease (10m out) but heartbeat 5m stale past the 3-min window: orphaned run must be reclaimable without waiting for lease expiry.
      const run = {
        id: 17,
        uuid: VALID_RUN_UUID,
        sessionId: 23,
        status: 'running',
        leaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      };
      const findOne = jest.fn().mockReturnValue({
        forUpdate: jest.fn().mockResolvedValue(run),
      });
      const patchAndFetchById = jest.fn().mockResolvedValue({
        ...run,
        status: 'starting',
        executionOwner: 'worker-2',
      });
      mockRunQuery.mockReturnValueOnce({ findOne }).mockReturnValueOnce({ patchAndFetchById });
      mockSessionQuery.mockReturnValue({
        findById: jest.fn().mockReturnValue({
          forUpdate: jest.fn().mockResolvedValue({ id: 23 }),
        }),
      });

      await expect(
        AgentRunService.claimQueuedRunForExecution(VALID_RUN_UUID, 'worker-2', 30 * 60 * 1000)
      ).resolves.toEqual(
        expect.objectContaining({
          status: 'starting',
          executionOwner: 'worker-2',
        })
      );

      expect(patchAndFetchById).toHaveBeenCalledWith(
        17,
        expect.objectContaining({
          status: 'starting',
          executionOwner: 'worker-2',
          leaseExpiresAt: expect.any(String),
          heartbeatAt: expect.any(String),
        })
      );
    });
  });

  describe('queued run creation behavior', () => {
    const queuedInput = (overrides: Record<string, unknown> = {}) =>
      ({
        thread: { id: 7, uuid: 'thread-1', metadata: undefined },
        session: { id: 17, uuid: 'session-1' },
        policy: { defaultMode: 'require_approval', rules: {} },
        requestedHarness: undefined,
        requestedProvider: undefined,
        requestedModel: undefined,
        resolvedHarness: 'lifecycle_ai_sdk',
        resolvedProvider: 'openai',
        resolvedModel: 'gpt-5.4',
        runPlanSnapshot,
        ...overrides,
      } as any);

    it.each([
      ['harness', { resolvedHarness: ' ' }, 'Agent run harness is required.'],
      ['provider', { resolvedProvider: '' }, 'Agent run provider is required.'],
      ['model', { resolvedModel: ' ' }, 'Agent run model is required.'],
      ['plan snapshot', { runPlanSnapshot: {} }, 'Agent run plan snapshot is required.'],
    ])('rejects a queued run with an invalid %s', async (_label, overrides, message) => {
      await expect(AgentRunService.createQueuedRun(queuedInput(overrides))).rejects.toMatchObject({
        name: 'InvalidAgentRunDefaultsError',
        message,
        code: 'run_defaults_invalid',
      });

      expect(mockRunTransaction).not.toHaveBeenCalled();
    });

    it('creates a queued run atomically, updates thread metadata, and emits its queued event', async () => {
      const queuedRun = { id: 19, uuid: VALID_RUN_UUID, status: 'queued' };
      const sessionForUpdate = jest.fn().mockResolvedValue({ id: 17 });
      mockSessionQuery.mockReturnValue({
        findById: jest.fn().mockReturnValue({ forUpdate: sessionForUpdate }),
      });
      const activeQuery = {
        where: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(null),
      };
      const insertAndFetch = jest.fn().mockResolvedValue(queuedRun);
      mockRunQuery.mockReturnValueOnce(activeQuery).mockReturnValueOnce({ insertAndFetch });
      const patchAndFetchById = jest.fn().mockResolvedValue(undefined);
      mockThreadQuery.mockReturnValue({ patchAndFetchById });

      await expect(AgentRunService.createQueuedRun(queuedInput())).resolves.toBe(queuedRun);

      expect(sessionForUpdate).toHaveBeenCalledTimes(1);
      expect(insertAndFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 7,
          sessionId: 17,
          status: 'queued',
          requestedHarness: null,
          requestedProvider: null,
          requestedModel: null,
          sandboxRequirement: {},
        })
      );
      expect(patchAndFetchById).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ metadata: { latestRunId: VALID_RUN_UUID } })
      );
      expect(mockAppendStatusEvent).toHaveBeenCalledWith(VALID_RUN_UUID, 'run.queued', {
        threadId: 'thread-1',
        sessionId: 'session-1',
      });
    });

    it('rejects creation when another session run is active', async () => {
      mockSessionQuery.mockReturnValue({
        findById: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue({ id: 17 }) }),
      });
      const activeQuery = {
        where: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ id: 18, status: 'running' }),
      };
      mockRunQuery.mockReturnValue(activeQuery);

      await expect(AgentRunService.createQueuedRun(queuedInput())).rejects.toBeInstanceOf(ActiveAgentRunError);
      expect(mockThreadQuery).not.toHaveBeenCalled();
      expect(mockAppendStatusEvent).not.toHaveBeenCalled();
    });

    it('rejects a continuation when a different run is active', async () => {
      mockSessionQuery.mockReturnValue({
        findById: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue({ id: 17 }) }),
      });
      const activeQuery = {
        where: jest.fn().mockReturnThis(),
        whereNot: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ id: 18, status: 'running' }),
      };
      mockRunQuery.mockReturnValue(activeQuery);

      await expect(
        AgentRunService.createQueuedContinuationRunInTransaction({
          ...queuedInput(),
          sourceRun: { id: 11 },
          trx: { trx: true },
        })
      ).rejects.toBeInstanceOf(ActiveAgentRunError);
      expect(mockThreadQuery).not.toHaveBeenCalled();
    });

    it('exposes the two stable public error predicates', () => {
      expect(new InvalidAgentRunDefaultsError('bad defaults')).toMatchObject({
        name: 'InvalidAgentRunDefaultsError',
        code: 'run_defaults_invalid',
      });
      const active = new ActiveAgentRunError();
      expect(AgentRunService.isActiveRunConflictError(active)).toBe(true);
      expect(AgentRunService.isActiveRunConflictError(new Error('other'))).toBe(false);
      expect(AgentRunService.isRunNotFoundError(new Error('Agent run not found'))).toBe(true);
      expect(AgentRunService.isRunNotFoundError('Agent run not found')).toBe(false);
    });
  });

  describe('run lookup and liveness helpers', () => {
    const ownedLookup = (result: unknown) => ({
      alias: jest.fn().mockReturnThis(),
      joinRelated: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(result),
    });

    it('reports active-run presence through the transaction-scoped query', async () => {
      const present = {
        where: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ id: 1 }),
      };
      const absent = {
        where: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(undefined),
      };
      mockRunQuery.mockReturnValueOnce(present).mockReturnValueOnce(absent);

      await expect(AgentRunService.hasActiveRun(7, { trx: true } as any)).resolves.toBe(true);
      await expect(AgentRunService.hasActiveRun(8)).resolves.toBe(false);
      expect(mockRunQuery).toHaveBeenNthCalledWith(1, { trx: true });
      expect(present.whereNotIn).toHaveBeenCalledWith('status', ['transitioned', 'completed', 'failed', 'cancelled']);
    });

    it('returns the latest owned thread run and rejects malformed thread ids before querying', async () => {
      const run = { id: 1, uuid: VALID_RUN_UUID };
      const query = ownedLookup(run);
      mockRunQuery.mockReturnValue(query);

      await expect(AgentRunService.getLatestOwnedThreadRun('bad-thread-id', 'user-1')).resolves.toBeUndefined();
      await expect(AgentRunService.getLatestOwnedThreadRun(VALID_RUN_UUID, 'user-1')).resolves.toBe(run);

      expect(query.where).toHaveBeenCalledWith('thread.uuid', VALID_RUN_UUID);
      expect(query.where).toHaveBeenCalledWith('thread:session.userId', 'user-1');
      expect(query.orderBy).toHaveBeenNthCalledWith(1, 'run.createdAt', 'desc');
      expect(query.orderBy).toHaveBeenNthCalledWith(2, 'run.id', 'desc');
    });

    it('returns undefined when the owned session has no runs and rejects malformed session ids', async () => {
      const query = ownedLookup(null);
      mockRunQuery.mockReturnValue(query);

      await expect(AgentRunService.getLatestOwnedSessionRun('bad-session-id', 'user-1')).resolves.toBeUndefined();
      await expect(AgentRunService.getLatestOwnedSessionRun(VALID_RUN_UUID, 'user-1')).resolves.toBeUndefined();

      expect(query.joinRelated).toHaveBeenCalledWith('session');
      expect(query.where).toHaveBeenCalledWith('session.uuid', VALID_RUN_UUID);
      expect(query.where).toHaveBeenCalledWith('session.userId', 'user-1');
    });

    it('throws not-found when a syntactically valid owned run id has no matching row', async () => {
      const query = ownedLookup(undefined);
      mockRunQuery.mockReturnValue(query);

      await expect(AgentRunService.getOwnedRun(VALID_RUN_UUID, 'user-1')).rejects.toThrow('Agent run not found');
    });

    it('recognizes each terminal status and rejects active statuses', () => {
      for (const status of ['transitioned', 'completed', 'failed', 'cancelled'] as const) {
        expect(AgentRunService.isTerminalStatus(status)).toBe(true);
      }
      expect(AgentRunService.isTerminalStatus('running')).toBe(false);
    });
  });

  describe('claim and heartbeat boundary behavior', () => {
    it('rejects malformed and missing queued-run ids', async () => {
      await expect(AgentRunService.claimQueuedRunForExecution('bad-id', 'worker-1')).rejects.toThrow(
        'Agent run not found'
      );
      expect(mockRunQuery).not.toHaveBeenCalled();

      mockRunQuery.mockReturnValue({
        findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(undefined) }),
      });
      await expect(AgentRunService.claimQueuedRunForExecution(VALID_RUN_UUID, 'worker-1', 60_000)).rejects.toThrow(
        'Agent run not found'
      );
    });

    it('does not reclaim an owner with neither lease nor heartbeat timestamps', async () => {
      const run = {
        id: 17,
        uuid: VALID_RUN_UUID,
        status: 'running',
        leaseExpiresAt: null,
        heartbeatAt: null,
        startedAt: null,
      };
      mockRunQuery.mockReturnValue({
        findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(run) }),
      });

      await expect(AgentRunService.claimQueuedRunForExecution(VALID_RUN_UUID, 'worker-1', 60_000)).resolves.toBeNull();
      expect(mockSessionQuery).not.toHaveBeenCalled();
    });

    it('updates a live heartbeat and reports a missing run after a zero-row update', async () => {
      const successfulPatch = jest.fn().mockResolvedValue(1);
      const successfulQuery = {
        where: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        patch: successfulPatch,
      };
      mockRunQuery.mockReturnValueOnce(successfulQuery);
      await expect(AgentRunService.heartbeatRunExecution(VALID_RUN_UUID, 'worker-1')).resolves.toBeUndefined();
      expect(successfulPatch).toHaveBeenCalledWith(
        expect.objectContaining({ heartbeatAt: expect.any(String), leaseExpiresAt: expect.any(String) })
      );

      const failedPatch = jest.fn().mockResolvedValue(0);
      const failedQuery = {
        where: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        patch: failedPatch,
      };
      mockRunQuery.mockReturnValueOnce(failedQuery).mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(null) });
      await expect(AgentRunService.heartbeatRunExecution(VALID_RUN_UUID, 'worker-1')).rejects.toThrow(
        'Agent run not found'
      );
    });

    it('fails cancellation safely when the locked row disappeared', async () => {
      jest.spyOn(AgentRunService, 'getOwnedRun').mockResolvedValue({ id: 17, uuid: VALID_RUN_UUID } as any);
      mockRunQuery.mockReturnValue({
        findById: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(undefined) }),
      });

      await expect(AgentRunService.cancelRun(VALID_RUN_UUID, 'user-1')).rejects.toThrow('Agent run not found');
      expect(mockAppendStatusEventForRunInTransaction).not.toHaveBeenCalled();
    });
  });

  describe('execution-owner public helpers', () => {
    const ownedRun = {
      id: 17,
      uuid: VALID_RUN_UUID,
      status: 'running',
      executionOwner: 'worker-1',
    };

    it('asserts ownership and rejects malformed, missing, or terminal runs', async () => {
      await expect(AgentRunService.assertRunExecutionOwner('bad-id', 'worker-1')).rejects.toThrow(
        'Agent run not found'
      );
      expect(mockRunQuery).not.toHaveBeenCalled();

      mockRunQuery.mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(undefined) });
      await expect(AgentRunService.assertRunExecutionOwner(VALID_RUN_UUID, 'worker-1')).rejects.toThrow(
        'Agent run not found'
      );

      mockRunQuery.mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(ownedRun) });
      await expect(AgentRunService.assertRunExecutionOwner(VALID_RUN_UUID, 'worker-1')).resolves.toBe(ownedRun);

      mockRunQuery.mockReturnValueOnce({
        findOne: jest.fn().mockResolvedValue({ ...ownedRun, status: 'completed' }),
      });
      await expect(AgentRunService.assertRunExecutionOwner(VALID_RUN_UUID, 'worker-1')).rejects.toBeInstanceOf(
        AgentRunOwnershipLostError
      );
    });

    it('patches an owned run transactionally and reports invalid or disappeared runs', async () => {
      await expect(AgentRunService.patchRunForExecutionOwner('bad-id', 'worker-1', {})).rejects.toThrow(
        'Agent run not found'
      );

      mockRunQuery.mockReturnValueOnce({
        findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(undefined) }),
      });
      await expect(
        AgentRunService.patchRunForExecutionOwner(VALID_RUN_UUID, 'worker-1', { model: 'gpt-next' })
      ).rejects.toThrow('Agent run not found');

      const patchAndFetchById = jest.fn().mockResolvedValue({ ...ownedRun, model: 'gpt-next' });
      mockRunQuery
        .mockReturnValueOnce({
          findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(ownedRun) }),
        })
        .mockReturnValueOnce({ patchAndFetchById });
      await expect(
        AgentRunService.patchRunForExecutionOwner(VALID_RUN_UUID, 'worker-1', { model: 'gpt-next' })
      ).resolves.toEqual(expect.objectContaining({ model: 'gpt-next' }));
      expect(patchAndFetchById).toHaveBeenCalledWith(17, { model: 'gpt-next' });
    });

    it('reports a run that disappears before an owner-status transition', async () => {
      mockRunQuery.mockReturnValue({
        findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(undefined) }),
      });

      await expect(AgentRunService.patchStatusForExecutionOwner(VALID_RUN_UUID, 'worker-1', 'running')).rejects.toThrow(
        'Agent run not found'
      );
      expect(mockAppendStatusEventForRunInTransaction).not.toHaveBeenCalled();
    });

    it('starts a run with resolved runtime fields and marks approval waits with optional usage', async () => {
      const ensureListener = jest
        .spyOn(AgentRunService as any, 'ensureCancelNotificationListener')
        .mockRejectedValue(new Error('listener unavailable'));
      const patchStatus = jest
        .spyOn(AgentRunService, 'patchStatusForExecutionOwner')
        .mockResolvedValue(ownedRun as any);

      await expect(
        AgentRunService.startRunForExecutionOwner(
          VALID_RUN_UUID,
          'worker-1',
          { resolvedHarness: 'sdk', provider: 'openai', model: 'gpt-next' },
          { dispatchAttemptId: 'dispatch-1' }
        )
      ).resolves.toBe(ownedRun);
      await Promise.resolve();
      expect(ensureListener).toHaveBeenCalledTimes(1);
      expect(patchStatus).toHaveBeenNthCalledWith(
        1,
        VALID_RUN_UUID,
        'worker-1',
        'running',
        expect.objectContaining({
          startedAt: expect.any(String),
          resolvedHarness: 'sdk',
          resolvedProvider: 'openai',
          resolvedModel: 'gpt-next',
          sandboxGeneration: null,
        }),
        { dispatchAttemptId: 'dispatch-1' }
      );

      await AgentRunService.markWaitingForApprovalForExecutionOwner(
        VALID_RUN_UUID,
        'worker-1',
        { totalTokens: 9 },
        { dispatchAttemptId: 'dispatch-2' }
      );
      await AgentRunService.markWaitingForApprovalForExecutionOwner(VALID_RUN_UUID, 'worker-1');
      expect(patchStatus).toHaveBeenNthCalledWith(
        2,
        VALID_RUN_UUID,
        'worker-1',
        'waiting_for_approval',
        { usageSummary: { totalTokens: 9 } },
        { dispatchAttemptId: 'dispatch-2' }
      );
      expect(patchStatus).toHaveBeenNthCalledWith(3, VALID_RUN_UUID, 'worker-1', 'waiting_for_approval', undefined, {});
    });

    it('refreshes progress through the owner-fenced patch helper', async () => {
      const patch = jest.spyOn(AgentRunService, 'patchRunForExecutionOwner').mockResolvedValue(ownedRun as any);

      await expect(
        AgentRunService.patchProgressForExecutionOwner(VALID_RUN_UUID, 'worker-1', { usageSummary: { totalTokens: 3 } })
      ).resolves.toBe(ownedRun);
      expect(patch).toHaveBeenCalledWith(
        VALID_RUN_UUID,
        'worker-1',
        expect.objectContaining({
          usageSummary: { totalTokens: 3 },
          heartbeatAt: expect.any(String),
          leaseExpiresAt: expect.any(String),
        })
      );
    });

    it('appends chunks atomically after the caller hook and notifies the stream', async () => {
      const trx = { trx: true };
      const beforeAppendChunks = jest.fn().mockResolvedValue(undefined);
      mockRunTransaction.mockImplementation(async (callback) => callback(trx));
      mockRunQuery.mockReturnValue({
        findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(ownedRun) }),
      });
      mockAppendChunkEventsForRunInTransaction.mockResolvedValue(22);

      await expect(
        AgentRunService.appendStreamChunksForExecutionOwner(
          VALID_RUN_UUID,
          'worker-1',
          [{ type: 'text-delta', id: 'text-1', delta: 'hello' } as any],
          { beforeAppendChunks }
        )
      ).resolves.toBe(ownedRun);

      expect(beforeAppendChunks).toHaveBeenCalledWith({ run: ownedRun, trx });
      expect(mockAppendChunkEventsForRunInTransaction).toHaveBeenCalledWith(
        ownedRun,
        [{ type: 'text-delta', id: 'text-1', delta: 'hello' }],
        trx
      );
      expect(mockNotifyRunEventsInserted).toHaveBeenCalledWith(VALID_RUN_UUID, 22);
    });

    it('handles empty, malformed, and disappeared owner-fenced chunk requests', async () => {
      await expect(AgentRunService.appendStreamChunksForExecutionOwner('bad-id', 'worker-1', [])).rejects.toThrow(
        'Agent run not found'
      );

      mockRunQuery.mockReturnValueOnce({
        findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(ownedRun) }),
      });
      await expect(AgentRunService.appendStreamChunksForExecutionOwner(VALID_RUN_UUID, 'worker-1', [])).resolves.toBe(
        ownedRun
      );
      expect(mockAppendChunkEventsForRunInTransaction).not.toHaveBeenCalled();

      mockRunQuery.mockReturnValueOnce({
        findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(undefined) }),
      });
      await expect(AgentRunService.appendStreamChunksForExecutionOwner(VALID_RUN_UUID, 'worker-1', [])).rejects.toThrow(
        'Agent run not found'
      );
    });

    it('rejects malformed or disappeared finalization targets before invoking the callback', async () => {
      const finalize = jest.fn();
      await expect(AgentRunService.finalizeRunForExecutionOwner('bad-id', 'worker-1', finalize)).rejects.toThrow(
        'Agent run not found'
      );

      mockRunQuery.mockReturnValue({
        findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(undefined) }),
      });
      await expect(AgentRunService.finalizeRunForExecutionOwner(VALID_RUN_UUID, 'worker-1', finalize)).rejects.toThrow(
        'Agent run not found'
      );
      expect(finalize).not.toHaveBeenCalled();
    });

    it.each([
      ['waiting_for_approval', 'run.waiting_for_approval', true],
      ['cancelled', 'run.cancelled', true],
      ['running', 'run.started', false],
      ['starting', 'run.started', false],
    ] as const)('maps %s owner transitions to %s and release=%s', async (status, eventType, releasesOwner) => {
      const nextRun = {
        ...ownedRun,
        status,
        ...(releasesOwner ? { executionOwner: null, leaseExpiresAt: null, heartbeatAt: null } : {}),
      };
      const patchAndFetchById = jest.fn().mockResolvedValue(nextRun);
      mockRunQuery
        .mockReturnValueOnce({
          findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(ownedRun) }),
        })
        .mockReturnValueOnce({ patchAndFetchById });
      mockAppendStatusEventForRunInTransaction.mockResolvedValue(null);

      await expect(AgentRunService.patchStatusForExecutionOwner(VALID_RUN_UUID, 'worker-1', status)).resolves.toBe(
        nextRun
      );
      expect(patchAndFetchById).toHaveBeenCalledWith(
        17,
        releasesOwner
          ? expect.objectContaining({
              status,
              executionOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
            })
          : { status }
      );
      expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
        nextRun,
        eventType,
        expect.objectContaining({ status, executionOwner: 'worker-1' }),
        { trx: true }
      );
    });

    it('uses start defaults, preserves a supplied sandbox generation, and defaults completion usage', async () => {
      jest.spyOn(AgentRunService as any, 'ensureCancelNotificationListener').mockResolvedValue(undefined);
      const patchStatus = jest
        .spyOn(AgentRunService, 'patchStatusForExecutionOwner')
        .mockResolvedValue(ownedRun as any);

      await AgentRunService.startRunForExecutionOwner(VALID_RUN_UUID, 'worker-1', {
        resolvedHarness: 'sdk',
        provider: 'openai',
        model: 'gpt-next',
        sandboxGeneration: 4,
      });
      expect(patchStatus).toHaveBeenCalledWith(
        VALID_RUN_UUID,
        'worker-1',
        'running',
        expect.objectContaining({ sandboxGeneration: 4 }),
        {}
      );

      await AgentRunService.markCompletedForExecutionOwner(VALID_RUN_UUID, 'worker-1');
      expect(patchStatus).toHaveBeenLastCalledWith(
        VALID_RUN_UUID,
        'worker-1',
        'completed',
        expect.objectContaining({ usageSummary: {} }),
        {}
      );
    });

    it('appends nonempty owner-fenced chunks without a caller hook or notification sequence', async () => {
      mockRunQuery.mockReturnValue({
        findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(ownedRun) }),
      });
      mockAppendChunkEventsForRunInTransaction.mockResolvedValue(null);

      await expect(
        AgentRunService.appendStreamChunksForExecutionOwner(VALID_RUN_UUID, 'worker-1', [
          { type: 'text-delta', id: 'text-1', delta: 'hello' } as any,
        ])
      ).resolves.toBe(ownedRun);
      expect(mockAppendChunkEventsForRunInTransaction).toHaveBeenCalledTimes(1);
      expect(mockNotifyRunEventsInserted).not.toHaveBeenCalled();
    });

    it('serializes a callback failure during atomic finalization', async () => {
      const failedRun = {
        ...ownedRun,
        status: 'failed',
        executionOwner: null,
        error: { message: 'finalization failed' },
      };
      const patchAndFetchById = jest.fn().mockResolvedValue(failedRun);
      mockRunQuery
        .mockReturnValueOnce({
          findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(ownedRun) }),
        })
        .mockReturnValueOnce({ patchAndFetchById });
      mockAppendStatusEventForRunInTransaction.mockResolvedValue(null);

      await expect(
        AgentRunService.finalizeRunForExecutionOwner(VALID_RUN_UUID, 'worker-1', async () => ({
          status: 'failed',
          error: new Error('finalization failed'),
        }))
      ).resolves.toBe(failedRun);
      expect(patchAndFetchById).toHaveBeenCalledWith(
        17,
        expect.objectContaining({
          status: 'failed',
          error: expect.objectContaining({ message: 'finalization failed' }),
          executionOwner: null,
        })
      );
    });
  });

  describe('dispatch failure behavior', () => {
    const queuedRun = {
      id: 17,
      uuid: VALID_RUN_UUID,
      threadId: 7,
      status: 'queued',
      executionOwner: null,
    };

    const captureSerializedFailure = async (error: unknown) => {
      const patchAndFetchById = jest.fn().mockResolvedValue({ ...queuedRun, status: 'failed' });
      mockRunQuery
        .mockReturnValueOnce({
          findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(queuedRun) }),
        })
        .mockReturnValueOnce({ patchAndFetchById });
      mockAppendStatusEventForRunInTransaction.mockResolvedValueOnce(null);

      await AgentRunService.markQueuedRunDispatchFailed(VALID_RUN_UUID, error);
      return (patchAndFetchById.mock.calls[0][1] as { error: Record<string, unknown> }).error;
    };

    it('reports a queued run that disappears and leaves an already-claimed run unchanged', async () => {
      mockRunQuery.mockReturnValueOnce({
        findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(undefined) }),
      });
      await expect(AgentRunService.markQueuedRunDispatchFailed(VALID_RUN_UUID, new Error('dispatch'))).rejects.toThrow(
        'Agent run not found'
      );

      const claimed = { ...queuedRun, status: 'starting', executionOwner: 'worker-1' };
      mockRunQuery.mockReturnValueOnce({
        findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(claimed) }),
      });
      await expect(AgentRunService.markQueuedRunDispatchFailed(VALID_RUN_UUID, new Error('late'))).resolves.toBe(
        claimed
      );
      expect(mockAppendStatusEventForRunInTransaction).not.toHaveBeenCalled();
    });

    it('serializes validation, classified provider, typed, object, and primitive failures', async () => {
      const validationError = new Error('invalid saved message');
      validationError.name = 'AI_TypeValidationError';
      await expect(captureSerializedFailure(validationError)).resolves.toEqual({
        name: 'AI_TypeValidationError',
        code: 'run_resume_state_invalid',
        message:
          'Lifecycle could not resume this response because the saved run state is invalid. Send a new message to continue from the last saved chat state.',
        details: { reason: 'ui_message_validation' },
      });

      const unnamedValidationError = new Error('Type validation failed for saved message');
      unnamedValidationError.name = '';
      await expect(captureSerializedFailure(unnamedValidationError)).resolves.toMatchObject({
        name: 'Error',
        code: 'run_resume_state_invalid',
      });

      const providerError = Object.assign(new Error('rate limited'), {
        name: 'AI_APICallError',
        statusCode: 429,
        url: 'https://provider.example/v1',
      });
      await expect(captureSerializedFailure(providerError)).resolves.toMatchObject({
        code: 'provider_rate_limited',
        retryable: true,
        nextAction: { kind: 'retry' },
        details: { status: 429, provider: 'https://provider.example/v1' },
      });

      const ownershipError = new AgentRunOwnershipLostError({
        runUuid: VALID_RUN_UUID,
        expectedExecutionOwner: 'worker-1',
      });
      await expect(captureSerializedFailure(ownershipError)).resolves.toEqual({
        name: 'AgentRunTerminalFailure',
        code: 'run_ownership_lost',
        message: 'This response was taken over by another worker or was cancelled.',
        retryable: false,
      });

      const typedError = Object.assign(new Error('generic failure'), {
        name: 'CustomRunError',
        code: 'custom_code',
        details: { attempt: 2 },
      });
      await expect(captureSerializedFailure(typedError)).resolves.toMatchObject({
        message: 'generic failure',
        name: 'CustomRunError',
        code: 'custom_code',
        details: { attempt: 2 },
      });

      const stacklessError = new Error('without stack');
      stacklessError.stack = undefined;
      await expect(captureSerializedFailure(stacklessError)).resolves.toMatchObject({
        message: 'without stack',
        stack: null,
      });

      await expect(captureSerializedFailure({ message: '   ', source: 'dispatcher' })).resolves.toEqual({
        message: 'Agent run failed.',
        source: 'dispatcher',
      });
      await expect(captureSerializedFailure({ message: 42, source: 'dispatcher' })).resolves.toEqual({
        message: 'Agent run failed.',
        source: 'dispatcher',
      });
      await expect(captureSerializedFailure('plain failure')).resolves.toEqual({ message: 'plain failure' });
    });

    it('marks an unclaimed queued run failed, emits the terminal event, and notifies listeners', async () => {
      const failedRun = {
        ...queuedRun,
        status: 'failed',
        error: { message: 'dispatch failed' },
      };
      const patchAndFetchById = jest.fn().mockResolvedValue(failedRun);
      mockRunQuery
        .mockReturnValueOnce({
          findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(queuedRun) }),
        })
        .mockReturnValueOnce({ patchAndFetchById });
      mockAppendStatusEventForRunInTransaction.mockResolvedValue(29);

      await expect(
        AgentRunService.markQueuedRunDispatchFailed(VALID_RUN_UUID, new Error('dispatch failed'))
      ).resolves.toBe(failedRun);

      expect(patchAndFetchById).toHaveBeenCalledWith(
        17,
        expect.objectContaining({
          status: 'failed',
          executionOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          error: expect.objectContaining({ message: 'dispatch failed' }),
        })
      );
      expect(mockAppendStatusEventForRunInTransaction).toHaveBeenCalledWith(
        failedRun,
        'run.failed',
        expect.objectContaining({ status: 'failed', error: failedRun.error }),
        { trx: true }
      );
      expect(mockNotifyRunEventsInserted).toHaveBeenCalledWith(VALID_RUN_UUID, 29);
    });
  });

  describe('recovery and legacy chunk boundaries', () => {
    const eligibility = {
      decision: 'manual_recovery_required',
      reason: 'runtime_unavailable',
      evaluatedAt: '2026-04-24T12:00:00.000Z',
      detail: {},
    } as any;

    it('rejects malformed and missing recovery targets and ignores inactive runs', async () => {
      await expect(AgentRunService.markWaitingForInputForRecovery('bad-id', eligibility)).rejects.toThrow(
        'Agent run not found'
      );

      mockRunQuery.mockReturnValueOnce({
        findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(undefined) }),
      });
      await expect(AgentRunService.markWaitingForInputForRecovery(VALID_RUN_UUID, eligibility)).rejects.toThrow(
        'Agent run not found'
      );

      mockRunQuery.mockReturnValueOnce({
        findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue({ id: 17, status: 'queued' }) }),
      });
      await expect(AgentRunService.markWaitingForInputForRecovery(VALID_RUN_UUID, eligibility)).resolves.toBeNull();
      expect(mockAppendStatusEventForRunInTransaction).not.toHaveBeenCalled();
    });

    it('returns the run for empty legacy chunks, appends nonempty chunks, and rejects a missing run', async () => {
      const run = { id: 17, uuid: VALID_RUN_UUID };
      mockRunQuery.mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(run) });
      await expect(AgentRunService.appendStreamChunks(VALID_RUN_UUID, [])).resolves.toBe(run);
      expect(mockAppendEventsForChunks).not.toHaveBeenCalled();

      mockRunQuery.mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(run) });
      const chunks = [{ type: 'text-delta', id: 'text-1', delta: 'hello' }] as any;
      await expect(AgentRunService.appendStreamChunks(VALID_RUN_UUID, chunks)).resolves.toBe(run);
      expect(mockAppendEventsForChunks).toHaveBeenCalledWith(VALID_RUN_UUID, chunks);

      mockRunQuery.mockReturnValueOnce({ findOne: jest.fn().mockResolvedValue(undefined) });
      await expect(AgentRunService.appendStreamChunks(VALID_RUN_UUID, [])).rejects.toThrow('Agent run not found');
    });

    it('records recovery defaults for an orphaned run with no owner, lease, or prior eligibility detail', async () => {
      const orphanedRun = {
        id: 17,
        uuid: VALID_RUN_UUID,
        status: 'running',
        executionOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        startedAt: null,
      };
      const pausedRun = { ...orphanedRun, status: 'waiting_for_input' };
      const patchAndFetchById = jest.fn().mockResolvedValue(pausedRun);
      mockRunQuery
        .mockReturnValueOnce({
          findOne: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(orphanedRun) }),
        })
        .mockReturnValueOnce({ patchAndFetchById });
      mockAppendStatusEventForRunInTransaction.mockResolvedValue(null);

      await expect(
        AgentRunService.markWaitingForInputForRecovery(
          VALID_RUN_UUID,
          { decision: 'manual_recovery_required', reason: 'runtime_unavailable' } as any,
          { allowActiveLease: true, detail: { source: 'recovery-scan' } }
        )
      ).resolves.toBe(pausedRun);

      expect(patchAndFetchById).toHaveBeenCalledWith(
        17,
        expect.objectContaining({
          error: expect.objectContaining({
            details: {
              recovery: expect.objectContaining({
                previousOwner: null,
                leaseExpiresAt: null,
                evaluatedAt: expect.any(String),
                detail: { source: 'recovery-scan' },
              }),
            },
          }),
        })
      );
    });

    it('omits malformed recovery metadata from the public run shape', () => {
      const serialized = AgentRunService.serializeRun({
        uuid: VALID_RUN_UUID,
        threadId: 7,
        sessionId: 17,
        status: 'waiting_for_input',
        provider: 'openai',
        model: 'gpt-next',
        error: { details: { recovery: { decision: 'manual_recovery_required', reason: ' ' } } },
      } as any);

      expect(serialized.recovery).toBeNull();
    });
  });

  describe('best-effort cancellation side effects', () => {
    it('still completes cancellation when the cross-process notification fails', async () => {
      const runningRun = { id: 17, uuid: VALID_RUN_UUID, threadId: 7, status: 'running' };
      const cancelledRun = { ...runningRun, status: 'cancelled' };
      jest
        .spyOn(AgentRunService, 'getOwnedRun')
        .mockResolvedValueOnce(runningRun as any)
        .mockResolvedValueOnce(cancelledRun as any);
      mockRunQuery
        .mockReturnValueOnce({
          findById: jest.fn().mockReturnValue({ forUpdate: jest.fn().mockResolvedValue(runningRun) }),
        })
        .mockReturnValueOnce({ patchAndFetchById: jest.fn().mockResolvedValue(cancelledRun) });
      mockAppendStatusEventForRunInTransaction.mockResolvedValue(41);
      mockRunKnex.mockReturnValue({ raw: jest.fn().mockRejectedValue(new Error('notify unavailable')) });

      await expect(AgentRunService.cancelRun(VALID_RUN_UUID, 'user-1')).resolves.toBe(cancelledRun);
      expect(mockNotifyRunEventsInserted).toHaveBeenCalledWith(VALID_RUN_UUID, 41);
      expect(mockPersistInterruptedRunAssistantMessage).toHaveBeenCalledWith(runningRun);
    });
  });
});
