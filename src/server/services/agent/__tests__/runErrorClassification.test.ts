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

import { OAuthAuthorizationRequiredError } from '../../agentRuntime/mcp/oauthProvider';
import { AgentRunOwnershipLostError } from '../AgentRunOwnershipLostError';
import { AgentRunTerminalFailure } from '../errors';
import { classifyThrownRunError } from '../runErrorClassification';

type ApiErrorOptions = {
  message?: string;
  name?: string;
  responseBody?: unknown;
  statusCode?: number;
  url?: string;
};

function apiError({
  message = 'provider request failed',
  name = 'AI_APICallError',
  responseBody,
  statusCode,
  url,
}: ApiErrorOptions = {}): Error & Omit<ApiErrorOptions, 'message' | 'name'> {
  const error = new Error(message) as Error & Omit<ApiErrorOptions, 'message' | 'name'>;
  error.name = name;
  if (responseBody !== undefined) error.responseBody = responseBody;
  if (statusCode !== undefined) error.statusCode = statusCode;
  if (url !== undefined) error.url = url;
  return error;
}

describe('classifyThrownRunError', () => {
  it('preserves an existing terminal failure without changing its recovery contract', () => {
    const failure = new AgentRunTerminalFailure({
      code: 'stream_error',
      message: 'stream stopped',
      retryable: true,
      nextAction: { kind: 'retry', label: 'Try again' },
    });

    expect(classifyThrownRunError(failure)).toBe(failure);
  });

  it('classifies execution ownership loss as terminal and non-retryable', () => {
    const error = new AgentRunOwnershipLostError({
      runUuid: 'run-1',
      expectedExecutionOwner: 'worker-a',
      currentStatus: 'cancelled',
      currentExecutionOwner: 'worker-b',
    });

    expect(classifyThrownRunError(error)).toMatchObject({
      code: 'run_ownership_lost',
      message: 'This response was taken over by another worker or was cancelled.',
      retryable: false,
    });
  });

  it('classifies MCP OAuth failures with the reconnect action', () => {
    expect(classifyThrownRunError(new OAuthAuthorizationRequiredError())).toMatchObject({
      code: 'mcp_oauth_required',
      retryable: false,
      nextAction: { kind: 'reconnect', label: 'Reconnect server' },
    });
  });

  it.each([undefined, null, 'provider failed', { statusCode: 429 }, new Error('ordinary failure')])(
    'leaves an unrecognized thrown value unclassified: %p',
    (error) => {
      expect(classifyThrownRunError(error)).toBeNull();
    }
  );

  it('classifies exhausted quota before generic rate limiting and does not expose response text', () => {
    const result = classifyThrownRunError(
      apiError({
        message: 'request rejected',
        responseBody: '{"error":"insufficient_quota: credit balance depleted"}',
        statusCode: 429,
        url: 'https://provider.example/v1/messages',
      })
    );

    expect(result).toMatchObject({
      code: 'provider_quota_exhausted',
      message: 'The model provider rejected the request because the account is out of quota or credit.',
      retryable: false,
      nextAction: {
        kind: 'update_key',
        label: 'Check provider account',
        href: '/settings?tab=connections',
      },
      details: { status: 429, provider: 'https://provider.example/v1/messages' },
    });
    expect(result?.message).not.toContain('insufficient_quota');
  });

  it('classifies non-quota HTTP 429 failures as retryable rate limits', () => {
    expect(classifyThrownRunError(apiError({ statusCode: 429, responseBody: { code: 'rate_limit' } }))).toMatchObject({
      code: 'provider_rate_limited',
      retryable: true,
      nextAction: { kind: 'retry', label: 'Try again' },
      details: { status: 429, provider: '' },
    });
  });

  it.each([529, 503, 502])('classifies HTTP %i as transient provider overload', (statusCode) => {
    expect(classifyThrownRunError(apiError({ statusCode }))).toMatchObject({
      code: 'provider_overloaded',
      retryable: true,
      nextAction: { kind: 'retry', label: 'Try again' },
      details: { status: statusCode, provider: '' },
    });
  });

  it.each([401, 403])('classifies HTTP %i as an invalid provider credential', (statusCode) => {
    expect(classifyThrownRunError(apiError({ statusCode }))).toMatchObject({
      code: 'provider_auth_invalid',
      retryable: false,
      nextAction: { kind: 'update_key', label: 'Update key', href: '/settings?tab=connections' },
      details: { status: statusCode, provider: '' },
    });
  });

  it('classifies HTTP 404 as an unavailable model', () => {
    expect(classifyThrownRunError(apiError({ statusCode: 404 }))).toMatchObject({
      code: 'model_unavailable',
      retryable: false,
      nextAction: { kind: 'navigate', label: 'Change model' },
      details: { status: 404, provider: '' },
    });
  });

  it.each([400, 499])('classifies other client error boundary HTTP %i as an invalid request', (statusCode) => {
    expect(classifyThrownRunError(apiError({ statusCode }))).toMatchObject({
      code: 'provider_request_invalid',
      retryable: false,
      details: { status: statusCode, provider: '' },
    });
  });

  it.each([
    ['an unrecognized server response', apiError({ statusCode: 500 })],
    ['a named SDK error without a status', apiError()],
    ['an error carrying only a response body', apiError({ name: 'Error', responseBody: 'upstream closed' })],
  ])('fails toward retryable overload for %s', (_label, error) => {
    expect(classifyThrownRunError(error)).toMatchObject({
      code: 'provider_overloaded',
      retryable: true,
      nextAction: { kind: 'retry', label: 'Try again' },
    });
  });

  it('recognizes API errors by numeric status even when the SDK-specific name is absent', () => {
    expect(classifyThrownRunError(apiError({ name: 'Error', statusCode: 400 }))).toMatchObject({
      code: 'provider_request_invalid',
      details: { status: 400, provider: '' },
    });
  });
});
