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

import RedisClient from 'server/lib/redisClient';
import { getLogger } from 'server/lib/logger';
import { decrypt } from 'server/lib/encryption';
import {
  buildSandboxFocusUrl,
  getSandboxLaunchState,
  patchSandboxLaunchState,
  SandboxLaunchStage,
  setSandboxLaunchState,
} from 'server/lib/agentSession/sandboxLaunchState';
import AgentSandboxSessionService, { LaunchSandboxSessionOptions } from 'server/services/agentSandboxSession';

const logger = getLogger();

export interface SandboxSessionLaunchJob extends Omit<LaunchSandboxSessionOptions, 'onProgress' | 'githubToken'> {
  launchId: string;
  encryptedGithubToken?: string | null;
}

export async function processAgentSandboxSessionLaunch(job: Job<SandboxSessionLaunchJob>): Promise<void> {
  const redis = RedisClient.getInstance().getRedis();
  const {
    launchId,
    userId,
    userIdentity,
    encryptedGithubToken,
    baseBuildUuid,
    service,
    model,
    agentImage,
    editorImage,
    nodeSelector,
    resources,
  } = job.data;

  const reportProgress = async (stage: SandboxLaunchStage, message: string): Promise<void> => {
    await patchSandboxLaunchState(redis, launchId, {
      status: stage === 'queued' ? 'queued' : 'running',
      stage,
      message,
    });
  };

  try {
    const result = await new AgentSandboxSessionService().launch({
      userId,
      userIdentity,
      githubToken: encryptedGithubToken ? decrypt(encryptedGithubToken) : null,
      baseBuildUuid,
      service,
      model,
      agentImage,
      editorImage,
      nodeSelector,
      resources,
      onProgress: reportProgress,
    });

    if (result.status !== 'created') {
      throw new Error('Sandbox launch job completed without creating a session');
    }

    const existingState = await getSandboxLaunchState(redis, launchId);
    await setSandboxLaunchState(redis, {
      launchId,
      userId,
      status: 'created',
      stage: 'ready',
      message: 'Sandbox session is ready',
      createdAt: existingState?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      baseBuildUuid,
      service: result.service,
      buildUuid: result.buildUuid,
      namespace: result.namespace,
      sessionId: result.session.uuid,
      focusUrl: buildSandboxFocusUrl({
        buildUuid: result.buildUuid,
        sessionId: result.session.uuid,
        baseBuildUuid,
      }),
    });
  } catch (error) {
    logger.error(
      {
        error,
        launchId,
        baseBuildUuid,
        service,
      },
      'Sandbox launch job failed'
    );
    await patchSandboxLaunchState(redis, launchId, {
      status: 'error',
      stage: 'error',
      message: error instanceof Error ? error.message : 'Sandbox launch failed unexpectedly',
      error: error instanceof Error ? error.message : 'Sandbox launch failed unexpectedly',
    });
    throw error;
  }
}
