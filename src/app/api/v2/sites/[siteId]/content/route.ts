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
  params: Promise<{
    siteId: string;
  }>;
};

/**
 * @openapi
 * /api/v2/sites/{siteId}/content:
 *   put:
 *     summary: Replace hosted static site content
 *     description: Uploads a new static file or ZIP archive and makes it the active content for the site.
 *     tags:
 *       - Sites
 *     operationId: replaceSiteContent
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             $ref: '#/components/schemas/SiteUploadRequest'
 *     responses:
 *       '200':
 *         description: Hosted static site content replaced.
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
 *         description: Site not found or sites hosting is disabled.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
const putHandler = async (req: NextRequest, { params }: RouteContext) => {
  const routeParams = await params;
  try {
    const upload = await readUploadFile(req);
    const service = new SitesService();
    const site = await service.replaceSiteContent(routeParams.siteId, {
      ...upload,
      user: getRequestUserIdentity(req),
    });
    return successResponse({ site }, { status: 200 }, req);
  } catch (error) {
    return sitesErrorResponse(error, req);
  }
};

export const PUT = createApiHandler(putHandler);
