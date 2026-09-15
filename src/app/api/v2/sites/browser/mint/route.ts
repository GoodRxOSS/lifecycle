import { NextResponse } from 'next/server';
import { createPrincipalApiHandler } from 'server/lib/createApiHandler';
import { getUser } from 'server/lib/get-user';
import { getVerifiedOAuthBearer } from 'server/lib/verifiedOAuthBearer';
import {
  getSitesBrowserAuth,
  readSitesBridgeBody,
  assertPrivateSitesReady,
  SitesBrowserError,
} from 'server/lib/sites/browserAuth';
import { assertSitesPrincipal } from 'server/lib/sites/policy';
import SitesService from 'server/services/sites';

/**
 * @openapi
 * /api/v2/sites/browser/mint:
 *   post:
 *     operationId: mintSitesBrowserLogin
 *     summary: Mint a private-site browser bootstrap ticket
 *     description: Internal server-to-server operation for the Lifecycle UI. Requires a live owner OAuth bearer AND the signed mint request header, an existing bound application login, and a matching gateway challenge. Lifecycle API keys and browser cookies are not accepted. Returns a single-use ticket valid for at most 60 seconds for POST consumption at the supplied content-host URL; it is not an OAuth token.
 *     tags: [Sites]
 *     security:
 *       - BearerAuth: []
 *         SitesBrowserBridge: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SitesBrowserMintRequest'
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
 *                   required: [ticket, consumeUrl]
 *                   properties:
 *                     ticket:
 *                       type: string
 *                     consumeUrl:
 *                       type: string
 *                       format: uri
 *       '400':
 *         description: Invalid signed request body.
 *       '401':
 *         description: Missing, invalid, expired, or replayed credentials, or an invalid application login.
 *       '403':
 *         description: The authenticated principal is not permitted to use this operation.
 *       '404':
 *         description: Site is unavailable to this owner.
 *       '413':
 *         description: Signed request body exceeds 4096 bytes.
 *       '500':
 *         description: Unexpected server or storage dependency failure; completion could not be confirmed.
 *       '503':
 *         description: Required authorization or storage dependency is unavailable; no access is granted.
 *       '429':
 *         description: Browser ticket mint rate limit exceeded.
 */
export const POST = createPrincipalApiHandler({ scope: 'sites:read', kinds: ['user'] }, async (request, principal) => {
  assertPrivateSitesReady();
  await assertSitesPrincipal(principal);
  const raw = await readSitesBridgeBody(request);
  const auth = getSitesBrowserAuth();
  const body = await auth.verifyBridge('mint', raw, request.headers.get('x-lfc-sites-bridge'));
  const challenge = await auth.readChallenge(body.state || '');
  const { site } = await new SitesService().getGatewaySite(challenge.host);
  const bearer = getVerifiedOAuthBearer(principal);
  if (!principal.issuer || !principal.userId || !bearer) throw new SitesBrowserError(401);
  await auth.rateLimit(`mint:${principal.issuer}:${principal.userId}`);
  const result = await auth.mint(
    site,
    { issuer: principal.issuer, subject: principal.userId, oauth: principal.oauth },
    body,
    Number(getUser(request)?.exp),
    bearer
  );
  return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } });
});
