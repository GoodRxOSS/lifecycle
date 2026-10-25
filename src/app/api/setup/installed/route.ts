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
import { createAppAuth } from '@octokit/auth-app';
import { NextRequest, NextResponse } from 'next/server';
import { AppError, BadRequestError } from 'server/lib/appError';
import { createPublicApiHandler } from 'server/lib/createApiHandler';
import { withNoStore } from 'server/lib/response';
import { APP_HOST } from 'shared/config';
import {
  assertCurrentApp,
  assertSetupState,
  readBootstrapSecret,
  withSetupTransaction,
  writeBootstrapSecret,
} from '../setupAccess';

export const runtime = 'nodejs';
export const GET = createPublicApiHandler(async (req: NextRequest) => {
  const installationId = req.nextUrl.searchParams.get('installation_id');
  const setupAction = req.nextUrl.searchParams.get('setup_action');
  if (!installationId || !/^\d{1,20}$/.test(installationId))
    throw new BadRequestError(
      'GitHub did not return a valid installation ID. Install the App again.',
      'invalid_installation_id'
    );
  if (setupAction && setupAction !== 'install')
    throw new BadRequestError('Only a new installation can finish setup here.', 'unsupported_setup_action');
  return withSetupTransaction(async (flow, _trx, save) => {
    assertSetupState(flow, req.nextUrl.searchParams.get('state'), 'installation');
    const secret = await readBootstrapSecret();
    assertCurrentApp(flow, secret);
    const auth = createAppAuth({
      appId: secret.values.GITHUB_APP_ID,
      privateKey: secret.values.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });
    const { token } = await auth({ type: 'app' });
    const installation = await fetch(`https://api.github.com/app/installations/${installationId}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!installation.ok || String((await installation.json()).app_id) !== secret.values.GITHUB_APP_ID) {
      throw new AppError({
        httpStatus: 403,
        code: 'installation_not_allowed',
        message: 'This installation does not belong to the GitHub App created by setup.',
      });
    }
    await writeBootstrapSecret(secret, { GITHUB_APP_INSTALLATION_ID: installationId });
    await save({ ...flow, state: '', phase: 'installed', installed: true });
    const response = withNoStore(NextResponse.redirect(new URL('/setup/complete', APP_HOST)));
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  });
});
