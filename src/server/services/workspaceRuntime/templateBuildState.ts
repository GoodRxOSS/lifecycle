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

const TEMPLATE_BUILD_REDIS_PREFIX = 'lifecycle:agent:workspace-template-build:';
const TEMPLATE_BUILD_TTL_SECONDS = 60 * 60;
const TEMPLATE_BUILD_MAX_LOG_LINES = 500;

export type WorkspaceTemplateBuildStage = 'queued' | 'preparing' | 'building' | 'configuring' | 'ready' | 'error';

export interface WorkspaceTemplateBuildState {
  buildId: string;
  backendId: string;
  status: 'queued' | 'running' | 'ready' | 'error';
  stage: WorkspaceTemplateBuildStage;
  message: string;
  templateName: string;
  logs: string[];
  templateId?: string | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

function templateBuildKey(buildId: string): string {
  return `${TEMPLATE_BUILD_REDIS_PREFIX}${buildId}`;
}

function activeTemplateBuildKey(backendId: string): string {
  return `${TEMPLATE_BUILD_REDIS_PREFIX}active:${backendId}`;
}

export function isTemplateBuildTerminal(state: Pick<WorkspaceTemplateBuildState, 'status'>): boolean {
  return state.status === 'ready' || state.status === 'error';
}

export async function setTemplateBuildState(redis: Redis, state: WorkspaceTemplateBuildState): Promise<void> {
  await redis.setex(templateBuildKey(state.buildId), TEMPLATE_BUILD_TTL_SECONDS, JSON.stringify(state));
}

export async function getTemplateBuildState(
  redis: Redis,
  buildId: string
): Promise<WorkspaceTemplateBuildState | null> {
  const raw = await redis.get(templateBuildKey(buildId));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as WorkspaceTemplateBuildState;
    return { ...parsed, logs: Array.isArray(parsed.logs) ? parsed.logs : [] };
  } catch {
    return null;
  }
}

export async function patchTemplateBuildState(
  redis: Redis,
  buildId: string,
  patch: Partial<WorkspaceTemplateBuildState>
): Promise<WorkspaceTemplateBuildState | null> {
  const current = await getTemplateBuildState(redis, buildId);
  if (!current) {
    return null;
  }
  const next: WorkspaceTemplateBuildState = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await setTemplateBuildState(redis, next);
  return next;
}

export async function appendTemplateBuildLogs(redis: Redis, buildId: string, lines: string[]): Promise<void> {
  if (!lines.length) {
    return;
  }
  const current = await getTemplateBuildState(redis, buildId);
  if (!current) {
    return;
  }
  const logs = [...current.logs, ...lines].slice(-TEMPLATE_BUILD_MAX_LOG_LINES);
  await setTemplateBuildState(redis, { ...current, logs, updatedAt: new Date().toISOString() });
}

export async function setActiveTemplateBuild(redis: Redis, backendId: string, buildId: string): Promise<void> {
  await redis.setex(activeTemplateBuildKey(backendId), TEMPLATE_BUILD_TTL_SECONDS, buildId);
}

export async function getActiveTemplateBuild(redis: Redis, backendId: string): Promise<string | null> {
  return redis.get(activeTemplateBuildKey(backendId));
}

export async function clearActiveTemplateBuild(redis: Redis, backendId: string): Promise<void> {
  await redis.del(activeTemplateBuildKey(backendId));
}
