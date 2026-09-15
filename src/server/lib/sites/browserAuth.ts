import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto';
import * as psl from 'psl';
import type Redis from 'ioredis';
import RedisClient from 'server/lib/redisClient';
import { AppError } from 'server/lib/appError';
import type { OAuthCredential } from 'server/lib/get-user';
import { getOAuthTokenStatus } from 'server/services/keycloak/principalStatus';

export const SITES_AUTH_PATH = '/_lfc-sites/';
export const SITES_VIEWER_COOKIE = '__Host-lfc-sites-viewer';
export const MAX_LOGIN_SECONDS = 30 * 24 * 60 * 60;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PREFIX = 'sites:browser:v1:';
const CONSUME = `-- sites-consume
local value = redis.call('GET', KEYS[1])
if value then redis.call('DEL', KEYS[1]) end
return value`;
const LOGIN = `-- sites-login
local existing = redis.call('GET', KEYS[1])
if ARGV[3] == 'existing' and not existing then return 0 end
if existing and existing ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1`;
const LIMIT = `-- sites-limit
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 60) end
return count`;

export class SitesBrowserError extends AppError {
  constructor(public statusCode: number, message = 'Site access is unavailable.') {
    super({ httpStatus: statusCode, code: 'sites_browser_unavailable', message });
  }
}
export type BrowserActor = { issuer: string; subject: string; oauth?: OAuthCredential };
export type BrowserSite = {
  siteId: string;
  ownerKind: string;
  ownerIssuer?: string | null;
  ownerSubject?: string | null;
  visibility: string;
  servingGeneration?: string | null;
  accessRevision: number;
};
type Challenge = { siteId: string; host: string; generation: string | null; secretHash: string; path: string };
export type Viewer = BrowserActor & {
  siteId: string;
  host: string;
  generation: string | null;
  accessRevision: number;
  loginId: string;
  loginExpiresAt: number;
  expiresAt: number;
};
type Ticket = Viewer & { challengeId: string; challenge: Challenge };
type OAuthLogin = { issuer: string; subject: string; loginId: string; loginExpiresAt: number };
type ViewerBearerRecord = { version: 1; expiresAt: number; iv: string; tag: string; ciphertext: string };
const VIEWER_BEARER_PURPOSE = 'sites-viewer-bearer:v1';

export type BridgeBody = {
  loginId: string;
  loginExpiresAt: number;
  /** True only for an explicit OAuth sign-in; refresh must find its existing login. */
  createLogin?: boolean;
  state?: string;
  siteId?: string;
};
export const randomSiteToken = () => randomBytes(32).toString('base64url');
export const siteTokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
const nowSeconds = () => Math.floor(Date.now() / 1000);

export function sitesUiOrigin(): string {
  const raw = process.env.SITES_UI_ORIGIN;
  try {
    const url = new URL(raw || '');
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== raw) throw new Error();
    return url.origin;
  } catch {
    throw new SitesBrowserError(503);
  }
}
function bridgeSecret(): string {
  const secret = process.env.SITES_BROWSER_BRIDGE_SECRET || '';
  if (Buffer.byteLength(secret) < 32) throw new SitesBrowserError(503);
  return secret;
}
export function assertPrivateSitesReady(contentUrl?: string): void {
  if (process.env.ENABLE_AUTH !== 'true' || process.env.SITES_PRIVATE_ENABLED !== 'true')
    throw new SitesBrowserError(503);
  const ui = new URL(sitesUiOrigin());
  bridgeSecret();
  if (contentUrl) {
    const content = new URL(contentUrl);
    const uiDomain = psl.get(ui.hostname);
    const contentDomain = psl.get(content.hostname);
    if (content.protocol !== 'https:' || !uiDomain || !contentDomain || uiDomain === contentDomain)
      throw new SitesBrowserError(503);
  }
}
export function safeSiteReturnPath(path: string): string {
  if (path.length > 2048 || !path.startsWith('/') || path.startsWith('//') || /[\\\r\n\0]/.test(path))
    throw new SitesBrowserError(400);
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.split('?')[0]);
  } catch {
    throw new SitesBrowserError(400);
  }
  if (
    /[\\\r\n\0]/.test(decoded) ||
    decoded.startsWith('//') ||
    decoded.split('/').some((part) => part === '.' || part === '..') ||
    decoded.startsWith(SITES_AUTH_PATH)
  )
    throw new SitesBrowserError(400);
  return path;
}
export function challengeCookieName(state: string): string {
  if (!TOKEN.test(state)) throw new SitesBrowserError(400);
  return `__Host-lfc-sites-challenge-${state}`;
}
export function parseSitesCookies(raw?: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const part of (raw || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name in result) {
      result[name] = '';
      continue;
    }
    result[name] = part.slice(index + 1).trim();
  }
  return result;
}
export function assertViewerOwns(site: BrowserSite, actor: BrowserActor): void {
  assertPrivateSitesReady();
  if (site.ownerKind !== 'user' || site.ownerIssuer !== actor.issuer || site.ownerSubject !== actor.subject)
    throw new SitesBrowserError(404);
}

