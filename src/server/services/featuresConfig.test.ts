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
  test('returns only boolean values using the stored keys, with no registry', async () => {
    getAllConfigs.mockResolvedValue({
      features: { podShell: true, futureFlag: false, extendedFlag: { enabled: true } },
    });
    expect(await getFeaturesConfig()).toEqual({ podShell: true, futureFlag: false });
    getAllConfigs.mockResolvedValue({});
    expect(await getFeaturesConfig()).toEqual({});
  });
  test('merges arbitrary stored boolean keys, preserves unrelated data and awaits refresh', async () => {
    let stored = { podShell: true, futureFlag: false, extendedFlag: { enabled: true } };
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
    expect(await updateFeaturesConfig({ futureFlag: true })).toEqual({ podShell: true, futureFlag: true });
    expect(stored).toEqual({ podShell: true, futureFlag: true, extendedFlag: { enabled: true } });
    expect(updateConfig.mock.invocationCallOrder[0]).toBeLessThan(getAllConfigs.mock.invocationCallOrder[0]);
  });
  test.each(['missing', 'extendedFlag', 'toString'])(
    'rejects edits to a missing or non-boolean stored key: %s',
    async (key) => {
      updateConfig.mockImplementation(async (_key, _initial, update) =>
        update({ podShell: true, extendedFlag: { enabled: true } })
      );
      await expect(updateFeaturesConfig({ [key]: false })).rejects.toThrow('Unknown or non-boolean feature');
      expect(getAllConfigs).not.toHaveBeenCalled();
    }
  );
  test('a failed forced refresh is surfaced to the caller', async () => {
    updateConfig.mockResolvedValue({});
    getAllConfigs.mockRejectedValue(new Error('cache unavailable'));
    await expect(updateFeaturesConfig({ podShell: false })).rejects.toThrow('cache unavailable');
  });
});
