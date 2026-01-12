/**
 * Copyright 2025 GoodRx, Inc.
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
import { getLogger } from 'server/lib/logger/index';
import { setupServiceAccountInNamespace } from '../../nativeHelm/utils';

export async function ensureServiceAccountForJob(
  namespace: string,
  jobType: 'build' | 'deploy' | 'webhook'
): Promise<string> {
  const { serviceAccount } = await GlobalConfigService.getInstance().getAllConfigs();
  const serviceAccountName = serviceAccount?.name || 'default';
  const role = serviceAccount?.role || 'default';

  getLogger().info(
    `ServiceAccount: setting up for job type=${jobType} namespace=${namespace} serviceAccount=${serviceAccountName} role=${role}`
  );

  await setupServiceAccountInNamespace(namespace, serviceAccountName, role);

  return serviceAccountName;
}
