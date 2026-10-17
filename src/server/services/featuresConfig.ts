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

import GlobalConfigService from './globalConfig';

export type FeatureUpdates = Record<string, boolean>;
export class InvalidFeatureUpdateError extends Error {}

export async function getFeaturesConfig(refreshCache = false): Promise<Record<string, boolean>> {
  const { features } = await GlobalConfigService.getInstance().getAllConfigs(refreshCache);
  return Object.fromEntries(Object.entries(features ?? {}).filter(([, value]) => typeof value === 'boolean'));
}

export async function updateFeaturesConfig(updates: FeatureUpdates) {
  const service = GlobalConfigService.getInstance();
  await service.updateConfig<Record<string, boolean>>('features', {}, (current) => {
    for (const key of Object.keys(updates)) {
      if (!Object.prototype.hasOwnProperty.call(current, key) || typeof current[key] !== 'boolean') {
        throw new InvalidFeatureUpdateError(`Unknown or non-boolean feature: ${key}`);
      }
    }
    return { ...current, ...updates };
  });
  // Await refresh before reporting success. Other processes retain their existing 30-second TTL.
  return getFeaturesConfig(true);
}
