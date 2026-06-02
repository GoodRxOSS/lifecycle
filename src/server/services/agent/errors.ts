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

function normalizeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return fallback;
}

interface AgentRunFailureAction {
  kind: 'continue' | 'retry' | 'reconnect' | 'update_key' | 'navigate';
  label: string;
  href?: string;
}

export class AgentRunTerminalFailure extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  /** Whether retrying the same run as-is is worthwhile (rate limit / transient overload). */
  readonly retryable?: boolean;
  /** Suggested recovery affordance surfaced to the user. */
  readonly nextAction?: AgentRunFailureAction;

  constructor({
    code,
    message,
    details,
    retryable,
    nextAction,
  }: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryable?: boolean;
    nextAction?: AgentRunFailureAction;
  }) {
    super(message);
    this.name = 'AgentRunTerminalFailure';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    this.nextAction = nextAction;
  }
}

export class SessionWorkspaceGatewayUnavailableError extends Error {
  readonly sessionId: string;

  constructor({ sessionId, cause }: { sessionId: string; cause: unknown }) {
    super(`Session workspace gateway unavailable: ${normalizeErrorMessage(cause, 'Connection failed.')}`);
    this.name = 'SessionWorkspaceGatewayUnavailableError';
    this.sessionId = sessionId;
  }
}
