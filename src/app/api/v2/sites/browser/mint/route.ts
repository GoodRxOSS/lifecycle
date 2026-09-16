import { NextResponse } from 'next/server';
import { createPrincipalApiHandler } from 'server/lib/createApiHandler';
import {
  getSitesBrowserAuth,
  readSitesMintBody,
  assertPrivateSitesReady,
  SitesBrowserError,
} from 'server/lib/sites/browserAuth';
import { assertSitesPrincipal } from 'server/lib/sites/policy';
import SitesService from 'server/services/sites';

/**
 * @openapi
 * /api/v2/sites/browser/mint:
 *   post:
 *     operationId: mintSitesBrowserTicket
 *     summary: Mint a private-site browser bootstrap ticket
 *     description: Requires a live owner user JWT and a matching gateway challenge. Lifecycle API keys and browser cookies are not accepted. Returns a single-use ticket valid for at most 60 seconds for POST consumption at the supplied content-host URL. The resulting Site-only grant expires at the earlier of JWT expiry and 300 seconds after mint. Renewal requires another authenticated mint.
 *     tags: [Sites]
 *     security:
 *       - BearerAuth: []
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
 *         description: Invalid request body.
 *       '401':
 *         description: Missing, invalid or expired credentials or gateway challenge.
 *       '403':
 *         description: The authenticated principal is not permitted to use this operation.
 *       '404':
 *         description: Site is unavailable to this owner.
 *       '413':
 *         description: Request body exceeds 4096 bytes.
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
  const body = await readSitesMintBody(request);
  const auth = getSitesBrowserAuth();
  if (!principal.issuer || !principal.userId || !principal.oauth) throw new SitesBrowserError(401);
  await auth.rateLimit(`mint:${principal.issuer}:${principal.userId}`);
  const challenge = await auth.readChallenge(body.state);
  const { site } = await new SitesService().getGatewaySite(challenge.host);
  const result = await auth.mint(
    site,
    { issuer: principal.issuer, subject: principal.userId },
    body,
    principal.oauth.expiresAt
  );
  return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } });
});
