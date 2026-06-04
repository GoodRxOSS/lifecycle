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
import { successResponse } from 'server/lib/response';
import { sitesErrorResponse } from 'server/lib/sites/routeHelpers';
import SitesService from 'server/services/sites';

type RouteContext = {
  params: Promise<{
    siteId: string;
  }>;
};

/**
 * @openapi
 * /api/v2/sites/{siteId}/extend:
 *   post:
 *     summary: Extend a hosted static site's expiration
 *     tags:
 *       - Sites
 *     operationId: extendSite
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Hosted static site expiration extended.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SiteSuccessResponse'
 *       '400':
 *         description: TTL is disabled for hosted sites.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Site not found or sites hosting is disabled.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const postHandler = async (req: NextRequest, { params }: RouteContext) => {
  const routeParams = await params;
  try {
    const service = new SitesService();
    const site = await service.extendSite(routeParams.siteId);
    return successResponse({ site }, { status: 200 }, req);
  } catch (error) {
    return sitesErrorResponse(error, req);
  }
};

export const POST = createApiHandler(postHandler);
