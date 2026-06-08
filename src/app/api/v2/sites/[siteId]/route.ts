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
 * /api/v2/sites/{siteId}:
 *   get:
 *     summary: Get a hosted static site
 *     tags:
 *       - Sites
 *     operationId: getSite
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Hosted static site.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SiteSuccessResponse'
 *       '404':
 *         description: Site not found or sites hosting is disabled.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   delete:
 *     summary: Delete a hosted static site
 *     tags:
 *       - Sites
 *     operationId: deleteSite
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: Hosted static site deleted.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SiteSuccessResponse'
 *       '404':
 *         description: Site not found or sites hosting is disabled.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, { params }: RouteContext) => {
  const routeParams = await params;
  try {
    const service = new SitesService();
    const site = await service.getSite(routeParams.siteId);
    return successResponse({ site }, { status: 200 }, req);
  } catch (error) {
    return sitesErrorResponse(error, req);
  }
};

const deleteHandler = async (req: NextRequest, { params }: RouteContext) => {
  const routeParams = await params;
  try {
    const service = new SitesService();
    const site = await service.deleteSite(routeParams.siteId);
    return successResponse({ site }, { status: 200 }, req);
  } catch (error) {
    return sitesErrorResponse(error, req);
  }
};

export const GET = createApiHandler(getHandler);
export const DELETE = createApiHandler(deleteHandler);
