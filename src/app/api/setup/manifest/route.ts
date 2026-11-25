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
import type { NextRequest } from 'next/server';
import { BadRequestError } from 'server/lib/appError';
import { createPublicApiHandler } from 'server/lib/createApiHandler';
import { successResponse, withNoStore } from 'server/lib/response';
import { APP_HOST, GITHUB_APP_AUTH_CALLBACK } from 'shared/config';
import {
  assertSetupActor,
  hasCredentials,
  isEnvConfigured,
  readBootstrapSecret,
  recoveredApp,
  credentialFingerprint,
  nextFlow,
  setupLocked,
  withSetupTransaction,
} from '../setupAccess';

export const runtime = 'nodejs';

export const POST = createPublicApiHandler(async (req: NextRequest) => {
  assertSetupActor(req);
  return withSetupTransaction(async (flow, _trx, save) => {
    if (flow.installed || flow.restarted) throw setupLocked();
    const secret = await readBootstrapSecret();
    if (hasCredentials(secret) || isEnvConfigured()) {
      const app = recoveredApp(flow, secret);
      if (!app || flow.installed) throw setupLocked();
      const next = nextFlow(
        { ...flow, created: true, url: app.url, name: app.name, credentialFingerprint: credentialFingerprint(secret) },
        'installation'
      );
      await save(next);
      return withNoStore(
        successResponse({ installUrl: `${app.url}/installations/new?state=${next.state}` }, { status: 200 }, req)
      );
    }
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestError('Enter the GitHub App name.', 'invalid_body');
    const appName = typeof body.appName === 'string' ? body.appName.trim() : '';
    const org = typeof body.org === 'string' ? body.org.trim() : '';
    if (!/^[a-zA-Z0-9-]{1,34}$/.test(appName)) throw new BadRequestError('App name is not valid.', 'invalid_app_name');
    if (org && !/^[a-zA-Z0-9-]{1,39}$/.test(org))
      throw new BadRequestError('Organization name is not valid.', 'invalid_organization');
    const appUrl = APP_HOST;
    let publicUrl: URL;
    try {
      publicUrl = new URL(appUrl);
    } catch {
      throw new BadRequestError('Application public URL is not valid.', 'invalid_app_host');
    }
    if (!['https:', 'http:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password)
      throw new BadRequestError('Application public URL is not valid.', 'invalid_app_host');
    const manifest = {
      name: appName,
      url: appUrl,
      hook_attributes: { url: `${appUrl}/api/webhooks/github`, active: true },
      setup_url: `${appUrl}/api/setup/installed`,
      redirect_url: `${appUrl}/api/setup/callback`,
      callback_urls: [`${appUrl}/api/setup/callback`, `${GITHUB_APP_AUTH_CALLBACK}`],
      public: false,
      default_permissions: {
        contents: 'write',
        deployments: 'write',
        issues: 'write',
        members: 'read',
        metadata: 'read',
        pull_requests: 'write',
        statuses: 'read',
        // GitHub refuses .github/workflows writes under contents:write alone; the agent's update_file tool needs this.
        workflows: 'write',
        emails: 'read',
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
    const next = nextFlow(
      { ...flow, flowId: undefined, created: false, installed: false, restarted: false, org, url: '' },
      'manifest'
    );
    await save(next);
    const actionUrl = org
      ? `https://github.com/organizations/${org}/settings/apps/new?state=${next.state}`
      : `https://github.com/settings/apps/new?state=${next.state}`;
    return withNoStore(successResponse({ actionUrl, manifest }, { status: 200 }, req));
  });
});
