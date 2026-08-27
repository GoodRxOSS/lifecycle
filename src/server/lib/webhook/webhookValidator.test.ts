/**
 * Copyright 2026 Lifecycle contributors
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

import { validateWebhook, validateWebhooks } from './webhookValidator';

describe('validateWebhook', () => {
  it('stops at the missing type because type-specific validation is impossible', () => {
    expect(validateWebhook({} as any)).toEqual([{ field: 'type', message: 'Webhook type is required' }]);
  });

  it('reports common and type-specific Codefresh requirements together', () => {
    expect(validateWebhook({ type: 'codefresh' } as any)).toEqual([
      { field: 'state', message: 'Webhook state is required' },
      { field: 'env', message: 'Webhook env must be an object' },
      { field: 'pipelineId', message: 'Pipeline ID is required for codefresh webhooks' },
      { field: 'trigger', message: 'Trigger is required for codefresh webhooks' },
    ]);
  });

  it('accepts a complete Codefresh webhook', () => {
    expect(
      validateWebhook({
        type: 'codefresh',
        state: 'deployed',
        env: {},
        pipelineId: 'org/pipeline',
        trigger: 'webhook',
      } as any)
    ).toEqual([]);
  });

  it('requires Docker configuration before inspecting Docker fields', () => {
    expect(validateWebhook({ type: 'docker', state: 'deployed', env: {} } as any)).toEqual([
      { field: 'docker', message: 'Docker configuration is required for docker webhooks' },
    ]);
  });

  it.each([
    ['zero', 0, []],
    ['negative', -1, [{ field: 'docker.timeout', message: 'Docker timeout must be between 1 and 86400 seconds' }]],
    [
      'above one day',
      86401,
      [{ field: 'docker.timeout', message: 'Docker timeout must be between 1 and 86400 seconds' }],
    ],
    ['one day', 86400, []],
  ])('validates a %s Docker timeout', (_name, timeout, timeoutErrors) => {
    expect(
      validateWebhook({ type: 'docker', state: 'deployed', env: {}, docker: { image: '', timeout } } as any)
    ).toEqual([{ field: 'docker.image', message: 'Docker image is required' }, ...timeoutErrors]);
  });

  it('accepts a complete Docker webhook without an optional timeout', () => {
    expect(
      validateWebhook({ type: 'docker', state: 'deployed', env: {}, docker: { image: 'alpine:3' } } as any)
    ).toEqual([]);
  });

  it('requires command configuration before inspecting command fields', () => {
    expect(validateWebhook({ type: 'command', state: 'error', env: {} } as any)).toEqual([
      { field: 'command', message: 'Command configuration is required for command webhooks' },
    ]);
  });

  it.each([
    ['zero', 0, []],
    ['negative', -1, [{ field: 'command.timeout', message: 'Command timeout must be between 1 and 86400 seconds' }]],
    [
      'above one day',
      86401,
      [{ field: 'command.timeout', message: 'Command timeout must be between 1 and 86400 seconds' }],
    ],
    ['one day', 86400, []],
  ])('validates a %s command timeout', (_name, timeout, timeoutErrors) => {
    expect(
      validateWebhook({
        type: 'command',
        state: 'error',
        env: {},
        command: { image: '', script: '', timeout },
      } as any)
    ).toEqual([
      { field: 'command.image', message: 'Command image is required' },
      { field: 'command.script', message: 'Command script is required' },
      ...timeoutErrors,
    ]);
  });

  it('accepts a complete command webhook without an optional timeout', () => {
    expect(
      validateWebhook({
        type: 'command',
        state: 'torn_down',
        env: {},
        command: { image: 'alpine:3', script: 'echo done' },
      } as any)
    ).toEqual([]);
  });

  it('rejects non-object env and unknown webhook types', () => {
    expect(validateWebhook({ type: 'custom', state: 'deployed', env: 'KEY=value' } as any)).toEqual([
      { field: 'env', message: 'Webhook env must be an object' },
      { field: 'type', message: 'Invalid webhook type: custom' },
    ]);
  });
});

describe('validateWebhooks', () => {
  it('indexes only invalid webhook definitions', () => {
    const result = validateWebhooks([
      { type: 'command', state: 'deployed', env: {}, command: { image: 'alpine', script: 'true' } },
      { type: 'docker', state: 'deployed', env: {} },
      { type: 'codefresh', state: 'error', env: {}, pipelineId: 'org/pipeline', trigger: 'hook' },
      { type: 'unknown', state: 'deployed', env: {} },
    ] as any);

    expect([...result.entries()]).toEqual([
      [1, [{ field: 'docker', message: 'Docker configuration is required for docker webhooks' }]],
      [3, [{ field: 'type', message: 'Invalid webhook type: unknown' }]],
    ]);
  });
});
