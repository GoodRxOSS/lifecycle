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
import { isAppError, type AppErrorAction } from 'server/lib/appError';

const AGENT_SESSION_STARTUP_FAILURE_REDIS_PREFIX = 'lifecycle:agent:session:startup-failure:';
const AGENT_SESSION_STARTUP_FAILURE_TTL_SECONDS = 60 * 60;
const AGENT_SESSION_STARTUP_FAILURE_MESSAGE_MAX_LENGTH = 4000;
const DEFAULT_WORKSPACE_FAILURE_MESSAGE = 'Lifecycle could not open the workspace.';
const DEFAULT_STARTUP_FAILURE_MESSAGE = 'Lifecycle could not start the session workspace.';

export const WORKSPACE_RUNTIME_FAILURE_STAGES = [
  'create_session',
  'prepare_infrastructure',
  'connect_runtime',
  'attach_services',
  'suspend',
  'resume',
  'cleanup',
] as const;

export const WORKSPACE_RUNTIME_FAILURE_ORIGINS = [
  'agent_session',
  'chat_runtime',
  'sandbox_launch',
  'manual_runtime',
  'suspend',
  'resume',
  'cleanup',
  'legacy',
] as const;

export type WorkspaceRuntimeFailureStage = (typeof WORKSPACE_RUNTIME_FAILURE_STAGES)[number];
export type WorkspaceRuntimeFailureOrigin = (typeof WORKSPACE_RUNTIME_FAILURE_ORIGINS)[number];

export interface WorkspaceRuntimeFailure {
  stage: WorkspaceRuntimeFailureStage;
  title: string;
  message: string;
  recordedAt: string;
  retryable: boolean;
  origin: WorkspaceRuntimeFailureOrigin;
  /** Machine-readable failure code so durable failures honor the coded error contract. Optional for back-compat. */
  code?: string;
  /** Optional coded next-step affordance (mirrors AppError.nextAction). */
  nextAction?: AppErrorAction;
}

/** Stable fallback codes per failure stage when the originating error carries no AppError code. */
const DEFAULT_CODE_BY_STAGE: Record<WorkspaceRuntimeFailureStage, string> = {
  create_session: 'workspace_create_session_failed',
  prepare_infrastructure: 'workspace_prepare_infrastructure_failed',
  connect_runtime: 'workspace_connect_runtime_failed',
  attach_services: 'workspace_attach_services_failed',
  suspend: 'workspace_suspend_failed',
  resume: 'workspace_resume_failed',
  cleanup: 'workspace_cleanup_failed',
};

function deriveFailureCode(error: unknown, stage: WorkspaceRuntimeFailureStage, explicitCode?: string): string {
  if (explicitCode) {
    return explicitCode;
  }
  // Prefer the originating typed AppError's code when present.
  if (isAppError(error)) {
    return error.code;
  }
  return DEFAULT_CODE_BY_STAGE[stage];
}

function deriveNextAction(error: unknown, explicit?: AppErrorAction): AppErrorAction | undefined {
  if (explicit) {
    return explicit;
  }
  if (isAppError(error) && error.nextAction) {
    return error.nextAction;
  }
  return undefined;
}

export type AgentSessionStartupFailureStage = WorkspaceRuntimeFailureStage;

export interface AgentSessionStartupFailureState extends WorkspaceRuntimeFailure {
  sessionId: string;
}

export type PublicAgentSessionStartupFailure = WorkspaceRuntimeFailure;

function agentSessionStartupFailureKey(sessionId: string): string {
  return `${AGENT_SESSION_STARTUP_FAILURE_REDIS_PREFIX}${sessionId}`;
}

