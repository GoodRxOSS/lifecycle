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

const isFeatureEnabled = jest.fn();
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: { getInstance: () => ({ isFeatureEnabled }) },
}));
import { podExecRuntimeEnabled } from './config';

describe('pod shell feature enforcement', () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.POD_EXEC_ENABLED = 'true';
    process.env.ENABLE_AUTH = 'true';
  });
  afterAll(() => {
    process.env = original;
  });
  test.each([true, false])('honors the cached features.podShell value %s', async (enabled) => {
    isFeatureEnabled.mockResolvedValue(enabled);
    await expect(podExecRuntimeEnabled()).resolves.toBe(enabled);
    expect(isFeatureEnabled).toHaveBeenCalledWith('podShell');
  });
  test('deployment flags remain a hard ceiling', async () => {
    process.env.POD_EXEC_ENABLED = 'false';
    await expect(podExecRuntimeEnabled()).resolves.toBe(false);
    expect(isFeatureEnabled).not.toHaveBeenCalled();
  });
  test('fails closed on a cache read error', async () => {
    isFeatureEnabled.mockRejectedValue(new Error('unavailable'));
    await expect(podExecRuntimeEnabled()).resolves.toBe(false);
  });
});
