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

const logger = () => getLogger();

export async function processAgentRunDispatchRecovery(): Promise<{
  runs: number;
  enqueued: Array<{ runId: string; dispatchAttemptId: string }>;
  failed: Array<{ runId: string }>;
}> {
  const runs = await AgentRunService.listRunsNeedingDispatch();
  if (runs.length === 0) {
    return {
      runs: 0,
      enqueued: [],
      failed: [],
    };
  }

  logger().info(`AgentExec: recovery enqueue runs=${runs.length}`);
  const enqueued: Array<{ runId: string; dispatchAttemptId: string }> = [];
  const failed: Array<{ runId: string }> = [];
  for (const run of runs) {
    try {
      const dispatch = await AgentRunQueueService.enqueueRun(run.uuid, 'resume');
      enqueued.push({
        runId: run.uuid,
        dispatchAttemptId: dispatch.dispatchAttemptId,
      });
      logger().info(
        { runId: run.uuid, reason: 'resume', dispatchAttemptId: dispatch.dispatchAttemptId },
        `AgentExec: recovery enqueued runId=${run.uuid} reason=resume dispatchAttemptId=${dispatch.dispatchAttemptId}`
      );
    } catch (error) {
      failed.push({ runId: run.uuid });
      logger().warn({ error, runId: run.uuid }, `AgentExec: recovery enqueue failed runId=${run.uuid}`);
    }
  }

  return {
    runs: runs.length,
    enqueued,
    failed,
  };
}
