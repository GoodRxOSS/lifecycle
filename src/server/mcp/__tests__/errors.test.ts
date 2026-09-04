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

import { McpExecutionError, toExecutionErrorEnvelope } from '../errors';

describe('toExecutionErrorEnvelope', () => {
  it('normalizes a retryable error into its public envelope', () => {
    const envelope = toExecutionErrorEnvelope(
      new McpExecutionError('rate_limited', '  Request limit reached  ', { retryAfterSeconds: 4.9 }),
      'request-1'
    );

    expect(envelope).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Request limit reached',
        retryable: true,
        retryAfterSeconds: 4,
        nextAction: 'retry',
        requestId: 'request-1',
      },
    });
  });

  it.each([
    ['blank after trimming', '   '],
    ['longer than 2,000 characters', 'x'.repeat(2_001)],
  ])('rejects a message that is %s', (_description, message) => {
    const error = new McpExecutionError('internal_error', message);

    expect(() => toExecutionErrorEnvelope(error, 'request-1')).toThrow(
      'Invalid MCP error message length for internal_error'
    );
  });

  it.each(['request\n1', 'x'.repeat(129)])('rejects an invalid request id', (requestId) => {
    const error = new McpExecutionError('internal_error', 'Unexpected failure');

    expect(() => toExecutionErrorEnvelope(error, requestId)).toThrow(
      'MCP requestId must be 1-128 visible ASCII characters'
    );
  });

  it('requires retry timing for rate-limit errors', () => {
    const error = new McpExecutionError('rate_limited', 'Request limit reached');

    expect(() => toExecutionErrorEnvelope(error, 'request-1')).toThrow('Invalid retryAfterSeconds for rate_limited');
  });

  it('forbids retry timing on non-retryable errors', () => {
    const error = new McpExecutionError('internal_error', 'Unexpected failure', { retryAfterSeconds: 5 });

    expect(() => toExecutionErrorEnvelope(error, 'request-1')).toThrow('Invalid retryAfterSeconds for internal_error');
  });

  it.each([
    [new McpExecutionError('internal_error', 'Unexpected failure', { details: { reason: 'database' } })],
    [new McpExecutionError('invalid_body', 'Request body is invalid')],
  ])('enforces the error code detail-presence contract', (error) => {
    expect(() => toExecutionErrorEnvelope(error, 'request-1')).toThrow(`Invalid details presence for ${error.code}`);
  });

  it('rejects details that do not satisfy the schema for their error code', () => {
    const error = new McpExecutionError('service_not_found', 'Service was not found', {
      details: { validServices: [''] },
    });

    expect(() => toExecutionErrorEnvelope(error, 'request-1')).toThrow(
      'Invalid valid_services details for service_not_found:'
    );
  });

  it('preserves schema-valid details and permits optional destroyed-environment details to be absent', () => {
    const details = { validServices: ['api', 'worker'] };

    expect(
      toExecutionErrorEnvelope(
        new McpExecutionError('service_not_found', 'Service was not found', { details }),
        'request-1'
      ).error
    ).toMatchObject({
      code: 'service_not_found',
      retryable: false,
      nextAction: 'fix_input',
      details,
    });
    expect(
      toExecutionErrorEnvelope(new McpExecutionError('env_not_found', 'Environment was not found'), 'request-2').error
    ).not.toHaveProperty('details');
  });
});
