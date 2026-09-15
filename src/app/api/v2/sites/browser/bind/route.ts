import { NextResponse } from 'next/server';
import { createPrincipalApiHandler } from 'server/lib/createApiHandler';
import { getSitesBrowserAuth, readSitesBridgeBody, SitesBrowserError } from 'server/lib/sites/browserAuth';

// The normal middleware verifies this bearer. Binding requires the UI's signed
// server-to-server envelope as well, and cannot revive a revoked application login.
/**
 * @openapi
 * /api/v2/sites/browser/bind:
 *   post:
 *     operationId: bindSitesBrowserLogin
 *     summary: Bind a UI OAuth token to an application login
 *     description: Internal server-to-server operation for the Lifecycle UI. Requires a verified user OAuth bearer from the configured UI client AND the signed bind request header. Lifecycle API keys and browser cookies are not accepted. Explicit sign-in creates a fresh application login; refresh must match an existing unrevoked login. Binding does not revoke or create an identity-provider SSO session.
 *     tags: [Sites]
 *     security:
 *       - BearerAuth: []
 *         SitesBrowserBridge: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SitesBrowserBindRequest'
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
 *                   required: [bound]
 *                   properties:
 *                     bound:
 *                       type: boolean
 *                       enum: [true]
 *       '400':
 *         description: Invalid signed request body.
 *       '401':
 *         description: Missing, invalid, expired, or replayed credentials, or an invalid application login.
 *       '403':
 *         description: The authenticated principal is not permitted to use this operation.
 *       '413':
 *         description: Signed request body exceeds 4096 bytes.
 *       '500':
 *         description: Unexpected server or storage dependency failure; completion could not be confirmed.
 *       '503':
 *         description: Required authorization or storage dependency is unavailable; no access is granted.
 */
export const POST = createPrincipalApiHandler({ scope: 'sites:read', kinds: ['user'] }, async (request, principal) => {
  if (!principal.issuer || !principal.userId || !principal.oauth) throw new SitesBrowserError(401);
  const auth = getSitesBrowserAuth();
  const raw = await readSitesBridgeBody(request);
  const body = await auth.verifyBridge('bind', raw, request.headers.get('x-lfc-sites-bridge'));
  await auth.bind({ issuer: principal.issuer, subject: principal.userId, oauth: principal.oauth }, body);
  return NextResponse.json({ data: { bound: true } }, { headers: { 'Cache-Control': 'no-store' } });
});
