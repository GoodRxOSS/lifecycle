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

const SANDBOX_LAUNCH_REDIS_PREFIX = 'lifecycle:agent:sandbox-launch:';
const SANDBOX_LAUNCH_TTL_SECONDS = 60 * 60;

export type SandboxLaunchStage =
  | 'queued'
  | 'resolving_base_build'
  | 'resolving_services'
  | 'creating_sandbox_build'
  | 'resolving_environment'
  | 'deploying_resources'
  | 'opening_session'
  | 'ready'
  | 'error';

export interface SandboxLaunchState {
  launchId: string;
  userId: string;
  status: 'queued' | 'running' | 'created' | 'error';
  stage: SandboxLaunchStage;
  message: string;
  createdAt: string;
  updatedAt: string;
  baseBuildUuid?: string;
  service?: string;
  buildUuid?: string | null;
  namespace?: string | null;
  sessionId?: string | null;
  focusUrl?: string | null;
  error?: string | null;
}

function sandboxLaunchKey(launchId: string): string {
  return `${SANDBOX_LAUNCH_REDIS_PREFIX}${launchId}`;
}

export function buildSandboxFocusUrl(params: { buildUuid: string; sessionId: string; baseBuildUuid: string }): string {
  const searchParams = new URLSearchParams({
    baseBuildUuid: params.baseBuildUuid,
  });

  return `/environments/${params.buildUuid}/agent-session/${params.sessionId}?${searchParams.toString()}`;
}

export async function setSandboxLaunchState(redis: Redis, state: SandboxLaunchState): Promise<void> {
  await redis.setex(sandboxLaunchKey(state.launchId), SANDBOX_LAUNCH_TTL_SECONDS, JSON.stringify(state));
}

export async function getSandboxLaunchState(redis: Redis, launchId: string): Promise<SandboxLaunchState | null> {
  const raw = await redis.get(sandboxLaunchKey(launchId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as SandboxLaunchState;

    return {
      ...parsed,
      buildUuid: parsed.buildUuid ?? null,
      namespace: parsed.namespace ?? null,
      sessionId: parsed.sessionId ?? null,
      focusUrl: parsed.focusUrl ?? null,
      error: parsed.error ?? null,
    };
  } catch {
    return null;
  }
}

export async function patchSandboxLaunchState(
  redis: Redis,
  launchId: string,
  patch: Partial<SandboxLaunchState>
): Promise<SandboxLaunchState | null> {
  const current = await getSandboxLaunchState(redis, launchId);
  if (!current) {
    return null;
  }

  const next: SandboxLaunchState = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await setSandboxLaunchState(redis, next);
  return next;
}

export function toPublicSandboxLaunchState(state: SandboxLaunchState): Omit<SandboxLaunchState, 'userId'> {
  const { userId: _userId, ...publicState } = state;
  return {
    ...publicState,
    buildUuid: publicState.buildUuid ?? null,
    namespace: publicState.namespace ?? null,
    sessionId: publicState.sessionId ?? null,
    focusUrl: publicState.focusUrl ?? null,
    error: publicState.error ?? null,
  };
}
