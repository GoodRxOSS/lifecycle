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

// The AI SDK's default UI-stream onError masks every failure as "An error occurred.", which reaches
// the user as an empty agent turn and hides actionable provider errors (bad API key, quota, bad
// model). This maps an SDK/provider error to a concise, safe, actionable message. It surfaces only
// the provider's own error text (never the request URL, headers, or key) and is capped in length.

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  google: 'Google Gemini',
};

const MAX_PROVIDER_MESSAGE_LENGTH = 300;

export interface AgentStreamErrorContext {
  provider?: string | null;
  model?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function providerLabel(provider?: string | null): string {
  if (!provider) {
    return 'The model provider';
  }
  return PROVIDER_LABELS[provider.toLowerCase()] ?? provider;
}

// AI SDK RetryError wraps the underlying provider error (e.g. a 429 after exhausted retries); classify
// on the last real error so quota/rate-limit failures are recognized instead of a generic retry text.
function unwrapError(error: unknown): Record<string, unknown> {
  const record = asRecord(error);
  if (record.name === 'AI_RetryError' && record.lastError) {
    return asRecord(record.lastError);
  }
  return record;
}

function readStatusCode(error: Record<string, unknown>): number | null {
  return typeof error.statusCode === 'number' ? error.statusCode : null;
}

function readProviderMessage(error: Record<string, unknown>): string | null {
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  if (!message) {
    return null;
  }
  const collapsed = message.replace(/\s+/g, ' ');
  return collapsed.length > MAX_PROVIDER_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_PROVIDER_MESSAGE_LENGTH - 1)}…`
    : collapsed;
}

function withDetail(base: string, detail: string | null): string {
  return detail ? `${base} (${detail})` : base;
}

export function describeAgentStreamError(error: unknown, context: AgentStreamErrorContext = {}): string {
  const root = unwrapError(error);
  const name = typeof root.name === 'string' ? root.name : '';
  const status = readStatusCode(root);
  const providerMessage = readProviderMessage(root);
  const label = providerLabel(context.provider);
  const model = context.model || null;
  const haystack = `${name} ${providerMessage ?? ''}`.toLowerCase();

  const matches = (pattern: RegExp): boolean => pattern.test(haystack);

  if (
    name === 'AI_LoadAPIKeyError' ||
    status === 401 ||
    status === 403 ||
    matches(
      /api key not valid|invalid api key|incorrect api key|unauthenticated|permission denied|missing api key|no api key/
    )
  ) {
    return withDetail(
      `${label} rejected the API key. Update the ${label} key in Settings → Agent providers, then resend.`,
      providerMessage
    );
  }

  if (status === 429 || matches(/rate limit|quota|resource[_ ]exhausted|too many requests|insufficient_quota/)) {
    return withDetail(
      `${label} is rate-limiting or out of quota. Wait a moment and resend, or check your ${label} plan.`,
      providerMessage
    );
  }

  if (
    name === 'AI_NoSuchModelError' ||
    status === 404 ||
    matches(/model .*(not found|does not exist|not supported)|unknown model|no such model/)
  ) {
    return withDetail(
      model ? `${label} could not serve model "${model}".` : `${label} could not serve the requested model.`,
      providerMessage
    );
  }

  if (
    matches(
      /context length|maximum context|context window|too many tokens|prompt is too long|reduce the length|maximum.*tokens/
    )
  ) {
    return withDetail(
      `The conversation exceeds ${
        model ? `"${model}"'s` : "the model's"
      } context window. Start a new chat or remove earlier messages.`,
      providerMessage
    );
  }

  if (
    (typeof status === 'number' && status >= 500) ||
    matches(/overloaded|service unavailable|internal server error|temporarily/)
  ) {
    return withDetail(`${label} had a temporary server error. Resend in a moment.`, providerMessage);
  }

  if (providerMessage) {
    return `${label} returned an error: ${providerMessage}`;
  }

  return 'The model run failed unexpectedly. Check the server logs for details.';
}
