import type { IncomingMessage, ServerResponse } from 'http';
import type Site from 'server/models/Site';
import {
  assertViewerOwns,
  assertViewerActive,
  challengeCookieName,
  getSitesBrowserAuth,
  parseSitesCookies,
  SITES_AUTH_PATH,
  SITES_VIEWER_COOKIE,
  SitesBrowserError,
  sitesUiOrigin,
  type Viewer,
} from './browserAuth';
import type SitesService from 'server/services/sites';

export async function authorizeSitesViewer(site: Site, viewer: Viewer): Promise<void> {
  assertViewerActive(viewer);
  assertViewerOwns(site, viewer);
  if (
    site.siteId !== viewer.siteId ||
    (site.servingGeneration ?? null) !== viewer.generation ||
    site.accessRevision !== viewer.accessRevision
  )
    throw new SitesBrowserError(401);
}
function securityHeaders(res: ServerResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
export async function readSmallBody(req: IncomingMessage, limit = 4096): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) throw new SitesBrowserError(413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function handleSitesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: SitesService
): Promise<void> {
  securityHeaders(res);
  try {
    const host = (req.headers.host || '').toLowerCase();
    const url = new URL(req.url || '/', `https://${host}`);
    const navigate =
      req.method === 'GET' &&
      req.headers['sec-fetch-mode'] === 'navigate' &&
      req.headers['sec-fetch-dest'] === 'document' &&
      !url.pathname.startsWith(SITES_AUTH_PATH);
    const bootstrap = async () => {
      // A locator is syntax, not proof that a Site exists. Missing and inaccessible
      // private hosts take the same browser flow; mint still authorizes the real Site.
      const locator = await service.getGatewayLocator(host);
      const browser = getSitesBrowserAuth();
      await browser.rateLimit(`challenge:${req.socket.remoteAddress || 'unknown'}`);
      const challenge = await browser.challenge(locator, host, `${url.pathname}${url.search}`);
      res.setHeader(
        'Set-Cookie',
        `${challengeCookieName(challenge.state)}=${
          challenge.secret
        }; Secure; HttpOnly; SameSite=None; Path=/; Max-Age=300`
      );
      const open = new URL(`/sites/open/${encodeURIComponent(locator.siteId)}`, sitesUiOrigin());
      open.searchParams.set('state', challenge.state);
      res.writeHead(303, { Location: open.toString() }).end();
    };
    const cookies = parseSitesCookies(req.headers.cookie);
    if (url.pathname.startsWith(SITES_AUTH_PATH)) {
      const auth = getSitesBrowserAuth();
      await service.getGatewayLocator(host);
      if (url.pathname === `${SITES_AUTH_PATH}consume` && req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))
          throw new SitesBrowserError(415);
        await auth!.rateLimit(`consume:${req.socket.remoteAddress || 'unknown'}`, 240);
        const values = new URLSearchParams(await readSmallBody(req));
        if (values.getAll('ticket').length !== 1) throw new SitesBrowserError(400);
        const result = await auth!.consume(
          values.get('ticket') || '',
          host,
          cookies,
          typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
          async (viewer) => authorizeSitesViewer((await service.getGatewaySite(host)).site, viewer)
        );
        res.setHeader('Set-Cookie', [
          `${SITES_VIEWER_COOKIE}=${result.sessionId}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${result.maxAge}`,
          `${result.challengeName}=; Secure; HttpOnly; SameSite=None; Path=/; Max-Age=0`,
        ]);
        res.writeHead(303, { Location: result.path });
        res.end();
        return;
      }
      if (url.pathname === `${SITES_AUTH_PATH}logout` && req.method === 'POST') {
        if (req.headers.origin !== `https://${host}` && req.headers.origin !== sitesUiOrigin())
          throw new SitesBrowserError(403);
        await auth!.logoutViewer(cookies[SITES_VIEWER_COOKIE]);
        res.setHeader('Set-Cookie', `${SITES_VIEWER_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
        res.writeHead(204).end();
        return;
      }
      throw new SitesBrowserError(404);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new SitesBrowserError(404);
    let site: Site;
    try {
      ({ site } = await service.getGatewaySite(host));
    } catch (error) {
      if (navigate && (error as { statusCode?: number }).statusCode === 404) {
        await bootstrap();
        return;
      }
      throw error;
    }
    const auth = site.visibility === 'private' ? getSitesBrowserAuth() : undefined;

    let viewer: Viewer | undefined;
    if (site.visibility === 'private') {
      try {
        viewer = await auth!.viewer(cookies[SITES_VIEWER_COOKIE], host);
        await authorizeSitesViewer(site, viewer);
      } catch {
        // Until access is established, dependency failures must not distinguish a
        // private host from a missing one. Navigations share the same bootstrap.
        if (!navigate) throw new SitesBrowserError(404);
        await bootstrap();
        return;
      }
      if (
        req.headers['service-worker'] === 'script' ||
        ['serviceworker', 'sharedworker', 'worker'].includes(String(req.headers['sec-fetch-dest']))
      )
        throw new SitesBrowserError(403);
    }
    const object = await service.getGatewayObject(host, url.pathname, async (currentSite) => {
      if (!viewer) throw new SitesBrowserError(401);
      // Recheck the fixed deadline and current Site immediately before storage.
      await authorizeSitesViewer(currentSite, viewer);
    });
    if (site.visibility === 'private') {
      // Add private isolation only after both authorization checks, so denial headers
      // cannot distinguish private hosts from missing ones.
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Origin-Agent-Cluster', '?1');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Content-Security-Policy', "worker-src 'none'; frame-ancestors 'none'");
    }
    res.statusCode = object.statusCode;
    res.setHeader('Content-Type', object.contentType);
    if (object.contentLength !== undefined) res.setHeader('Content-Length', String(object.contentLength));
    if (req.method === 'HEAD') {
      (object.body as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      res.end();
      return;
    }
    object.body.on('error', () => {
      if (!res.headersSent) res.statusCode = 502;
      res.end();
    });
    object.body.pipe(res);
  } catch (error) {
    const status =
      (error as { statusCode?: number; httpStatus?: number })?.statusCode ??
      (error as { httpStatus?: number })?.httpStatus ??
      503;
    res.statusCode =
      (error as { code?: string }).code === 'private_sites_unavailable'
        ? 404
        : [401, 403].includes(status)
        ? 404
        : [400, 404, 413, 415, 429, 503].includes(status)
        ? status
        : 503;
    // Do not log tokens, return paths, storage details or account identifiers here.
    res.end(res.statusCode === 404 ? 'not found' : 'Site access is unavailable.');
  }
}
