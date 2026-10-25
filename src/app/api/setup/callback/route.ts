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
import { NextRequest, NextResponse } from 'next/server';
import { AppError, BadRequestError } from 'server/lib/appError';
import { createPublicApiHandler } from 'server/lib/createApiHandler';
import { withNoStore } from 'server/lib/response';
import {
  assertSetupState,
  credentialFingerprint,
  hasCredentials,
  isEnvConfigured,
  nextFlow,
  readBootstrapSecret,
  recoveredApp,
  setupLocked,
  validGithubAppUrl,
  withSetupTransaction,
  writeBootstrapSecret,
} from '../setupAccess';

export const runtime = 'nodejs';
export const GET = createPublicApiHandler(async (req: NextRequest) => {
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  if (!code || !state)
    throw new BadRequestError(
      'GitHub did not return the setup code and state. Start setup again.',
      'missing_callback_params'
    );
  return withSetupTransaction(async (flow, _trx, save) => {
    assertSetupState(flow, state, 'manifest');
    let secret = await readBootstrapSecret();
    let app = recoveredApp(flow, secret);
    if (!app) {
      if (hasCredentials(secret) || isEnvConfigured()) throw setupLocked();
      const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new AppError({
          httpStatus: 502,
          code: 'github_conversion_failed',
          message: 'GitHub could not create the App. Start setup again.',
        });
      const { id, client_id, client_secret, webhook_secret, pem, html_url, slug } = await response.json();
      if (
        !id ||
        ![client_id, client_secret, webhook_secret, pem, slug].every(
          (value) => typeof value === 'string' && value.length > 0
        ) ||
        !validGithubAppUrl(html_url)
      ) {
        throw new AppError({
          httpStatus: 502,
          code: 'github_incomplete_credentials',
          message: 'GitHub returned incomplete App settings. Start setup again.',
        });
      }
      await writeBootstrapSecret(
        secret,
        {
          GITHUB_APP_ID: String(id),
          GITHUB_CLIENT_ID: client_id,
          GITHUB_CLIENT_SECRET: client_secret,
          GITHUB_WEBHOOK_SECRET: webhook_secret,
          GITHUB_PRIVATE_KEY: pem.replace(/\n/g, '\\n'),
        },
        { id: flow.flowId!, url: html_url, name: slug }
      );
      secret = await readBootstrapSecret();
      app = recoveredApp(flow, secret);
      if (!app) throw setupLocked();
    }
    const next = nextFlow(
      { ...flow, created: true, url: app.url, name: app.name, credentialFingerprint: credentialFingerprint(secret) },
      'installation'
    );
    await save(next);
    const response = withNoStore(NextResponse.redirect(`${app.url}/installations/new?state=${next.state}`));
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  });
});
