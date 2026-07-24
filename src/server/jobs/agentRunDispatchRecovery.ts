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

import { getLogger } from 'server/lib/logger';
import AgentRunQueueService from 'server/services/agent/RunQueueService';
import AgentRunService from 'server/services/agent/RunService';
import AgentRunResumeEligibilityService from 'server/services/agent/RunResumeEligibilityService';
import { v4 as uuid } from 'uuid';

const logger = () => getLogger();

export async function processAgentRunDispatchRecovery(): Promise<{
  runs: number;
  enqueued: Array<{ runId: string; dispatchAttemptId: string }>;
  skipped: Array<{ runId: string; decision: string; reason: string }>;
  paused: Array<{ runId: string; reason: string }>;
  failed: Array<{ runId: string }>;
}> {
  const runs = await AgentRunService.listRunsNeedingDispatch();
  if (runs.length === 0) {
    return {
      runs: 0,
      enqueued: [],
      skipped: [],
      paused: [],
      failed: [],
    };
  }

  logger().info(`AgentExec: recovery enqueue runs=${runs.length}`);
  const enqueued: Array<{ runId: string; dispatchAttemptId: string }> = [];
  const skipped: Array<{ runId: string; decision: string; reason: string }> = [];
  const paused: Array<{ runId: string; reason: string }> = [];
  const failed: Array<{ runId: string }> = [];
  for (const run of runs) {
    const resumeAttemptId = uuid();
    try {
      const eligibility = await AgentRunResumeEligibilityService.evaluateRun(run);
      if (eligibility.decision === 'manual_recovery_required') {
        const pausedRun = await AgentRunService.markWaitingForInputForRecovery(run.uuid, eligibility, {
          expectedExecutionOwner: eligibility.previousOwner,
          resumeAttemptId,
        });
        if (pausedRun) {
          paused.push({ runId: run.uuid, reason: eligibility.reason });
        } else {
          skipped.push({ runId: run.uuid, decision: eligibility.decision, reason: eligibility.reason });
        }
        logger().info(
          {
            runId: run.uuid,
            resumeAttemptId,
            previousOwner: eligibility.previousOwner,
            eligibility: eligibility.decision,
            reason: eligibility.reason,
            paused: Boolean(pausedRun),
          },
          `AgentExec: recovery skipped runId=${run.uuid} eligibility=${eligibility.decision} reason=${eligibility.reason} resumeAttemptId=${resumeAttemptId}`
        );
        continue;
      }

      if (eligibility.decision !== 'auto_resume_allowed') {
        skipped.push({ runId: run.uuid, decision: eligibility.decision, reason: eligibility.reason });
        logger().info(
          {
            runId: run.uuid,
            resumeAttemptId,
            previousOwner: eligibility.previousOwner,
            eligibility: eligibility.decision,
            reason: eligibility.reason,
          },
          `AgentExec: recovery skipped runId=${run.uuid} eligibility=${eligibility.decision} reason=${eligibility.reason} resumeAttemptId=${resumeAttemptId}`
        );
        continue;
      }

      const dispatch = await AgentRunQueueService.enqueueRun(run.uuid, 'resume');
      enqueued.push({
        runId: run.uuid,
        dispatchAttemptId: dispatch.dispatchAttemptId,
      });
      logger().info(
        {
          runId: run.uuid,
          reason: 'resume',
          dispatchAttemptId: dispatch.dispatchAttemptId,
          resumeAttemptId,
          previousOwner: eligibility.previousOwner,
          eligibility: eligibility.decision,
          eligibilityReason: eligibility.reason,
        },
        `AgentExec: recovery enqueued runId=${run.uuid} reason=resume eligibility=${eligibility.decision} eligibilityReason=${eligibility.reason} dispatchAttemptId=${dispatch.dispatchAttemptId} resumeAttemptId=${resumeAttemptId}`
      );
    } catch (error) {
      failed.push({ runId: run.uuid });
      logger().warn({ error, runId: run.uuid }, `AgentExec: recovery enqueue failed runId=${run.uuid}`);
    }
  }

  return {
    runs: runs.length,
    enqueued,
    skipped,
    paused,
    failed,
  };
}
