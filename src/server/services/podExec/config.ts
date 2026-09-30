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

import GlobalConfigService from 'server/services/globalConfig';

export function podExecDeploymentEnabled() {
  return process.env.POD_EXEC_ENABLED === 'true' && process.env.ENABLE_AUTH === 'true';
}

export async function podExecRuntimeEnabled() {
  if (!podExecDeploymentEnabled()) return false;
  try {
    return await GlobalConfigService.getInstance().isFeatureEnabled('podShell');
  } catch {
    return false;
  }
}