export async function readSitesBridgeBody(request: {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}): Promise<string> {
  const limit = 4096;
  if (Number(request.headers.get('content-length') || 0) > limit) throw new SitesBrowserError(413);
  if (!request.body) throw new SitesBrowserError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) throw new SitesBrowserError(413);
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class SitesBrowserAuth {
  constructor(private readonly redis: Pick<Redis, 'get' | 'set' | 'eval'>) {}
  private key(kind: string, value: string) {
    return `${PREFIX}${kind}:${siteTokenHash(value)}`;
  }
  async rateLimit(identity: string, maximum = 60): Promise<void> {
    if (Number(await this.redis.eval(LIMIT, 1, this.key('rate', identity))) > maximum) throw new SitesBrowserError(429);
  }
  async verifyBridge(action: 'mint' | 'revoke' | 'bind', rawBody: string, header: string | null): Promise<BridgeBody> {
    // Revocation must still work after private creation is disabled or a user's OAuth token expires.
    const parts = (header || '').split('.');
    if (
      parts.length !== 3 ||
      !/^\d+$/.test(parts[0]) ||
      !TOKEN.test(parts[1]) ||
      !/^[a-f0-9]{64}$/.test(parts[2]) ||
      Math.abs(nowSeconds() - Number(parts[0])) > 30
    )
      throw new SitesBrowserError(401);
    const expected = createHmac('sha256', bridgeSecret())
      .update(`sites-v1\n${action}\n${parts[0]}\n${parts[1]}\n${siteTokenHash(rawBody)}`)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(parts[2], 'hex'))) throw new SitesBrowserError(401);
    if ((await this.redis.set(this.key('bridge', parts[1]), 'used', 'EX', 65, 'NX')) !== 'OK')
      throw new SitesBrowserError(401);
    let body: BridgeBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new SitesBrowserError(400);
    }
    if (
      !body ||
      !TOKEN.test(body.loginId) ||
      !Number.isSafeInteger(body.loginExpiresAt) ||
      body.loginExpiresAt > nowSeconds() + MAX_LOGIN_SECONDS + 60 ||
      (body.createLogin !== undefined && typeof body.createLogin !== 'boolean')
    )
      throw new SitesBrowserError(400);
    return body;
  }
  private oauthTokenKey(actor: BrowserActor): string {
    return this.key('oauth', `${actor.issuer}\0${actor.oauth!.tokenId}`);
  }
  private loginValue(actor: BrowserActor, expiresAt: number): string {
    return JSON.stringify({ issuer: actor.issuer, subject: actor.subject, expiresAt });
  }
  /** Register only the exact verified access token; never revoke an entire SSO session. */
  async bind(actor: BrowserActor, body: BridgeBody): Promise<void> {
    const clientId = process.env.SITES_UI_OAUTH_CLIENT_ID?.trim();
    if (!clientId) throw new SitesBrowserError(503);
    if (
      actor.issuer !== process.env.KEYCLOAK_ISSUER?.trim() ||
      !actor.subject ||
      !actor.oauth ||
      actor.oauth.clientId !== clientId ||
      actor.oauth.expiresAt <= nowSeconds() ||
      body.loginExpiresAt <= nowSeconds()
    )
      throw new SitesBrowserError(401);
    const loginValue = this.loginValue(actor, body.loginExpiresAt);
    if (
      Number(
        await this.redis.eval(
          LOGIN,
          1,
          this.key('login', body.loginId),
          loginValue,
          body.loginExpiresAt - nowSeconds(),
          body.createLogin === true ? 'create' : 'existing'
        )
      ) !== 1
    )
      throw new SitesBrowserError(401);
    const value = JSON.stringify({
      issuer: actor.issuer,
      subject: actor.subject,
      loginId: body.loginId,
      loginExpiresAt: body.loginExpiresAt,
    });
    // An already-issued token cannot migrate into a fresh login and escape its logout.
    const key = this.oauthTokenKey(actor);
    if (Number(await this.redis.eval(LOGIN, 1, key, value, actor.oauth.expiresAt - nowSeconds() + 60)) !== 1)
      throw new SitesBrowserError(401);
    await this.assertOAuthLogin(actor);
  }
  /** All UI-client tokens require a registration, including pre-upgrade tokens. */
  async assertOAuthLogin(actor: BrowserActor): Promise<OAuthLogin | undefined> {
    const clientId = process.env.SITES_UI_OAUTH_CLIENT_ID?.trim();
    if (!clientId) throw new SitesBrowserError(503);
    if (!actor.oauth || actor.oauth.expiresAt <= nowSeconds()) throw new SitesBrowserError(401);
    try {
      const raw = await this.redis.get(this.oauthTokenKey(actor));
      if (!raw) {
        if (actor.oauth.clientId === clientId) throw new SitesBrowserError(401);
        return;
      }
      const bound = JSON.parse(raw) as OAuthLogin;
      if (bound.issuer !== actor.issuer || bound.subject !== actor.subject || bound.loginExpiresAt <= nowSeconds())
        throw new SitesBrowserError(401);
      const expected = this.loginValue(actor, bound.loginExpiresAt);
      if ((await this.redis.get(this.key('login', bound.loginId))) !== expected) throw new SitesBrowserError(401);
      return bound;
    } catch (error) {
      if (error instanceof SitesBrowserError) throw error;
      throw new SitesBrowserError(503);
    }
  }
  private viewerBearerKey(actor: BrowserActor, login: OAuthLogin): string {
    return this.key('viewer-bearer', JSON.stringify([actor.issuer, actor.oauth!.tokenId, login.loginId]));
  }
  private viewerBearerAad(actor: BrowserActor, login: OAuthLogin, expiresAt: number): Buffer {
    const oauth = actor.oauth!;
    return Buffer.from(
      JSON.stringify([
        VIEWER_BEARER_PURPOSE,
        actor.issuer,
        actor.subject,
        oauth.sessionId,
        oauth.tokenId,
        oauth.clientId,
        oauth.expiresAt,
        login.loginId,
        login.loginExpiresAt,
        expiresAt,
      ])
    );
  }
  private viewerBearerEncryptionKey(): Buffer {
    return createHmac('sha256', bridgeSecret()).update(`${VIEWER_BEARER_PURPOSE}:encryption`).digest();
  }
  private decryptViewerBearer(
    raw: string,
    actor: BrowserActor,
    login: OAuthLogin
  ): { bearer: string; expiresAt: number } {
    if (raw.length > 24576) throw new SitesBrowserError(503);
    const record = JSON.parse(raw) as ViewerBearerRecord;
    if (
      record.version !== 1 ||
      !Number.isSafeInteger(record.expiresAt) ||
      record.expiresAt <= nowSeconds() ||
      record.expiresAt > Math.min(actor.oauth!.expiresAt, login.loginExpiresAt, nowSeconds() + 900)
    )
      throw new SitesBrowserError(401);
    const iv = Buffer.from(record.iv, 'base64url');
    const tag = Buffer.from(record.tag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new SitesBrowserError(503);
    const decipher = createDecipheriv('aes-256-gcm', this.viewerBearerEncryptionKey(), iv);
    decipher.setAAD(this.viewerBearerAad(actor, login, record.expiresAt));
    decipher.setAuthTag(tag);
    const bearer = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    if (!bearer || Buffer.byteLength(bearer) > 16384) throw new SitesBrowserError(503);
    return { bearer, expiresAt: record.expiresAt };
  }
  /** Mint-only retention. Randomized ciphertext never enters immutable LOGIN metadata. */
  private async retainViewerBearer(
    actor: BrowserActor,
    login: OAuthLogin,
    bearer: string,
    expiresAt: number
  ): Promise<number> {
    try {
      if (!bearer || Buffer.byteLength(bearer) > 16384) throw new SitesBrowserError(401);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.viewerBearerEncryptionKey(), iv);
      cipher.setAAD(this.viewerBearerAad(actor, login, expiresAt));
      const ciphertext = Buffer.concat([cipher.update(bearer, 'utf8'), cipher.final()]);
      const record: ViewerBearerRecord = {
        version: 1,
        expiresAt,
        iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
      };
      const key = this.viewerBearerKey(actor, login);
      const serialized = JSON.stringify(record);
      // Same-token retries retain the original ciphertext and deadline. A later
      // viewer is capped to that deadline; a refreshed jti gets its own record.
      const inserted = await this.redis.set(key, serialized, 'EX', expiresAt - nowSeconds(), 'NX');
      const saved = inserted === 'OK' ? serialized : await this.redis.get(key);
      if (!saved) throw new SitesBrowserError(401);
      const retained = this.decryptViewerBearer(saved, actor, login);
      if (retained.bearer !== bearer) throw new SitesBrowserError(401);
      return Math.min(expiresAt, retained.expiresAt);
    } catch (error) {
      if (error instanceof SitesBrowserError) throw error;
      throw new SitesBrowserError(503);
    }
  }
  /** Decrypt only inside the authorization operation; callers never receive a bearer. */
  async getViewerOAuthTokenStatus(actor: BrowserActor): Promise<'active' | 'revoked' | 'unknown'> {
    try {
      const login = await this.assertOAuthLogin(actor);
      if (!login) throw new SitesBrowserError(401);
      const raw = await this.redis.get(this.viewerBearerKey(actor, login));
      if (!raw) throw new SitesBrowserError(401);
      const { bearer } = this.decryptViewerBearer(raw, actor, login);
      return await getOAuthTokenStatus(bearer);
    } catch (error) {
      if (error instanceof SitesBrowserError) throw error;
      // Corruption, a lost/rotated bridge key, or unavailable Redis never downgrade
      // to a session-list check. No encryption error/cause or bearer is logged.
      throw new SitesBrowserError(503);
    }
  }
  async challenge(site: Pick<BrowserSite, 'siteId' | 'servingGeneration'>, host: string, path: string) {
    assertPrivateSitesReady(`https://${host}`);
    const state = randomSiteToken();
    const secret = randomSiteToken();
    const challenge: Challenge = {
      siteId: site.siteId,
      host,
      generation: site.servingGeneration ?? null,
      secretHash: siteTokenHash(secret),
      path: safeSiteReturnPath(path),
    };
    await this.redis.set(this.key('challenge', state), JSON.stringify(challenge), 'EX', 300);
    return { state, secret };
  }
  async readChallenge(state: string): Promise<Challenge> {
    if (!TOKEN.test(state)) throw new SitesBrowserError(400);
    const raw = await this.redis.get(this.key('challenge', state));
    if (!raw) throw new SitesBrowserError(401);
    return JSON.parse(raw) as Challenge;
  }
  async mint(
    site: BrowserSite,
    actor: BrowserActor,
    body: BridgeBody,
    tokenExpiresAt: number,
    authorizingBearer: string
  ): Promise<{ ticket: string; consumeUrl: string }> {
    assertViewerOwns(site, actor);
    if (!body.state || body.siteId !== site.siteId || body.loginExpiresAt <= nowSeconds())
      throw new SitesBrowserError(401);
    const challenge = await this.readChallenge(body.state);
    if (challenge.siteId !== site.siteId || challenge.generation !== (site.servingGeneration ?? null))
      throw new SitesBrowserError(401);
    assertPrivateSitesReady(`https://${challenge.host}`);
    const login = await this.assertOAuthLogin(actor);
    if (!login || login.loginId !== body.loginId || login.loginExpiresAt !== body.loginExpiresAt)
      throw new SitesBrowserError(401);
    let expiresAt = Math.min(nowSeconds() + 900, tokenExpiresAt, actor.oauth!.expiresAt, body.loginExpiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds()) throw new SitesBrowserError(401);
    expiresAt = await this.retainViewerBearer(actor, login, authorizingBearer, expiresAt);
    const value: Ticket = {
      ...actor,
      siteId: site.siteId,
      host: challenge.host,
      generation: site.servingGeneration ?? null,
      accessRevision: site.accessRevision,
      loginId: body.loginId,
      loginExpiresAt: body.loginExpiresAt,
      expiresAt,
      challengeId: body.state,
      challenge,
    };
    const ticket = randomSiteToken();
    await this.redis.set(
      this.key('ticket', ticket),
      JSON.stringify(value),
      'EX',
      Math.min(60, expiresAt - nowSeconds())
    );
    return { ticket, consumeUrl: `https://${challenge.host}${SITES_AUTH_PATH}consume` };
  }
  async revoke(body: BridgeBody): Promise<void> {
    // A tombstone also beats concurrent first-time minting; expiry never extends a login.
    await this.redis.set(
      this.key('login', body.loginId),
      'revoked',
      'EX',
      Math.max(1, Math.min(MAX_LOGIN_SECONDS + 60, body.loginExpiresAt - nowSeconds() + 60))
    );
  }
  async assertLogin(viewer: Viewer): Promise<void> {
    if (viewer.expiresAt <= nowSeconds() || viewer.loginExpiresAt <= nowSeconds()) throw new SitesBrowserError(401);
    const expected = JSON.stringify({
      issuer: viewer.issuer,
      subject: viewer.subject,
      expiresAt: viewer.loginExpiresAt,
    });
    if ((await this.redis.get(this.key('login', viewer.loginId))) !== expected) throw new SitesBrowserError(401);
  }
  async consume(
    ticket: string,
    host: string,
    cookies: Record<string, string>,
    origin: string | undefined,
    authorize: (viewer: Viewer) => Promise<void>
  ) {
    assertPrivateSitesReady(`https://${host}`);
    if (origin !== sitesUiOrigin() || !TOKEN.test(ticket)) throw new SitesBrowserError(401);
    const raw = await this.redis.eval(CONSUME, 1, this.key('ticket', ticket));
    if (typeof raw !== 'string') throw new SitesBrowserError(401);
    const value = JSON.parse(raw) as Ticket;
    const cookie = cookies[challengeCookieName(value.challengeId)];
    if (value.host !== host || !cookie || siteTokenHash(cookie) !== value.challenge.secretHash)
      throw new SitesBrowserError(401);
    await this.assertLogin(value);
    await authorize(value);
    // Deleting challenge prevents a second separately minted ticket reusing this bootstrap.
    const challenge = await this.redis.eval(CONSUME, 1, this.key('challenge', value.challengeId));
    if (typeof challenge !== 'string') throw new SitesBrowserError(401);
    const sessionId = randomSiteToken();
    await this.redis.set(
      this.key('viewer', sessionId),
      JSON.stringify(value),
      'EX',
      Math.max(1, value.expiresAt - nowSeconds())
    );
    return {
      sessionId,
      path: safeSiteReturnPath(value.challenge.path),
      maxAge: value.expiresAt - nowSeconds(),
      challengeName: challengeCookieName(value.challengeId),
    };
  }
  async viewer(sessionId: string | undefined, host: string): Promise<Viewer> {
    assertPrivateSitesReady(`https://${host}`);
    if (!sessionId || !TOKEN.test(sessionId)) throw new SitesBrowserError(401);
    const raw = await this.redis.get(this.key('viewer', sessionId));
    if (!raw) throw new SitesBrowserError(401);
    const value = JSON.parse(raw) as Viewer;
    if (value.host !== host) throw new SitesBrowserError(401);
    await this.assertLogin(value);
    return value;
  }
  async logoutViewer(sessionId: string | undefined): Promise<void> {
    if (sessionId && TOKEN.test(sessionId)) await this.redis.eval(CONSUME, 1, this.key('viewer', sessionId));
  }
}
let instance: SitesBrowserAuth | undefined;
export function getSitesBrowserAuth(): SitesBrowserAuth {
  return (instance ??= new SitesBrowserAuth(RedisClient.getInstance().getRedis()));
}
