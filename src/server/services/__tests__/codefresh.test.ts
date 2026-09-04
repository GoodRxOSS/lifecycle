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

const mockTriggerPipeline = jest.fn();
const mockUpdateLogContext = jest.fn();
const mockLogger = { error: jest.fn() };

jest.mock('server/lib/codefresh', () => ({
  triggerPipeline: (...args: unknown[]) => mockTriggerPipeline(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => mockLogger),
  updateLogContext: (context: unknown) => mockUpdateLogContext(context),
}));

import CodefreshService from '../codefresh';

describe('CodefreshService.triggerYamlConfigWebhookPipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTriggerPipeline.mockResolvedValue('codefresh-build-1');
  });

  it('triggers a complete webhook and records the build context', async () => {
    const service = new CodefreshService({} as any);
    const webhook = {
      name: 'notify',
      state: 'deployed',
      type: 'codefresh',
      pipelineId: 'org/pipeline',
      trigger: 'lifecycle',
    };
    const data = { buildUUID: 'build-uuid', value: 'one' };

    await expect(service.triggerYamlConfigWebhookPipeline(webhook as any, data)).resolves.toBe('codefresh-build-1');
    expect(mockUpdateLogContext).toHaveBeenCalledWith({ buildUuid: 'build-uuid' });
    expect(mockTriggerPipeline).toHaveBeenCalledWith('org/pipeline', 'lifecycle', data);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it.each(['state', 'type', 'pipelineId', 'trigger'] as const)(
    'rejects a webhook whose %s is undefined',
    async (field) => {
      const service = new CodefreshService({} as any);
      const webhook = {
        name: field === 'state' ? 'notify' : undefined,
        state: 'deployed',
        type: 'codefresh',
        pipelineId: 'org/pipeline',
        trigger: 'lifecycle',
        [field]: undefined,
      };

      await expect(service.triggerYamlConfigWebhookPipeline(webhook as any, null as any)).resolves.toBeUndefined();
      expect(mockUpdateLogContext).toHaveBeenCalledWith({ buildUuid: undefined });
      expect(mockTriggerPipeline).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        `Invalid webhook configuration: name=${webhook.name ?? ''} pipelineId=${webhook.pipelineId} trigger=${
          webhook.trigger
        }`
      );
    }
  );
});
