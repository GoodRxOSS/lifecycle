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

const mockLogger = { fatal: jest.fn() };

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => mockLogger),
}));

import { FeatureFlags } from 'shared/constants';
import { ConfigFileWebhookEnvironmentVariables } from './configFileWebhookEnvVariables';

describe('ConfigFileWebhookEnvironmentVariables.resolve', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['a non-array feature value', undefined, true],
    ['ordinary enabled features', ['another-feature'], true],
    ['NO_DEFAULT_ENV_RESOLVE', [FeatureFlags.NO_DEFAULT_ENV_RESOLVE], false],
  ])('resolves webhook env with default UUID usage for %s', async (_name, enabledFeatures, useDefaultUuid) => {
    const service = new ConfigFileWebhookEnvironmentVariables({} as any);
    const availableEnvironmentVariablesForBuild = jest
      .spyOn(service as any, 'availableEnvironmentVariablesForBuild')
      .mockResolvedValue({ RAW: 'available' });
    const cleanup = jest.spyOn(service as any, 'cleanup').mockReturnValue({ CLEAN: 'available' });
    const compileEnv = jest.spyOn(service as any, 'compileEnv').mockResolvedValue({ COMPILED: 'value' });
    const parseTemplateData = jest.spyOn(service as any, 'parseTemplateData').mockReturnValue({ FINAL: 'value' });
    const build = {
      namespace: 'env-build-uuid',
      enabledFeatures,
      $fetchGraph: jest.fn().mockResolvedValue(undefined),
    };
    const webhook = { env: { WEBHOOK: '{{RAW}}' } };

    await expect(service.resolve(build as any, webhook as any)).resolves.toEqual({ FINAL: 'value' });

    expect(build.$fetchGraph).toHaveBeenCalledTimes(2);
    expect(build.$fetchGraph).toHaveBeenNthCalledWith(1, '[services, deploys.deployable.repository]');
    expect(availableEnvironmentVariablesForBuild).toHaveBeenCalledWith(build);
    expect(cleanup).toHaveBeenCalledWith({ RAW: 'available' });
    expect(compileEnv).toHaveBeenCalledWith(
      { WEBHOOK: '{{RAW}}' },
      { CLEAN: 'available' },
      useDefaultUuid,
      'env-build-uuid'
    );
    expect(parseTemplateData).toHaveBeenCalledWith({ COMPILED: 'value' });
  });

  it('uses an empty environment when the webhook omits env', async () => {
    const service = new ConfigFileWebhookEnvironmentVariables({} as any);
    jest.spyOn(service as any, 'availableEnvironmentVariablesForBuild').mockResolvedValue({});
    jest.spyOn(service as any, 'cleanup').mockReturnValue({});
    const compileEnv = jest.spyOn(service as any, 'compileEnv').mockResolvedValue({});
    jest.spyOn(service as any, 'parseTemplateData').mockReturnValue({});
    const build = { namespace: 'env-build', enabledFeatures: [], $fetchGraph: jest.fn() };

    await service.resolve(build as any, {} as any);

    expect(compileEnv).toHaveBeenCalledWith({}, {}, true, 'env-build');
  });

  it('records a fatal error and returns no env when the build is absent', async () => {
    const service = new ConfigFileWebhookEnvironmentVariables({} as any);

    await expect(service.resolve(null as any, { env: {} } as any)).resolves.toBeUndefined();
    expect(mockLogger.fatal).toHaveBeenCalledWith('Webhook: build and webhook undefined');
  });
});
