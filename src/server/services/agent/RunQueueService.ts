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
import type { AgentRequestGitHubAuth, AgentGitHubAuthSource } from './githubAuth';
import { buildAgentRequestGitHubAuthFromToken, normalizeAgentRequestGitHubAuth } from './githubAuth';

export type AgentRunExecuteJob = {
  runId: string;
  dispatchAttemptId: string;
  reason?: 'submit' | 'approval_resolved' | 'resume';
  encryptedGithubToken?: string | null;
  githubTokenSource?: AgentGitHubAuthSource;
  githubUsername?: string | null;
  githubTokenWriteAuthorized?: boolean;
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
  githubAuth?: AgentRequestGitHubAuth | null;
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
    const githubAuth = normalizeAgentRequestGitHubAuth(
      options.githubAuth || buildAgentRequestGitHubAuthFromToken(options.githubToken, 'user')
    );
    const githubToken = githubAuth.githubToken?.trim();
    const dispatchAttemptId = randomUUID();
    await this.queue.add(
      'execute-run',
      {
        runId,
        dispatchAttemptId,
        reason,
        encryptedGithubToken: githubToken ? encrypt(githubToken) : null,
        githubTokenSource: githubAuth.source,
        githubUsername: githubAuth.githubUsername || null,
        githubTokenWriteAuthorized: githubAuth.writeAuthorized === true,
        ...extractContextForQueue(),
      },
      {
        jobId: `agent-run:${runId}:${dispatchAttemptId}`,
      }
    );

    return { dispatchAttemptId };
  }
}
