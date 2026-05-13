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

import { NextRequest } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';
import { getRequestUserIdentity } from 'server/lib/get-user';
import { successResponse } from 'server/lib/response';
import { readUploadFile, sitesErrorResponse } from 'server/lib/sites/routeHelpers';
import SitesService from 'server/services/sites';

export const runtime = 'nodejs';

type RouteContext = {
  params: {
    siteId: string;
  };
};

const putHandler = async (req: NextRequest, { params }: RouteContext) => {
  try {
    const upload = await readUploadFile(req);
    const service = new SitesService();
    const site = await service.replaceSiteContent(params.siteId, {
      ...upload,
      user: getRequestUserIdentity(req),
    });
    return successResponse({ site }, { status: 200 }, req);
  } catch (error) {
    return sitesErrorResponse(error, req);
  }
};

export const PUT = createApiHandler(putHandler);
