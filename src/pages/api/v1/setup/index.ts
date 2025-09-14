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

import { randomBytes } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import logger from 'server/lib/logger';
import GlobalConfigService from 'server/services/globalConfig';
import { APP_HOST } from 'shared/config';

function isValidURL(url: string) {
  try {
    new URL(url);
    return true;
  } catch (error) {
    return false;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  const gc = new GlobalConfigService();
  const appSetup = await gc.getConfig('app_setup');
  if (appSetup?.installed) return res.redirect('/setup');

  const appName = typeof req.query.app_name === 'string' ? req.query.app_name.trim() : '';
  const appUrl = APP_HOST;
  const org = typeof req.query.org === 'string' ? req.query.org.trim() : '';

  if (appName.length > 34 || !/^[a-zA-Z0-9-]+$/.test(appName)) {
    return res.status(400).json({ error: 'App name is not valid.' });
  }

  if (org && (org.length > 39 || !/^[a-zA-Z0-9-]+$/.test(org))) {
    return res.status(400).json({ error: 'Organization name is not valid.' });
  }

  if (!appUrl || !isValidURL(appUrl)) {
    return res.status(400).json({ error: 'Application public URL is not valid.' });
  }

  const state = randomBytes(16).toString('hex');
  logger.info(`Generated state for setup: ${state}`);

  await gc.setConfig('app_setup', {
    state,
    created: false,
    installed: false,
    org,
    appUrl,
  });

  const manifest = {
    name: appName,
    url: appUrl,
    hook_attributes: { url: `${appUrl}/api/webhooks/github`, active: true },
    setup_url: `${appUrl}/api/v1/setup/installed`,
    redirect_url: `${appUrl}/api/v1/setup/callback`,
    callback_urls: [`${appUrl}/api/v1/setup/callback`],
    public: false,
    default_permissions: {
      contents: 'read',
      deployments: 'write',
      emails: 'read',
      issues: 'write',
      members: 'read',
      metadata: 'read',
      pull_requests: 'write',
      statuses: 'read',
    },
    default_events: [
      'issues',
      'issue_comment',
      'label',
      'membership',
      'organization',
      'repository',
      'public',
      'pull_request',
      'push',
      'team',
    ],
  };

  const actionUrl = org
    ? `https://github.com/organizations/${org}/settings/apps/new?state=${state}`
    : `https://github.com/settings/apps/new?state=${state}`;

  const html = `
  <form id="manifest-form"
          action="${actionUrl}"
          method="post">
      <input type="hidden" name="manifest"
             value='${JSON.stringify(manifest)}' />
    </form>
    <script>document.getElementById("manifest-form").submit()</script>
  `;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}
