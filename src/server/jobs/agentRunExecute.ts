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

import { Job } from 'bullmq';
import { randomBytes } from 'crypto';
import os from 'os';
import { getLogger } from 'server/lib/logger';
import { withLogContext } from 'server/lib/logger/context';
import { decrypt } from 'server/lib/encryption';
import LifecycleAiSdkHarness from 'server/services/agent/LifecycleAiSdkHarness';
import AgentRunService from 'server/services/agent/RunService';
import { AgentRunOwnershipLostError } from 'server/services/agent/AgentRunOwnershipLostError';
import type { AgentRunExecuteJob } from 'server/services/agent/RunQueueService';

const logger = () => getLogger();

function requireJobString(value: unknown, field: keyof AgentRunExecuteJob): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid agent run execute job payload: ${field} is required`);
  }

  return value.trim();
}

function buildExecutionOwner(jobId: string): string {
  return `bull:${jobId}:${os.hostname()}:${process.pid}:${randomBytes(6).toString('hex')}`;
}

export async function processAgentRunExecute(job: Job<AgentRunExecuteJob>): Promise<void> {
  await withLogContext(job.data, async () => {
    const runId = requireJobString(job.data.runId, 'runId');
    const dispatchAttemptId = requireJobString(job.data.dispatchAttemptId, 'dispatchAttemptId');
    const executionOwner = buildExecutionOwner(String(job.id || 'unknown'));
    const run = await AgentRunService.claimQueuedRunForExecution(runId, executionOwner);
    if (!run) {
      logger().info(
        `AgentExec: queued run skip runId=${runId} reason=${
          job.data.reason || 'submit'
        } dispatchAttemptId=${dispatchAttemptId} owner=${executionOwner}`
      );
      return;
    }

    try {
      logger().info(
        `AgentExec: queued run start runId=${run.uuid} reason=${
          job.data.reason || 'submit'
        } dispatchAttemptId=${dispatchAttemptId} owner=${executionOwner}`
      );
      await LifecycleAiSdkHarness.executeRun(run, {
        requestGitHubToken: job.data.encryptedGithubToken ? decrypt(job.data.encryptedGithubToken) : null,
        dispatchAttemptId,
      });
      logger().info(
        `AgentExec: queued run finish runId=${run.uuid} dispatchAttemptId=${dispatchAttemptId} owner=${executionOwner}`
      );
    } catch (error) {
      if (error instanceof AgentRunOwnershipLostError) {
        logger().info(
          {
            runId: run.uuid,
            owner: executionOwner,
            currentStatus: error.currentStatus || null,
            currentOwner: error.currentExecutionOwner || null,
          },
          `AgentExec: ownership lost runId=${run.uuid} owner=${executionOwner}`
        );
        return;
      }

      const latestRun = await AgentRunService.getRunByUuid(run.uuid);
      if (!latestRun || !AgentRunService.isTerminalStatus(latestRun.status)) {
        await AgentRunService.markFailedForExecutionOwner(run.uuid, executionOwner, error, undefined, {
          dispatchAttemptId,
        }).catch((failureRecordError) => {
          if (failureRecordError instanceof AgentRunOwnershipLostError) {
            logger().info(
              {
                runId: run.uuid,
                owner: executionOwner,
                currentStatus: failureRecordError.currentStatus || null,
                currentOwner: failureRecordError.currentExecutionOwner || null,
              },
              `AgentExec: ownership lost runId=${run.uuid} owner=${executionOwner}`
            );
            return;
          }

          logger().warn(
            { error: failureRecordError, runId: run.uuid },
            `AgentExec: queued run failure record failed runId=${run.uuid}`
          );
        });
      }

      throw error;
    }
  });
}
