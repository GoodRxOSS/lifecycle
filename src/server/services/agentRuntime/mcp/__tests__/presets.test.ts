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

import { getMcpPreset, listMcpPresets } from '../presets';

describe('MCP presets', () => {
  it('lists a uniquely keyed registry whose entries are addressable by key', () => {
    const presets = listMcpPresets();
    const keys = presets.map((preset) => preset.key);

    expect(presets.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    for (const preset of presets) {
      expect(getMcpPreset(preset.key)).toBe(preset);
    }
  });

  it('returns undefined for an absent or unknown preset key', () => {
    expect(getMcpPreset()).toBeUndefined();
    expect(getMcpPreset('unknown-preset')).toBeUndefined();
  });
});
