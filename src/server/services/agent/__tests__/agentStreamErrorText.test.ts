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

import { describeAgentStreamError } from '../agentStreamErrorText';

function apiCallError(fields: { message: string; statusCode?: number; name?: string }): Error {
  const error = new Error(fields.message);
  error.name = fields.name ?? 'AI_APICallError';
  Object.assign(error, { statusCode: fields.statusCode });
  return error;
}

describe('describeAgentStreamError', () => {
  it('surfaces the provider message for an invalid API key (the observed Gemini 400)', () => {
    const message = describeAgentStreamError(
      apiCallError({ message: 'API key not valid. Please pass a valid API key.', statusCode: 400 }),
      { provider: 'gemini', model: 'gemini-3.5-flash' }
    );
    expect(message).toContain('Google Gemini rejected the API key');
    expect(message).toContain('Settings → Agent providers');
    expect(message).toContain('API key not valid');
  });

  it('classifies 401/403 as an auth failure regardless of wording', () => {
    expect(
      describeAgentStreamError(apiCallError({ message: 'Unauthorized', statusCode: 401 }), { provider: 'openai' })
    ).toContain('OpenAI rejected the API key');
    expect(
      describeAgentStreamError(apiCallError({ message: 'Forbidden', statusCode: 403 }), { provider: 'anthropic' })
    ).toContain('Anthropic rejected the API key');
  });

  it('recognizes a missing key from LoadAPIKeyError', () => {
    expect(
      describeAgentStreamError(apiCallError({ message: 'No API key provided', name: 'AI_LoadAPIKeyError' }), {
        provider: 'anthropic',
      })
    ).toContain('Anthropic rejected the API key');
  });

  it('classifies rate limit / quota errors', () => {
    expect(
      describeAgentStreamError(apiCallError({ message: 'Rate limit reached', statusCode: 429 }), { provider: 'openai' })
    ).toContain('rate-limiting or out of quota');
    expect(
      describeAgentStreamError(apiCallError({ message: 'resource_exhausted', statusCode: 400 }), { provider: 'gemini' })
    ).toContain('rate-limiting or out of quota');
  });

  it('unwraps RetryError to classify the underlying quota failure', () => {
    const retry = new Error('Failed after 3 attempts. Last error: Too Many Requests');
    retry.name = 'AI_RetryError';
    Object.assign(retry, { lastError: apiCallError({ message: 'Too Many Requests', statusCode: 429 }) });
    expect(describeAgentStreamError(retry, { provider: 'gemini' })).toContain('rate-limiting or out of quota');
  });

  it('classifies unknown-model errors and includes the model id', () => {
    expect(
      describeAgentStreamError(apiCallError({ message: 'model not found', name: 'AI_NoSuchModelError' }), {
        provider: 'gemini',
        model: 'gemini-9-ultra',
      })
    ).toContain('gemini-9-ultra');
  });

  it('classifies context-window overflow', () => {
    expect(
      describeAgentStreamError(
        apiCallError({ message: 'This model maximum context length is 200000 tokens', statusCode: 400 }),
        {
          provider: 'anthropic',
          model: 'claude',
        }
      )
    ).toContain('context window');
  });

  it('treats 5xx as a temporary server error', () => {
    expect(
      describeAgentStreamError(apiCallError({ message: 'overloaded', statusCode: 503 }), { provider: 'anthropic' })
    ).toContain('temporary server error');
  });

  it('falls back to the raw provider message when unclassified', () => {
    expect(
      describeAgentStreamError(apiCallError({ message: 'Some novel provider failure', statusCode: 418 }), {
        provider: 'openai',
      })
    ).toBe('OpenAI returned an error: Some novel provider failure');
  });

  it('has a safe generic fallback when there is no message', () => {
    const bare = new Error('');
    expect(describeAgentStreamError(bare, { provider: 'openai' })).toBe(
      'The model run failed unexpectedly. Check the server logs for details.'
    );
  });

  it('collapses whitespace and caps long provider messages', () => {
    const long = 'x'.repeat(500);
    const message = describeAgentStreamError(apiCallError({ message: long, statusCode: 400 }), { provider: 'openai' });
    expect(message.length).toBeLessThan(360);
    expect(message).toContain('…');
  });

  it('does not leak a request URL even if present on the error', () => {
    const error = apiCallError({ message: 'API key not valid', statusCode: 400 });
    Object.assign(error, { url: 'https://generativelanguage.googleapis.com/v1beta/models/x?key=SECRET' });
    const message = describeAgentStreamError(error, { provider: 'gemini' });
    expect(message).not.toContain('SECRET');
    expect(message).not.toContain('googleapis.com');
  });
});
