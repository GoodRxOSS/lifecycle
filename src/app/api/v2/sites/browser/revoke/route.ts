import { NextResponse } from 'next/server';
import { createPublicApiHandler } from 'server/lib/createApiHandler';
import { getSitesBrowserAuth, readSitesBridgeBody } from 'server/lib/sites/browserAuth';

// This exact route uses the dedicated server-to-server signature, including when the
// user's OAuth token has expired. It never accepts arbitrary x-user or browser cookies.
/**
 * @openapi
 * /api/v2/sites/browser/revoke:
 *   post:
 *     operationId: revokeSitesBrowserLogin
 *     summary: Revoke a UI application login
 *     description: Internal server-to-server logout operation for the Lifecycle UI. Requires the signed revoke request header only; no OAuth bearer or browser cookie is required, so logout remains available after OAuth expiry. Revokes the application login and its Sites access without ending the separate identity-provider SSO session. A Lifecycle API key cannot authorize this operation.
 *     tags: [Sites]
 *     security:
 *       - SitesBrowserBridge: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SitesBrowserLoginRequest'
 *     responses:
 *       '200':
 *         description: Operation completed. Response must not be cached.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: object
 *                   required: [revoked]
 *                   properties:
 *                     revoked:
 *                       type: boolean
 *                       enum: [true]
 *       '400':
 *         description: Invalid signed request body.
 *       '401':
 *         description: Missing, invalid, expired, or replayed credentials, or an invalid application login.
 *       '413':
 *         description: Signed request body exceeds 4096 bytes.
 *       '500':
 *         description: Unexpected server or storage dependency failure; completion could not be confirmed.
 *       '503':
 *         description: Required authorization or storage dependency is unavailable; no access is granted.
 */
export const POST = createPublicApiHandler(async (request) => {
  const raw = await readSitesBridgeBody(request);
  const auth = getSitesBrowserAuth();
  const body = await auth.verifyBridge('revoke', raw, request.headers.get('x-lfc-sites-bridge'));
  await auth.revoke(body);
  return NextResponse.json({ data: { revoked: true } }, { headers: { 'Cache-Control': 'no-store' } });
});
