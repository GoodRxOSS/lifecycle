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
import { readSiteRevision, sitesErrorResponse } from 'server/lib/sites/routeHelpers';
import SitesService, { SitesServiceError } from 'server/services/sites';

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
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
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
 *   patch:
 *     summary: Rename a hosted static site
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: Changes the display name only; the Site ID and content URL stay the same.
 *     tags:
 *       - Sites
 *     operationId: renameSite
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             properties:
 *               name: { type: string, minLength: 1, maxLength: 255 }
 *               expectedAccessRevision: { type: integer, minimum: 1, maximum: 2147483647 }
 *             required: [name]
 *     responses:
 *       '200':
 *         description: Hosted static site renamed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SiteSuccessResponse'
 *       '400':
 *         description: Invalid JSON, name, or revision.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       '403':
 *         description: Only the site owner can rename it.
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
 *       '409':
 *         description: Access revision changed; refetch before retrying.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   delete:
 *     summary: Delete a hosted static site
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     tags:
 *       - Sites
 *     operationId: deleteSite
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: expectedAccessRevision
 *         required: false
 *         schema: { type: integer, minimum: 1, maximum: 2147483647 }
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
const getHandler = async (req: NextRequest, principal: Principal, { params }: RouteContext) => {
  const routeParams = await params;
  try {
    const service = new SitesService();
    const site = await service.getSite(routeParams.siteId, principal);
    return successResponse({ site }, { status: 200 }, req);
  } catch (error) {
    return sitesErrorResponse(error, req);
  }
};

const patchHandler = async (req: NextRequest, principal: Principal, { params }: RouteContext) => {
  const routeParams = await params;
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new SitesServiceError('Invalid JSON.', 400);
    }
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !['name', 'expectedAccessRevision'].includes(key))
    ) {
      throw new SitesServiceError('Invalid rename request.', 400);
    }
    const input = body as Record<string, unknown>;
    if (typeof input.name !== 'string') throw new SitesServiceError('name is required.', 400);
    const site = await new SitesService().renameSite(
      routeParams.siteId,
      input.name,
      principal,
      readSiteRevision(input.expectedAccessRevision)
    );
    return successResponse({ site }, { status: 200 }, req);
  } catch (error) {
    return sitesErrorResponse(error, req);
  }
};

const deleteHandler = async (req: NextRequest, principal: Principal, { params }: RouteContext) => {
  const routeParams = await params;
  try {
    const service = new SitesService();
    const site = await service.deleteSite(
      routeParams.siteId,
      principal,
      readSiteRevision(req.nextUrl.searchParams.get('expectedAccessRevision'))
    );
    return successResponse({ site }, { status: 200 }, req);
  } catch (error) {
    return sitesErrorResponse(error, req);
  }
};

export const GET = createPrincipalApiHandler({ scope: 'sites:read' }, getHandler);
export const PATCH = createPrincipalApiHandler({ scope: 'sites:write' }, patchHandler);
export const DELETE = createPrincipalApiHandler({ scope: 'sites:write' }, deleteHandler);
