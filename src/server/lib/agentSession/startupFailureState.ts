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

import type { Redis } from 'ioredis';

const AGENT_SESSION_STARTUP_FAILURE_REDIS_PREFIX = 'lifecycle:agent:session:startup-failure:';
const AGENT_SESSION_STARTUP_FAILURE_TTL_SECONDS = 60 * 60;
const AGENT_SESSION_STARTUP_FAILURE_MESSAGE_MAX_LENGTH = 4000;

export type AgentSessionStartupFailureStage = 'create_session' | 'connect_runtime' | 'attach_services';

export interface AgentSessionStartupFailureState {
  sessionId: string;
  stage: AgentSessionStartupFailureStage;
  title: string;
  message: string;
  recordedAt: string;
}

export type PublicAgentSessionStartupFailure = Omit<AgentSessionStartupFailureState, 'sessionId'>;

function agentSessionStartupFailureKey(sessionId: string): string {
  return `${AGENT_SESSION_STARTUP_FAILURE_REDIS_PREFIX}${sessionId}`;
}

function truncateMessage(message: string): string {
  if (message.length <= AGENT_SESSION_STARTUP_FAILURE_MESSAGE_MAX_LENGTH) {
    return message;
  }

  return `${message.slice(0, AGENT_SESSION_STARTUP_FAILURE_MESSAGE_MAX_LENGTH - 3)}...`;
}

function normalizeFailureMessage(error: unknown): string {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
      ? error
      : 'Lifecycle could not start the session workspace.';
  const message = rawMessage.trim() || 'Lifecycle could not start the session workspace.';

  return truncateMessage(message);
}

function stripMessagePrefix(message: string, prefix: string): string {
  if (!message.startsWith(prefix)) {
    return message;
  }

  const stripped = message.slice(prefix.length).trim();
  return stripped || message;
}

function classifyFailure(
  message: string,
  stage: AgentSessionStartupFailureStage
): Pick<PublicAgentSessionStartupFailure, 'title' | 'message'> {
  if (/^Session workspace pod failed to start:/i.test(message)) {
    return {
      title: 'Session workspace pod failed to start',
      message: stripMessagePrefix(message, 'Session workspace pod failed to start:'),
    };
  }

  if (/^Session workspace pod did not become ready within/i.test(message)) {
    return {
      title: 'Session workspace did not become ready',
      message,
    };
  }

  if (/ImagePullBackOff|ErrImagePull/i.test(message)) {
    return {
      title: 'Session workspace image could not be pulled',
      message,
    };
  }

  if (/init-workspace/i.test(message)) {
    return {
      title: 'Workspace initialization failed',
      message,
    };
  }

  if (/init-skills/i.test(message)) {
    return {
      title: 'Skill initialization failed',
      message,
    };
  }

  if (/editor/i.test(message)) {
    return {
      title: 'Workspace editor failed to start',
      message,
    };
  }

  return {
    title:
      stage === 'create_session'
        ? 'Agent session failed to start'
        : stage === 'attach_services'
        ? 'Attached services failed to start'
        : 'Session workspace connection failed',
    message,
  };
}

export function buildAgentSessionStartupFailure(params: {
  sessionId: string;
  error: unknown;
  stage?: AgentSessionStartupFailureStage;
}): AgentSessionStartupFailureState {
  const stage = params.stage || 'connect_runtime';
  const message = normalizeFailureMessage(params.error);
  const classified = classifyFailure(message, stage);

  return {
    sessionId: params.sessionId,
    stage,
    title: classified.title,
    message: classified.message,
    recordedAt: new Date().toISOString(),
  };
}

export async function setAgentSessionStartupFailure(
  redis: Redis,
  failure: AgentSessionStartupFailureState
): Promise<void> {
  await redis.setex(
    agentSessionStartupFailureKey(failure.sessionId),
    AGENT_SESSION_STARTUP_FAILURE_TTL_SECONDS,
    JSON.stringify(failure)
  );
}

export async function getAgentSessionStartupFailure(
  redis: Redis,
  sessionId: string
): Promise<AgentSessionStartupFailureState | null> {
  const raw = await redis.get(agentSessionStartupFailureKey(sessionId));
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as AgentSessionStartupFailureState;
  } catch {
    return null;
  }
}

export async function clearAgentSessionStartupFailure(redis: Redis, sessionId: string): Promise<void> {
  await redis.del(agentSessionStartupFailureKey(sessionId));
}

export function toPublicAgentSessionStartupFailure(
  failure: AgentSessionStartupFailureState
): PublicAgentSessionStartupFailure {
  const { sessionId: _sessionId, ...publicFailure } = failure;
  return publicFailure;
}
