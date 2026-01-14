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

import { NextApiRequest, NextApiResponse } from 'next';
import { getCurrentNamespaceFromFile } from 'server/lib/kubernetes';
import { shellPromise } from 'server/lib/shell';
import { getLogger } from 'server/lib/logger';
import GlobalConfigService from 'server/services/globalConfig';
import { APP_HOST } from 'shared/config';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const namespace = getCurrentNamespaceFromFile();
  const releaseName = process.env.HELM_RELEASE_NAME;

  if (!namespace || !releaseName) {
    return res.status(500).json({ error: 'Restarting deployment failed' });
  }

  const globalConfigService = new GlobalConfigService();
  const app_setup = await globalConfigService.getConfig('app_setup');

  if (app_setup?.restarted) {
    return res.status(400).json({ error: 'Restart already requested' });
  }

  try {
    const appDomain = APP_HOST.split('.').slice(1).join('.');
    const lifecycleDefaults = await globalConfigService.getConfig('lifecycleDefaults');
    const domainDefaults = await globalConfigService.getConfig('domainDefaults');

    await globalConfigService.setConfig('lifecycleDefaults', {
      ...lifecycleDefaults,
      ecrDomain: `distribution.${appDomain}`,
      defaultPublicUrl: `dev-0.${appDomain}`,
    });

    await globalConfigService.setConfig('domainDefaults', {
      ...domainDefaults,
      http: appDomain,
      grpc: appDomain,
    });

    await globalConfigService.getAllConfigs(true);
    await shellPromise(
      `kubectl rollout restart deployment -l app.kubernetes.io/instance=${releaseName},app.kubernetes.io/name=lifecycle -n ${namespace}`
    );
    const updated_app_setup = {
      ...app_setup,
      restarted: true,
    };
    await globalConfigService.setConfig('app_setup', updated_app_setup);
    res.status(200).json({ message: 'Deployment restarted' });
  } catch (error) {
    getLogger().error({ error }, 'Setup: deployment restart failed');
    return res.status(500).json({ error: 'Restarting deployment failed' });
  }
}
