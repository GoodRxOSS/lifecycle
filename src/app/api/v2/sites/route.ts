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
import { createPrincipalApiHandler } from 'server/lib/createApiHandler';
import type { Principal } from 'server/lib/principal';
import { sitesSuccessResponse as successResponse } from 'server/lib/sites/routeHelpers';
import { readSitesListFilters, readUploadFile, sitesErrorResponse } from 'server/lib/sites/routeHelpers';
import { SitesServiceError } from 'server/services/sites';
import SitesService from 'server/services/sites';

export const runtime = 'nodejs';

/**
 * @openapi
 * /api/v2/sites:
 *   get:
 *     summary: List hosted static sites
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: Returns only authorized hosted sites; private metadata is visible only to its owner.
 *     tags:
 *       - Sites
 *     operationId: listSites
 *     parameters:
 *       - name: view
 *         in: query
 *         schema: { type: string, enum: [mine, public, all] }
 *       - name: q
 *         in: query
 *         schema: { type: string, maxLength: 200 }
 *       - name: page
 *         in: query
 *         required: false
 *         description: Page number for pagination.
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *       - name: limit
 *         in: query
 *         required: false
 *         description: Number of sites per page.
 *         schema:
 *           type: integer
 *           default: 25
 *           minimum: 1
 *           maximum: 100
 *     responses:
 *       '200':
 *         description: Hosted static sites.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SitesListSuccessResponse'
 *       '404':
 *         description: Sites hosting is disabled.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   post:
 *     summary: Create a hosted static site
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: Uploads a static file or ZIP archive and publishes it as a hosted static site.
 *     tags:
 *       - Sites
 *     operationId: createSite
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             $ref: '#/components/schemas/SiteUploadRequest'
 *     responses:
 *       '201':
 *         description: Hosted static site created.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SiteSuccessResponse'
 *       '400':
 *         description: Invalid upload.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '404':
 *         description: Sites hosting is disabled.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const getHandler = async (req: NextRequest, principal: Principal) => {
  try {
    const service = new SitesService();
    const result = await service.listSites(readSitesListFilters(req.nextUrl.searchParams), principal);
    return successResponse({ sites: result.sites }, { status: 200, metadata: { pagination: result.pagination } }, req);
  } catch (error) {
    return sitesErrorResponse(error, req);
  }
};

const postHandler = async (req: NextRequest, principal: Principal) => {
  try {
    const service = new SitesService();
    const capabilities = await service.getCapabilities(principal);
    if (!capabilities.canCreate) throw new SitesServiceError('Site creation is unavailable for this credential.', 403);
    const upload = await readUploadFile(req, capabilities.upload.maxUploadBytes);
    const site = await service.createSite({
      ...upload,
      principal,
    });
    return successResponse({ site }, { status: 201 }, req);
  } catch (error) {
    return sitesErrorResponse(error, req);
  }
};

export const GET = createPrincipalApiHandler({ scope: 'sites:read' }, getHandler);
export const POST = createPrincipalApiHandler({ scope: 'sites:write' }, postHandler);
