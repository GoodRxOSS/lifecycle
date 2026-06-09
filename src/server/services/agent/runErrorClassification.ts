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

import { AgentRunTerminalFailure } from './errors';
import { AgentRunOwnershipLostError } from './AgentRunOwnershipLostError';
import { OAuthAuthorizationRequiredError } from '../agentRuntime/mcp/oauthProvider';

/** Closed set of run-failure codes the UI presents; keep in sync with the UI failure presenter. */
export type AgentRunFailureCode =
  // finishReason-derived (see classifyTerminalRunFailure in RunExecutor)
  | 'max_iterations_exceeded'
  | 'token_limit_reached'
  | 'content_filtered'
  | 'stream_error'
  | 'run_incomplete'
  // thrown provider / SDK / infra errors (this file)
  | 'provider_overloaded'
  | 'provider_rate_limited'
  | 'provider_auth_invalid'
  | 'provider_quota_exhausted'
  | 'model_unavailable'
  | 'provider_request_invalid'
  | 'mcp_oauth_required'
  | 'run_ownership_lost'
  | 'run_unknown_error';

type ApiCallErrorLike = Error & {
  responseBody?: unknown;
  statusCode?: number;
  url?: string;
};

function isApiCallErrorLike(error: unknown): error is ApiCallErrorLike {
  if (!(error instanceof Error)) {
    return false;
  }

  const candidate = error as ApiCallErrorLike;
  return error.name === 'AI_APICallError' || typeof candidate.statusCode === 'number' || 'responseBody' in candidate;
}

function looksLikeQuotaExhausted(error: ApiCallErrorLike): boolean {
  const haystack = `${error.message} ${typeof error.responseBody === 'string' ? error.responseBody : ''}`.toLowerCase();
  return (
    haystack.includes('credit balance') ||
    haystack.includes('quota') ||
    haystack.includes('insufficient_quota') ||
    haystack.includes('billing')
  );
}

/** The single place provider/infra failures get a stable code + recovery action; returns null when unclassifiable so callers fall back. */
export function classifyThrownRunError(error: unknown): AgentRunTerminalFailure | null {
  if (error instanceof AgentRunTerminalFailure) {
    return error;
  }

  if (error instanceof AgentRunOwnershipLostError) {
    return new AgentRunTerminalFailure({
      code: 'run_ownership_lost',
      message: 'This response was taken over by another worker or was cancelled.',
      retryable: false,
    });
  }

  if (error instanceof OAuthAuthorizationRequiredError) {
    return new AgentRunTerminalFailure({
      code: 'mcp_oauth_required',
      message: 'A connected MCP server needs to be re-authorized before the agent can continue.',
      retryable: false,
      nextAction: { kind: 'reconnect', label: 'Reconnect server' },
    });
  }

  if (isApiCallErrorLike(error)) {
    const status = error.statusCode;
    const provider = error.url || '';

    if (status === 429) {
      if (looksLikeQuotaExhausted(error)) {
        return new AgentRunTerminalFailure({
          code: 'provider_quota_exhausted',
          message: 'The model provider rejected the request because the account is out of quota or credit.',
          retryable: false,
          nextAction: { kind: 'update_key', label: 'Check provider account', href: '/settings?tab=connections' },
          details: { status, provider },
        });
      }
      return new AgentRunTerminalFailure({
        code: 'provider_rate_limited',
        message: 'The model provider is rate limiting requests. Wait a moment, then try again.',
        retryable: true,
        nextAction: { kind: 'retry', label: 'Try again' },
        details: { status, provider },
      });
    }

    if (status === 529 || status === 503 || status === 502) {
      return new AgentRunTerminalFailure({
        code: 'provider_overloaded',
        message: 'The model provider is temporarily overloaded. Try again in a moment.',
        retryable: true,
        nextAction: { kind: 'retry', label: 'Try again' },
        details: { status, provider },
      });
    }

    if (status === 401 || status === 403) {
      return new AgentRunTerminalFailure({
        code: 'provider_auth_invalid',
        message: 'The model provider rejected the API key. Update the key, then try again.',
        retryable: false,
        nextAction: { kind: 'update_key', label: 'Update key', href: '/settings?tab=connections' },
        details: { status, provider },
      });
    }

    if (status === 404) {
      return new AgentRunTerminalFailure({
        code: 'model_unavailable',
        message: 'The selected model is not available from the provider. Choose a different model, then try again.',
        retryable: false,
        nextAction: { kind: 'navigate', label: 'Change model' },
        details: { status, provider },
      });
    }

    if (typeof status === 'number' && status >= 400 && status < 500) {
      return new AgentRunTerminalFailure({
        code: 'provider_request_invalid',
        message: 'The model provider rejected the request.',
        retryable: false,
        details: { status, provider },
      });
    }

    return new AgentRunTerminalFailure({
      code: 'provider_overloaded',
      message: 'The model provider returned an error. Try again in a moment.',
      retryable: true,
      nextAction: { kind: 'retry', label: 'Try again' },
      details: { status, provider },
    });
  }

  return null;
}