function truncateMessage(message: string): string {
  if (message.length <= AGENT_SESSION_STARTUP_FAILURE_MESSAGE_MAX_LENGTH) {
    return message;
  }

  return `${message.slice(0, AGENT_SESSION_STARTUP_FAILURE_MESSAGE_MAX_LENGTH - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isWorkspaceRuntimeFailureStage(value: unknown): value is WorkspaceRuntimeFailureStage {
  return typeof value === 'string' && WORKSPACE_RUNTIME_FAILURE_STAGES.includes(value as WorkspaceRuntimeFailureStage);
}

function isWorkspaceRuntimeFailureOrigin(value: unknown): value is WorkspaceRuntimeFailureOrigin {
  return (
    typeof value === 'string' && WORKSPACE_RUNTIME_FAILURE_ORIGINS.includes(value as WorkspaceRuntimeFailureOrigin)
  );
}

const APP_ERROR_ACTION_KINDS = ['continue', 'retry', 'reconnect', 'update_key', 'navigate'] as const;

function readNextAction(value: unknown): AppErrorAction | undefined {
  if (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    (APP_ERROR_ACTION_KINDS as readonly string[]).includes(value.kind) &&
    typeof value.label === 'string'
  ) {
    return {
      kind: value.kind as AppErrorAction['kind'],
      label: value.label,
      ...(typeof value.href === 'string' ? { href: value.href } : {}),
    };
  }
  return undefined;
}

function normalizeFailureMessage(error: unknown): string {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
      ? error
      : isRecord(error) && typeof error.message === 'string'
      ? error.message
      : DEFAULT_STARTUP_FAILURE_MESSAGE;

  return rawMessage.trim() || DEFAULT_STARTUP_FAILURE_MESSAGE;
}

function stripMessagePrefix(message: string, prefix: string): string {
  if (!message.startsWith(prefix)) {
    return message;
  }

  const stripped = message.slice(prefix.length).trim();
  return stripped || message;
}

function redactSensitiveText(message: string): string {
  const secretKey = String.raw`[A-Za-z0-9_.-]*(?:token|access[_-]?token|refresh[_-]?token|password|secret|api[_-]?key)[A-Za-z0-9_.-]*`;

  return message
    .replace(/Authorization:\s*(?:Bearer|token|Basic)\s+[^\s,;]+/gi, 'Authorization: [redacted]')
    .replace(new RegExp(String.raw`\b(${secretKey})\s*=\s*([^\s,;]+)`, 'gi'), '$1=[redacted]')
    .replace(
      new RegExp(String.raw`(["'])(${secretKey})\1\s*:\s*(["'])(?:\\.|(?!\3)[\s\S])*\3`, 'gi'),
      '$1$2$1: $3[redacted]$3'
    )
    .replace(new RegExp(String.raw`\b(${secretKey})\s*:\s*(["'])(?:\\.|(?!\2)[\s\S])*\2`, 'gi'), '$1: [redacted]')
    .replace(new RegExp(String.raw`\b(${secretKey})\s*:\s*[^\s,;]+`, 'gi'), '$1: [redacted]')
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi,
      '[redacted private key]'
    );
}

function stripRawDiagnostics(message: string): string {
  return message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line.replace(/\s+-\s+(?:raw pod log:|(?:npm|pnpm|yarn) ERR!|Traceback\b|at\s+\S+|command output:).*$/i, '')
    )
    .filter((line) => !/^(?:at\s+\S+|raw pod log:|(?:npm|pnpm|yarn) ERR!|stderr:|stdout:)/i.test(line))
    .filter((line) => !/\bat\s+\S+\s+\(.+\)/.test(line))
    .join(' ')
    .trim();
}

function sanitizeFailureText(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value : fallback;
  const redacted = redactSensitiveText(raw);
  const withoutRawDiagnostics = stripRawDiagnostics(redacted);
  return truncateMessage(withoutRawDiagnostics || fallback);
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
    title: defaultTitleForStage(stage),
    message,
  };
}

function defaultTitleForStage(stage: WorkspaceRuntimeFailureStage): string {
  switch (stage) {
    case 'create_session':
      return 'Agent session failed to start';
    case 'prepare_infrastructure':
      return 'Workspace infrastructure could not be prepared';
    case 'attach_services':
      return 'Attached services failed to start';
    case 'suspend':
      return 'Workspace could not be suspended';
    case 'resume':
      return 'Workspace could not be resumed';
    case 'cleanup':
      return 'Workspace cleanup failed';
    case 'connect_runtime':
    default:
      return 'Session workspace connection failed';
  }
}

function normalizeRecordedAt(value: unknown): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return value;
  }

  return new Date().toISOString();
}

