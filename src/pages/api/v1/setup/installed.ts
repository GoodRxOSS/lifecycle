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

import type { NextApiRequest, NextApiResponse } from 'next';
import { updateSecret, getCurrentNamespaceFromFile } from 'server/lib/kubernetes';
import { getLogger } from 'server/lib/logger/index';
import GlobalConfigService from 'server/services/globalConfig';
import { SECRET_BOOTSTRAP_NAME } from 'shared/config';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { installation_id, setup_action } = req.query;

  if (!installation_id) {
    return res.status(400).json({ error: 'Missing installation_id' });
  }
  if (setup_action && setup_action !== 'install') {
    getLogger().warn(`Setup: invalid setup_action received=${setup_action} expected=install`);
    return res.status(500).json({ error: 'Invalid setup_action' });
  }

  const globalConfigService = new GlobalConfigService();
  const app_setup = await globalConfigService.getConfig('app_setup');
  if (!app_setup) {
    getLogger().warn('Setup: app_setup not found');
    return res.status(404).json({ error: 'No app_setup found.' });
  }

  if (app_setup.installed) {
    getLogger().warn('Setup: app already installed');
    return res.status(400).json({ error: 'App already installed.' });
  }

  const updated_app_setup = {
    ...app_setup,
    installed: true,
  };
  await globalConfigService.setConfig('app_setup', updated_app_setup);
  getLogger().info(`Setup: installation recorded installationId=${installation_id}`);
  const namespace = getCurrentNamespaceFromFile();
  await updateSecret(
    SECRET_BOOTSTRAP_NAME,
    {
      GITHUB_APP_INSTALLATION_ID: installation_id as string,
    },
    namespace
  );

  const app_setup_url_encoded = encodeURIComponent(JSON.stringify(updated_app_setup));
  getLogger().info('Setup: redirecting to completion page');
  res.redirect(`/setup/complete?app_setup=${app_setup_url_encoded}`);
}
