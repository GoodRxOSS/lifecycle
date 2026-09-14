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
import { podExecDeploymentEnabled } from './podExec/config';

// Only registered, supported switches are editable. Keep unrelated stored keys intact.
export const FEATURE_DEFINITIONS = [
  {
    key: 'podShell',
    label: 'Pod shells',
    description:
      'Open terminals in running environment containers. Turning this off also disconnects active shells. Logs remain available.',
  },
  {
    key: 'envLens',
    label: 'EnvLens default',
    description:
      'Enable EnvLens by default for services. Individual lifecycle.yaml service settings can override this default.',
  },
  {
    key: 'reconcileDeletedServices',
    label: 'Remove deleted services',
    description: 'Clean up services removed from lifecycle.yaml when an environment is redeployed.',
  },
] as const;
export type FeatureKey = (typeof FEATURE_DEFINITIONS)[number]['key'];
export type FeatureUpdates = Partial<Record<FeatureKey, boolean>>;

export async function getFeaturesConfig(refreshCache = false) {
  const { features } = await GlobalConfigService.getInstance().getAllConfigs(refreshCache);
  return FEATURE_DEFINITIONS.map((definition) => {
    const enabled = Boolean(features?.[definition.key]);
    const available = definition.key !== 'podShell' || podExecDeploymentEnabled();
    return { ...definition, enabled, available, effectiveEnabled: enabled && available };
  });
}

export async function updateFeaturesConfig(updates: FeatureUpdates) {
  const service = GlobalConfigService.getInstance();
  await service.updateConfig<Record<string, boolean>>('features', {}, (current) => ({ ...current, ...updates }));
  // Await refresh before reporting success. Other processes retain their existing 30-second TTL.
  return getFeaturesConfig(true);
}
