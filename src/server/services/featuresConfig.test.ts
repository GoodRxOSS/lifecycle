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

const getAllConfigs = jest.fn();
const updateConfig = jest.fn();
jest.mock('./globalConfig', () => ({
  __esModule: true,
  default: { getInstance: () => ({ getAllConfigs, updateConfig }) },
}));
import { getFeaturesConfig, updateFeaturesConfig } from './featuresConfig';

describe('feature settings', () => {
  const original = { exec: process.env.POD_EXEC_ENABLED, auth: process.env.ENABLE_AUTH };
  beforeEach(() => {
    process.env.POD_EXEC_ENABLED = 'true';
    process.env.ENABLE_AUTH = 'true';
  });
  afterAll(() => {
    for (const [key, value] of [
      ['POD_EXEC_ENABLED', original.exec],
      ['ENABLE_AUTH', original.auth],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  });
  test('missing flags are off and deployment support cannot override the setting', async () => {
    getAllConfigs.mockResolvedValue({});
    expect((await getFeaturesConfig()).every((flag) => !flag.enabled && !flag.effectiveEnabled)).toBe(true);
    getAllConfigs.mockResolvedValue({ features: { podShell: true } });
    process.env.POD_EXEC_ENABLED = 'false';
    expect((await getFeaturesConfig())[0]).toMatchObject({ enabled: true, available: false, effectiveEnabled: false });
  });
  test('merges a partial edit and awaits a forced cache refresh', async () => {
    let stored = { podShell: true, envLens: true, unlistedFlag: true };
    updateConfig.mockImplementation(async (key, initial, update) => {
      expect(key).toBe('features');
      expect(initial).toEqual({});
      stored = update(stored);
      return stored;
    });
    getAllConfigs.mockImplementation(async (refresh) => {
      expect(refresh).toBe(true);
      return { features: stored };
    });
    expect((await updateFeaturesConfig({ podShell: false }))[0].effectiveEnabled).toBe(false);
    expect(stored).toEqual({ podShell: false, envLens: true, unlistedFlag: true });
    expect(updateConfig.mock.invocationCallOrder[0]).toBeLessThan(getAllConfigs.mock.invocationCallOrder[0]);
  });
  test('a failed forced refresh is surfaced to the caller', async () => {
    updateConfig.mockResolvedValue({});
    getAllConfigs.mockRejectedValue(new Error('cache unavailable'));
    await expect(updateFeaturesConfig({ podShell: false })).rejects.toThrow('cache unavailable');
  });
});