function fallbackWorkspaceRuntimeFailure(
  params: {
    stage?: WorkspaceRuntimeFailureStage;
    origin?: WorkspaceRuntimeFailureOrigin;
    retryable?: boolean;
    recordedAt?: string;
  } = {}
): WorkspaceRuntimeFailure {
  return {
    stage: params.stage || 'connect_runtime',
    title: 'Workspace could not be opened',
    message: DEFAULT_WORKSPACE_FAILURE_MESSAGE,
    recordedAt: normalizeRecordedAt(params.recordedAt),
    retryable: params.retryable === true,
    origin: params.origin || 'legacy',
  };
}

export function buildWorkspaceRuntimeFailure(params: {
  error: unknown;
  stage?: WorkspaceRuntimeFailureStage;
  origin?: WorkspaceRuntimeFailureOrigin;
  retryable?: boolean;
  recordedAt?: string;
  /** Explicit stable code; otherwise derived from the AppError code or the stage default. */
  code?: string;
  nextAction?: AppErrorAction;
}): WorkspaceRuntimeFailure {
  const stage = params.stage || 'connect_runtime';
  const message = sanitizeFailureText(normalizeFailureMessage(params.error), DEFAULT_STARTUP_FAILURE_MESSAGE);
  const classified = classifyFailure(message, stage);
  const nextAction = deriveNextAction(params.error, params.nextAction);

  return {
    stage,
    title: sanitizeFailureText(classified.title, defaultTitleForStage(stage)),
    message: sanitizeFailureText(classified.message, DEFAULT_STARTUP_FAILURE_MESSAGE),
    recordedAt: normalizeRecordedAt(params.recordedAt),
    retryable: params.retryable === true,
    origin: params.origin || 'agent_session',
    code: deriveFailureCode(params.error, stage, params.code),
    ...(nextAction ? { nextAction } : {}),
  };
}

export function normalizeWorkspaceRuntimeFailure(
  failure: unknown,
  fallback: {
    stage?: WorkspaceRuntimeFailureStage;
    origin?: WorkspaceRuntimeFailureOrigin;
    retryable?: boolean;
    recordedAt?: string;
  } = {}
): WorkspaceRuntimeFailure {
  if (!isRecord(failure)) {
    return fallbackWorkspaceRuntimeFailure(fallback);
  }

  if (
    isWorkspaceRuntimeFailureStage(failure.stage) &&
    typeof failure.title === 'string' &&
    typeof failure.message === 'string'
  ) {
    const nextAction = readNextAction(failure.nextAction);
    return {
      stage: failure.stage,
      title: sanitizeFailureText(failure.title, defaultTitleForStage(failure.stage)),
      message: sanitizeFailureText(failure.message, DEFAULT_WORKSPACE_FAILURE_MESSAGE),
      recordedAt: normalizeRecordedAt(failure.recordedAt ?? fallback.recordedAt),
      retryable: typeof failure.retryable === 'boolean' ? failure.retryable : fallback.retryable === true,
      origin: isWorkspaceRuntimeFailureOrigin(failure.origin) ? failure.origin : fallback.origin || 'legacy',
      ...(typeof failure.code === 'string' && failure.code ? { code: failure.code } : {}),
      ...(nextAction ? { nextAction } : {}),
    };
  }

  return fallbackWorkspaceRuntimeFailure(fallback);
}

export function buildAgentSessionStartupFailure(params: {
  sessionId: string;
  error: unknown;
  stage?: AgentSessionStartupFailureStage;
  origin?: WorkspaceRuntimeFailureOrigin;
  retryable?: boolean;
}): AgentSessionStartupFailureState {
  const failure = buildWorkspaceRuntimeFailure({
    error: params.error,
    stage: params.stage,
    origin: params.origin,
    retryable: params.retryable,
  });

  return {
    ...failure,
    sessionId: params.sessionId,
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
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    return {
      ...normalizeWorkspaceRuntimeFailure(parsed, {
        stage: isWorkspaceRuntimeFailureStage(parsed.stage) ? parsed.stage : 'connect_runtime',
        origin: isWorkspaceRuntimeFailureOrigin(parsed.origin) ? parsed.origin : 'agent_session',
        recordedAt: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : undefined,
      }),
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : sessionId,
    };
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
