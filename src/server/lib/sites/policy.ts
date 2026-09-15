/** Sites ownership is independent of realm administration and display attribution. */
import type { Transaction } from 'objection';
import ApiToken from 'server/models/ApiToken';
import GlobalConfigService from 'server/services/globalConfig';
import type Site from 'server/models/Site';
import type { Principal } from 'server/lib/principal';
import { AppError } from 'server/lib/appError';
import { scopeSatisfies } from 'server/lib/apiTokenScopes';
import { getUserStatus, getOAuthTokenStatus } from 'server/services/keycloak/principalStatus';
import { getSitesBrowserAuth } from './browserAuth';
import { getVerifiedOAuthBearer } from 'server/lib/verifiedOAuthBearer';

export function hasSitesScope(principal: Principal, operation: 'read' | 'write'): boolean {
  return principal.scopes === null || scopeSatisfies(principal.scopes, `sites:${operation}`);
}

export async function assertSitesPrincipal(
  principal: Principal | null | undefined,
  operation: 'read' | 'write' = 'read',
  trx?: Transaction
): Promise<void> {
  if (process.env.ENABLE_AUTH !== 'true' || !principal) {
    throw new AppError({
      httpStatus: 401,
      code: 'authentication_required',
      message: 'Sites management requires authentication.',
    });
  }
  if (!hasSitesScope(principal, operation)) {
    throw new AppError({
      httpStatus: 403,
      code: 'insufficient_scope',
      message: `The credential requires sites:${operation}.`,
    });
  }
  if (principal.kind !== 'user') {
    const tokenQuery = principal.tokenId ? ApiToken.query(trx).findById(principal.tokenId) : undefined;
    if (trx) tokenQuery?.forShare();
    const token = await tokenQuery;
    const config = (await GlobalConfigService.getInstance().getConfig('api_keys')) as
      | { personalAuthEnabled?: boolean; serviceAuthEnabled?: boolean }
      | undefined;
    const personal = principal.kind === 'personal_key';
    if (
      !token ||
      token.revokedAt ||
      (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) ||
      token.kind !== (personal ? 'personal' : 'service') ||
      !(personal ? config?.personalAuthEnabled : config?.serviceAuthEnabled) ||
      (personal && (token.ownerUserId !== principal.userId || token.ownerIssuer !== principal.issuer)) ||
      !hasSitesScope({ ...principal, scopes: token.scopes }, operation)
    ) {
      throw new AppError({
        httpStatus: 401,
        code: 'invalid_credential',
        message: 'The API key is no longer valid for this operation.',
      });
    }
  }
  if (principal.kind === 'service_key') {
    if (!Number.isSafeInteger(principal.tokenId) || Number(principal.tokenId) <= 0) {
      throw new AppError({ httpStatus: 401, code: 'invalid_credential', message: 'A valid service key is required.' });
    }
    return;
  }
  const issuer = process.env.KEYCLOAK_ISSUER?.trim();
  if (!issuer || !principal.issuer || principal.issuer !== issuer || !principal.userId) {
    throw new AppError({
      httpStatus: 401,
      code: 'invalid_credential',
      message: 'A verified identity from the configured issuer is required.',
    });
  }
  if (principal.kind === 'user') {
    const oauth = principal.oauth;
    if (!oauth || oauth.expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new AppError({ httpStatus: 401, code: 'invalid_credential', message: 'A live OAuth session is required.' });
    }
    const bearer = getVerifiedOAuthBearer(principal);
    const session =
      principal.authMethod === 'sites_viewer'
        ? await getSitesBrowserAuth().getViewerOAuthTokenStatus({
            issuer: principal.issuer,
            subject: principal.userId,
            oauth,
          })
        : bearer
        ? await getOAuthTokenStatus(bearer)
        : 'revoked';
    if (session !== 'active') {
      throw new AppError({
        httpStatus: session === 'unknown' ? 503 : 401,
        code: 'oauth_session_unavailable',
        message: 'The OAuth session cannot currently access Sites.',
        retryable: session === 'unknown',
      });
    }
    await getSitesBrowserAuth().assertOAuthLogin({ issuer: principal.issuer, subject: principal.userId, oauth });
  }
  const status = await getUserStatus(principal.userId);
  if (status !== 'active') {
    throw new AppError({
      httpStatus: status === 'unknown' ? 503 : 403,
      code: 'principal_unavailable',
      message: 'The account cannot currently access Sites.',
      retryable: status === 'unknown',
    });
  }
}

export function isSiteOwner(site: Site, principal: Principal | null | undefined): boolean {
  if (!principal) return false;
  if (site.ownerKind === 'service_key') {
    return principal.kind === 'service_key' && site.creatorTokenId != null && site.creatorTokenId === principal.tokenId;
  }
  return (
    site.ownerKind === 'user' &&
    principal.kind !== 'service_key' &&
    Boolean(site.ownerIssuer && site.ownerSubject) &&
    site.ownerIssuer === principal.issuer &&
    site.ownerSubject === principal.userId
  );
}

export function assertSiteOwner(site: Site, principal: Principal): void {
  if (!isSiteOwner(site, principal)) {
    // Same response for missing and inaccessible private resources.
    throw new AppError({ httpStatus: 404, code: 'site_not_found', message: 'Site not found.' });
  }
}
