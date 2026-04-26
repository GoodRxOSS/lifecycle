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

import type { PartialModelObject } from 'objection';
import AgentRun from 'server/models/AgentRun';
import AgentSession from 'server/models/AgentSession';
import AgentThread from 'server/models/AgentThread';
import AgentMessage from 'server/models/AgentMessage';
import type { AgentApprovalPolicy } from './types';
import type { AgentRunRuntimeOptions, CanonicalAgentRunMessageInput } from './canonicalMessages';
import AgentMessageStore from './MessageStore';
import AgentRunEventService from './RunEventService';
import { ActiveAgentRunError, InvalidAgentRunDefaultsError, TERMINAL_RUN_STATUSES } from './RunService';

function buildPolicySnapshot(
  policy: AgentApprovalPolicy,
  runtimeOptions?: AgentRunRuntimeOptions
): Record<string, unknown> {
  if (!runtimeOptions || Object.keys(runtimeOptions).length === 0) {
    return policy as unknown as Record<string, unknown>;
  }

  return {
    ...(policy as unknown as Record<string, unknown>),
    runtimeOptions,
  };
}

export default class AgentRunAdmissionService {
  static async createQueuedRunWithMessage({
    thread,
    session,
    policy,
    message,
    requestedHarness,
    requestedProvider,
    requestedModel,
    resolvedHarness,
    resolvedProvider,
    resolvedModel,
    sandboxRequirement,
    runtimeOptions,
  }: {
    thread: AgentThread;
    session: AgentSession;
    policy: AgentApprovalPolicy;
    message: CanonicalAgentRunMessageInput;
    requestedHarness?: string | null;
    requestedProvider?: string | null;
    requestedModel?: string | null;
    resolvedHarness: string;
    resolvedProvider: string;
    resolvedModel: string;
    sandboxRequirement?: Record<string, unknown>;
    runtimeOptions?: AgentRunRuntimeOptions;
  }): Promise<{ run: AgentRun; message: AgentMessage; created: boolean }> {
    if (!resolvedHarness?.trim()) {
      throw new InvalidAgentRunDefaultsError('Agent run harness is required.');
    }
    if (!resolvedProvider?.trim()) {
      throw new InvalidAgentRunDefaultsError('Agent run provider is required.');
    }
    if (!resolvedModel?.trim()) {
      throw new InvalidAgentRunDefaultsError('Agent run model is required.');
    }

    const now = new Date().toISOString();
    const record: PartialModelObject<AgentRun> = {
      threadId: thread.id,
      sessionId: session.id,
      status: 'queued',
      provider: resolvedProvider,
      model: resolvedModel,
      requestedHarness: requestedHarness || null,
      resolvedHarness,
      requestedProvider: requestedProvider || null,
      requestedModel: requestedModel || null,
      resolvedProvider,
      resolvedModel,
      sandboxRequirement: sandboxRequirement || {},
      sandboxGeneration: null,
      queuedAt: now,
      startedAt: null,
      usageSummary: {},
      policySnapshot: buildPolicySnapshot(policy, runtimeOptions),
      error: null,
    };

    const admitted = await AgentRun.transaction(async (trx) => {
      await AgentSession.query(trx).findById(session.id).forUpdate();

      if (message.clientMessageId) {
        const existingMessage = await AgentMessageStore.findCanonicalMessageByClientMessageId(
          thread,
          message.clientMessageId,
          trx
        );
        if (existingMessage) {
          if (!existingMessage.runId) {
            throw new ActiveAgentRunError();
          }

          const existingRun = await AgentRun.query(trx).findById(existingMessage.runId);
          if (existingRun) {
            return {
              run: existingRun,
              message: existingMessage,
              created: false,
            };
          }
        }
      }

      const activeRun = await AgentRun.query(trx)
        .where({ sessionId: session.id })
        .whereNotIn('status', TERMINAL_RUN_STATUSES)
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .first();
      if (activeRun) {
        throw new ActiveAgentRunError();
      }

      const queuedRun = await AgentRun.query(trx).insertAndFetch(record);
      const storedMessage = await AgentMessageStore.insertUserMessageForRun(thread, queuedRun, message, trx);
      await AgentThread.query(trx).patchAndFetchById(thread.id, {
        lastRunAt: now,
        metadata: {
          ...(thread.metadata || {}),
          latestRunId: queuedRun.uuid,
        },
      } as Partial<AgentThread>);

      return {
        run: queuedRun,
        message: storedMessage,
        created: true,
      };
    });

    if (admitted.created) {
      await AgentRunEventService.appendStatusEvent(admitted.run.uuid, 'run.queued', {
        threadId: thread.uuid,
        sessionId: session.uuid,
      });
    }

    return admitted;
  }
}
