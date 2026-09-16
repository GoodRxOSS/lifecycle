import { createHash, randomBytes } from 'crypto';
import * as psl from 'psl';
import type Redis from 'ioredis';
import RedisClient from 'server/lib/redisClient';
import { AppError } from 'server/lib/appError';

export const SITES_AUTH_PATH = '/_lfc-sites/';
export const SITES_VIEWER_COOKIE = '__Host-lfc-sites-viewer';
export const MAX_VIEWER_SECONDS = 300;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// Invalidate pre-simplification login/vault-backed browser state.
const PREFIX = 'sites:browser:v2:';
const CONSUME = `-- sites-consume
local value = redis.call('GET', KEYS[1])
if value then redis.call('DEL', KEYS[1]) end
return value`;
const LIMIT = `-- sites-limit
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 60) end
return count`;

export class SitesBrowserError extends AppError {
  constructor(public statusCode: number, message = 'Site access is unavailable.') {
    super({ httpStatus: statusCode, code: 'sites_browser_unavailable', message });
  }
}
export type BrowserActor = { issuer: string; subject: string };
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
  expiresAt: number;
};
type Ticket = Viewer & { challengeId: string; challenge: Challenge };
export type SitesBrowserMintBody = { siteId: string; state: string };
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
export function assertPrivateSitesReady(contentUrl?: string): void {
  if (process.env.ENABLE_AUTH !== 'true' || process.env.SITES_PRIVATE_ENABLED !== 'true')
    throw new SitesBrowserError(503);
  const ui = new URL(sitesUiOrigin());
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

export async function readSitesMintBody(request: {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}): Promise<SitesBrowserMintBody> {
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
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SitesBrowserError(400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SitesBrowserError(400);
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => key !== 'siteId' && key !== 'state') ||
    typeof value.siteId !== 'string' ||
    !/^[a-z0-9-]{1,64}$/.test(value.siteId) ||
    typeof value.state !== 'string' ||
    !TOKEN.test(value.state)
  )
    throw new SitesBrowserError(400);
  return { siteId: value.siteId, state: value.state };
}

/** Fixed authorization deadline: reads never renew the grant. */
export function assertViewerActive(viewer: Viewer): void {
  if (!Number.isSafeInteger(viewer.expiresAt) || viewer.expiresAt <= nowSeconds()) throw new SitesBrowserError(401);
}

export class SitesBrowserAuth {
  constructor(private readonly redis: Pick<Redis, 'get' | 'set' | 'eval'>) {}
  private key(kind: string, value: string) {
    return `${PREFIX}${kind}:${siteTokenHash(value)}`;
  }
  async rateLimit(identity: string, maximum = 60): Promise<void> {
    if (Number(await this.redis.eval(LIMIT, 1, this.key('rate', identity))) > maximum) throw new SitesBrowserError(429);
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
  /** Called only after normal JWT, current credential and ownership authorization. */
  async mint(
    site: BrowserSite,
    actor: BrowserActor,
    body: SitesBrowserMintBody,
    tokenExpiresAt: number
  ): Promise<{ ticket: string; consumeUrl: string }> {
    assertViewerOwns(site, actor);
    if (!body.state || body.siteId !== site.siteId) throw new SitesBrowserError(401);
    const challenge = await this.readChallenge(body.state);
    if (challenge.siteId !== site.siteId || challenge.generation !== (site.servingGeneration ?? null))
      throw new SitesBrowserError(401);
    assertPrivateSitesReady(`https://${challenge.host}`);
    if (!Number.isSafeInteger(tokenExpiresAt)) throw new SitesBrowserError(401);
    const expiresAt = Math.min(nowSeconds() + MAX_VIEWER_SECONDS, tokenExpiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds()) throw new SitesBrowserError(401);
    const value: Ticket = {
      issuer: actor.issuer,
      subject: actor.subject,
      siteId: site.siteId,
      host: challenge.host,
      generation: site.servingGeneration ?? null,
      accessRevision: site.accessRevision,
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
    assertViewerActive(value);
    await authorize(value);
    // Deleting challenge prevents a second separately minted ticket reusing this bootstrap.
    const challenge = await this.redis.eval(CONSUME, 1, this.key('challenge', value.challengeId));
    if (typeof challenge !== 'string') throw new SitesBrowserError(401);
    assertViewerActive(value);
    const sessionId = randomSiteToken();
    await this.redis.set(
      this.key('viewer', sessionId),
      JSON.stringify({
        issuer: value.issuer,
        subject: value.subject,
        siteId: value.siteId,
        host: value.host,
        generation: value.generation,
        accessRevision: value.accessRevision,
        expiresAt: value.expiresAt,
      }),
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
    assertViewerActive(value);
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
