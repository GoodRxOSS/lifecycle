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
import { createPublicApiHandler } from 'server/lib/createApiHandler';
import { successResponse, withNoStore } from 'server/lib/response';
import GlobalConfigService from 'server/services/globalConfig';
import { hasCredentials, isEnvConfigured, readBootstrapSecret, recoveredApp, type SetupFlow } from '../setupAccess';

export const runtime = 'nodejs';
export const GET = createPublicApiHandler(async (req: NextRequest) => {
  const flow = ((await GlobalConfigService.getInstance().getConfig('app_setup')) || {}) as SetupFlow;
  const secret = await readBootstrapSecret();
  const locked =
    (hasCredentials(secret) || isEnvConfigured()) && (!recoveredApp(flow, secret) || flow.phase === 'complete');
  return withNoStore(
    successResponse(
      {
        installed: !!flow.installed,
        created: !!flow.created,
        restarted: !!flow.restarted,
        url: flow.url || '',
        locked,
      },
      { status: 200 },
      req
    )
  );
});
