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

import QueueManager from 'server/lib/queueManager';
import RedisClient from 'server/lib/redisClient';
import { encrypt } from 'server/lib/encryption';
import { extractContextForQueue } from 'server/lib/logger';
import { QUEUE_NAMES } from 'shared/config';
import { randomUUID } from 'crypto';

export type AgentRunExecuteJob = {
  runId: string;
  dispatchAttemptId: string;
  reason?: 'submit' | 'approval_resolved' | 'resume';
  encryptedGithubToken?: string | null;
  correlationId?: string;
  buildUuid?: string;
  deployUuid?: string;
  serviceName?: string;
  sender?: string;
  repo?: string;
  pr?: number;
  branch?: string;
  sha?: string;
  _ddTraceContext?: Record<string, string>;
};

type EnqueueRunOptions = {
  githubToken?: string | null;
};

type EnqueueRunResult = {
  dispatchAttemptId: string;
};

export default class AgentRunQueueService {
  private static queue = QueueManager.getInstance().registerQueue(QUEUE_NAMES.AGENT_RUN_EXECUTE, {
    connection: RedisClient.getInstance().getConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  });

  static async enqueueRun(
    runId: string,
    reason: AgentRunExecuteJob['reason'] = 'submit',
    options: EnqueueRunOptions = {}
  ): Promise<EnqueueRunResult> {
    const githubToken = options.githubToken?.trim();
    const dispatchAttemptId = randomUUID();
    await this.queue.add(
      'execute-run',
      {
        runId,
        dispatchAttemptId,
        reason,
        encryptedGithubToken: githubToken ? encrypt(githubToken) : null,
        ...extractContextForQueue(),
      },
      {
        jobId: `agent-run:${runId}:${dispatchAttemptId}`,
      }
    );

    return { dispatchAttemptId };
  }
}
