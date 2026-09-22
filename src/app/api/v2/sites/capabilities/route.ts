import { NextRequest } from 'next/server';
import { createPrincipalApiHandler } from 'server/lib/createApiHandler';
import type { Principal } from 'server/lib/principal';
import { sitesSuccessResponse as successResponse } from 'server/lib/sites/routeHelpers';
import { sitesErrorResponse } from 'server/lib/sites/routeHelpers';
import SitesService from 'server/services/sites';

/**
 * @openapi
 * /api/v2/sites/capabilities:
 *   get:
 *     summary: Get sanitized Sites upload capabilities
 *     operationId: getSitesCapabilities
 *     tags: [Sites]
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     responses:
 *       '200':
 *         description: Capabilities for the authenticated principal; no storage credentials or endpoints.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SitesCapabilitiesSuccessResponse'
 */
export const GET = createPrincipalApiHandler(
  { scope: 'sites:read' },
  async (req: NextRequest, principal: Principal) => {
    try {
      return successResponse(await new SitesService().getCapabilities(principal), { status: 200 }, req);
    } catch (error) {
      return sitesErrorResponse(error, req);
    }
  }
);
