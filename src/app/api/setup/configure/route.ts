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
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { NextRequest } from 'next/server';
import { AppError, ConflictError } from 'server/lib/appError';
import { createPublicApiHandler } from 'server/lib/createApiHandler';
import { getCurrentNamespaceFromFile } from 'server/lib/kubernetes';
import { successResponse, withNoStore } from 'server/lib/response';
import { APP_HOST } from 'shared/config';
import {
  assertCurrentApp,
  assertSetupActor,
  readBootstrapSecret,
  setupLocked,
  withSetupTransaction,
} from '../setupAccess';

export const runtime = 'nodejs';
const execFileAsync = promisify(execFile);
const DEFAULT_VALUES = new Set([
  '',
  '127.0.0.1.nip.io',
  'dev-0.127.0.0.1.nip.io',
  'distribution.example.com',
  '10.96.188.230:5000',
]);

export const POST = createPublicApiHandler(async (req: NextRequest) => {
  assertSetupActor(req);
  return withSetupTransaction(async (flow, trx, save) => {
    if (flow.phase === 'complete' || flow.restarted) throw setupLocked();
    if (flow.phase !== 'installed' || !flow.installed)
      throw new ConflictError('Install the GitHub App before configuring Lifecycle.', 'app_not_installed');
    assertCurrentApp(flow, await readBootstrapSecret());
    const namespace = getCurrentNamespaceFromFile();
    const releaseName = process.env.HELM_RELEASE_NAME;
    if (!namespace || !releaseName)
      throw new AppError({
        httpStatus: 503,
        code: 'restart_unavailable',
        message: 'Configure the namespace and Helm release before restarting Lifecycle.',
      });
    const publicUrl = new URL(APP_HOST);
    const domain = publicUrl.hostname.split('.').slice(1).join('.') || publicUrl.hostname;
    for (const [key, defaults] of [
      ['lifecycleDefaults', { ecrDomain: `distribution.${domain}`, defaultPublicUrl: `dev-0.${domain}` }],
      ['domainDefaults', { http: domain, grpc: domain, publicScheme: publicUrl.protocol.replace(':', '') }],
    ] as const) {
      await trx('global_config').insert({ key, config: {} }).onConflict('key').ignore();
      const row = await trx('global_config').where({ key }).forUpdate().first();
      const current = typeof row.config === 'string' ? JSON.parse(row.config) : row.config || {};
      const next = { ...current };
      for (const [name, value] of Object.entries(defaults)) {
        if (current[name] == null || DEFAULT_VALUES.has(current[name])) next[name] = value;
      }
      await trx('global_config').where({ key }).update({ config: next });
    }
    try {
      await execFileAsync(
        'kubectl',
        [
          'rollout',
          'restart',
          'deployment',
          '-l',
          `app.kubernetes.io/instance=${releaseName},app.kubernetes.io/name=lifecycle`,
          '-n',
          namespace,
        ],
        { timeout: 15_000 }
      );
    } catch {
      throw new AppError({
        httpStatus: 503,
        code: 'restart_failed',
        message: 'Lifecycle could not restart its deployments. Retry or restart them through your deployment tools.',
      });
    }
    await save({ ...flow, state: '', phase: 'complete', restarted: true });
    return withNoStore(successResponse({ restarted: true }, { status: 200 }, req));
  });
});
