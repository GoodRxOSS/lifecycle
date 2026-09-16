import { NextResponse } from 'next/server';
import { createPublicApiHandler } from 'server/lib/createApiHandler';
import SitesService from 'server/services/sites';

// URL resolution only, never a list or a private metadata projection.
/**
 * @openapi
 * /api/v2/sites/browser/open/{siteId}:
 *   get:
 *     operationId: resolvePublicSiteBrowserUrl
 *     summary: Resolve a public site's current content URL
 *     description: Anonymous stable-link resolution. Returns only the current public content URL; private, deleted, and unknown sites receive the same not-found response without private metadata.
 *     tags: [Sites]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: siteId
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^[a-z0-9-]{1,64}$'
 *     responses:
 *       '200':
 *         description: Public content URL. Response must not be cached.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: object
 *                   required: [url]
 *                   properties:
 *                     url:
 *                       type: string
 *                       format: uri
 *       '404':
 *         description: Site not found or not public. Response must not be cached.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [error]
 *               properties:
 *                 error:
 *                   type: object
 *                   required: [message]
 *                   properties:
 *                     message:
 *                       type: string
 *                       enum: ['Site not found.']
 *       '500':
 *         description: Unexpected server or storage dependency failure.
 *       '503':
 *         description: Required dependency is unavailable.
 */
export const GET = createPublicApiHandler(async (_request, context: { params: Promise<{ siteId: string }> }) => {
  const { siteId } = await context.params;
  const headers = { 'Cache-Control': 'no-store' };
  if (!/^[a-z0-9-]{1,64}$/.test(siteId))
    return NextResponse.json({ error: { message: 'Site not found.' } }, { status: 404, headers });
  const url = await new SitesService().resolvePublicSiteUrl(siteId);
  return url
    ? NextResponse.json({ data: { url } }, { headers })
    : NextResponse.json({ error: { message: 'Site not found.' } }, { status: 404, headers });
});
