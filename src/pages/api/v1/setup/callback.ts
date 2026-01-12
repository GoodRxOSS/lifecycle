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
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send({ error: 'Missing authorization code' });
    if (!state) return res.status(400).send({ error: 'Missing state parameter' });

    getLogger().info(`Setup: callback received state=${state}`);

    const globalConfigService = new GlobalConfigService();
    const { state: storedState } = await globalConfigService.getConfig('app_setup');
    if (storedState !== state) {
      getLogger().warn(`Setup: invalid state received=${state} expected=${storedState}`);
      return res.status(400).send({ error: 'Invalid state parameter' });
    }

    // check if app is already installed
    const app_setup = await globalConfigService.getConfig('app_setup');
    if (app_setup.installed) {
      getLogger().warn('Setup: app already installed');
      return res.status(400).send({ error: 'App already installed' });
    }

    const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      const errorData = await response.json();
      getLogger().error({ errorData }, 'Setup: manifest conversion failed');
      return res.status(response.status).json({ error: 'Failed to convert manifest code' });
    }

    const creds = await response.json();
    const { id, client_id, client_secret, webhook_secret, pem, html_url, slug } = creds;

    if (!id || !client_id || !client_secret || !webhook_secret || !pem || !html_url) {
      return res.status(400).send({ error: 'Invalid response from GitHub' });
    }

    const namespace = getCurrentNamespaceFromFile();

    await updateSecret(
      SECRET_BOOTSTRAP_NAME,
      {
        GITHUB_APP_ID: id,
        GITHUB_CLIENT_ID: client_id,
        GITHUB_CLIENT_SECRET: client_secret,
        GITHUB_WEBHOOK_SECRET: webhook_secret,
        GITHUB_PRIVATE_KEY: pem.replace(/\n/g, '\\n'),
      },
      namespace
    );

    getLogger().info(`Setup: secrets updated appId=${id}`);

    await globalConfigService.setConfig('app_setup', {
      ...app_setup,
      created: true,
      url: html_url,
      name: slug,
    });

    const installationUrl = `${html_url}/installations/new`;
    getLogger().info(`Setup: redirecting to install url=${installationUrl}`);
    res.redirect(installationUrl);
  } catch (error) {
    getLogger().error({ error }, 'Setup: callback failed');
    res.status(500).send({ error: 'An error occurred during GitHub app setup' });
  }
}
