import { NextRequest } from 'next/server';
import { createPrincipalApiHandler } from 'server/lib/createApiHandler';
import type { Principal } from 'server/lib/principal';
import { sitesSuccessResponse as successResponse } from 'server/lib/sites/routeHelpers';
import { readSiteRevision, readSiteVisibility, sitesErrorResponse } from 'server/lib/sites/routeHelpers';
import SitesService, { SitesServiceError } from 'server/services/sites';

/**
 * @openapi
 * /api/v2/sites/{siteId}/access:
 *   patch:
 *     summary: Change Site visibility
 *     operationId: setSiteVisibility
 *     tags: [Sites]
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             properties:
 *               visibility: { type: string, enum: [private, public] }
 *               expectedAccessRevision: { type: integer, minimum: 1, maximum: 2147483647 }
 *             required: [visibility, expectedAccessRevision]
 *     responses:
 *       '200':
 *         description: Visibility changed; private transition retires the previous content URL.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SiteSuccessResponse'
 *       '409':
 *         description: Access revision changed; refetch before retrying.
 */
export const PATCH = createPrincipalApiHandler(
  { scope: 'sites:write' },
  async (req: NextRequest, principal: Principal, { params }: { params: Promise<{ siteId: string }> }) => {
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
        Object.keys(body).some((key) => !['visibility', 'expectedAccessRevision'].includes(key))
      ) {
        throw new SitesServiceError('Invalid access request.', 400);
      }
      const input = body as Record<string, unknown>;
      const visibility = readSiteVisibility(input.visibility);
      const revision = readSiteRevision(input.expectedAccessRevision, true)!;
      const site = await new SitesService().setVisibility((await params).siteId, visibility, principal, revision);
      return successResponse({ site }, { status: 200 }, req);
    } catch (error) {
      return sitesErrorResponse(error, req);
    }
  }
);
