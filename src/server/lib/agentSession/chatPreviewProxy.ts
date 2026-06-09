/**
 * Copyright 2026 GoodRx, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { IncomingMessage } from 'http';
import { URL } from 'url';
import { buildChatPreviewResolverUrl } from './chatPreviewFactory';
import { getChatPreviewGrantMaxAgeSeconds } from './chatPreviewGrant';
import { buildWorkspaceEditorProxyHeaders } from './workspaceEditorProxy';

export const CHAT_PREVIEW_COOKIE_NAME = 'lfc_chat_preview_auth';

export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const EDITOR_PROXY_BLOCKED_QUERY_PARAMS = ['token'];
export const PREVIEW_PROXY_BLOCKED_QUERY_PARAMS = ['token', 'grant', 'previewHost'];
export const PROXY_EXTRA_HEADER_BLOCKLIST = new Set([
  'cookie',
  'set-cookie',
  'referer',
  'referrer',
  'origin',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-prefix',
  'x-forwarded-proto',
  'x-real-ip',
]);

export interface ChatPreviewPathMatch {
  sessionId: string;
  port: number;
  forwardPath: string;
  previewHost: string;
  previewSlug: string;
}

export function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseCookieHeader(cookieHeader: string | string[] | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  const raw = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
  return raw.split(';').reduce<Record<string, string>>((cookies, entry) => {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex < 0) {
      return cookies;
    }

    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();
    if (!key) {
      return cookies;
    }

    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
    return cookies;
  }, {});
}

export function getChatPreviewCookiePath(): string {
  return '/';
}

export function stripQueryParamsFromRequestUrl(rawUrl: string | undefined, params: Iterable<string>): string {
  const url = new URL(rawUrl || '/', 'http://placeholder');
  for (const param of params) {
    url.searchParams.delete(param);
  }
  return `${url.pathname}${url.search}`;
}

export function stripPreviewBootstrapParams(rawUrl: string | undefined): string {
  return stripQueryParamsFromRequestUrl(rawUrl, PREVIEW_PROXY_BLOCKED_QUERY_PARAMS);
}

export function appendForwardQuery(
  target: URL,
  query: Record<string, string | string[] | undefined>,
  blockedQueryParams: Iterable<string> = []
): void {
  const blocked = new Set(Array.from(blockedQueryParams, (value) => value.toLowerCase()));
  for (const [key, value] of Object.entries(query)) {
    if (value == null || blocked.has(key.toLowerCase())) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => target.searchParams.append(key, item));
      continue;
    }

    target.searchParams.set(key, value);
  }
}

export function buildRemoteTargetUrl(
  endpointUrl: string,
  forwardPath: string,
  query: Record<string, string | string[] | undefined>,
  opts: { isWebSocket: boolean; blockedQueryParams?: Iterable<string> }
): URL {
  const target = new URL(endpointUrl);
  if (opts.isWebSocket) {
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  }
  const basePath = target.pathname.replace(/\/+$/, '');
  const pathSuffix = forwardPath.startsWith('/') ? forwardPath : `/${forwardPath}`;
  target.pathname = `${basePath}${pathSuffix}` || '/';
  appendForwardQuery(target, query, opts.blockedQueryParams);
  return target;
}

export function buildChatPreviewAuthRedirectUrl(
  match: ChatPreviewPathMatch,
  query: Record<string, string | string[] | undefined>
): string {
  const target = new URL(buildChatPreviewResolverUrl({ sessionUuid: match.sessionId, port: match.port }));
  const suffix = match.forwardPath === '/' ? '' : match.forwardPath;
  if (suffix) {
    target.pathname = `${target.pathname.replace(/\/$/, '')}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
  }

  appendForwardQuery(target, query, PREVIEW_PROXY_BLOCKED_QUERY_PARAMS);

  target.searchParams.set('previewHost', match.previewHost);

  return target.toString();
}

function isSecureRequest(request: IncomingMessage): boolean {
  return (
    request.headers['x-forwarded-proto'] === 'https' || (request.socket as { encrypted?: boolean }).encrypted === true
  );
}

export function buildChatPreviewCookie(request: IncomingMessage, grant: string): string {
  const maxAgeSeconds = getChatPreviewGrantMaxAgeSeconds(grant);
  const cookieParts = [
    `${CHAT_PREVIEW_COOKIE_NAME}=${encodeURIComponent(grant)}`,
    `Path=${getChatPreviewCookiePath()}`,
    ...(maxAgeSeconds === null ? [] : [`Max-Age=${maxAgeSeconds}`]),
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isSecureRequest(request)) {
    cookieParts.push('Secure');
  }
  return cookieParts.join('; ');
}

export function removeHeaderCaseInsensitive(headers: Record<string, string>, name: string): void {
  const normalizedName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === normalizedName) {
      delete headers[key];
    }
  }
}

export function setHeaderCaseInsensitive(headers: Record<string, string>, name: string, value: string): void {
  removeHeaderCaseInsensitive(headers, name);
  headers[name] = value;
}

export function mergeProxyExtraHeaders(headers: Record<string, string>, extraHeaders?: Record<string, string>): void {
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    const normalizedKey = key.toLowerCase();
    if (
      !key ||
      value == null ||
      HOP_BY_HOP_HEADERS.has(normalizedKey) ||
      normalizedKey === 'content-length' ||
      PROXY_EXTRA_HEADER_BLOCKLIST.has(normalizedKey)
    ) {
      continue;
    }

    setHeaderCaseInsensitive(headers, key, value);
  }
}

export function buildProxyHeaders(
  request: IncomingMessage,
  target: URL,
  forwardedPrefix: string,
  extraHeaders?: Record<string, string>,
  includeUpgradeHeaders = false,
  stripCredentials = false
): Record<string, string> {
  const headers: Record<string, string> = buildWorkspaceEditorProxyHeaders({
    requestHeaders: request.headers,
    targetHost: target.host,
    forwardedHost: request.headers.host || target.host,
    forwardedProto:
      (typeof request.headers['x-forwarded-proto'] === 'string' && request.headers['x-forwarded-proto']) ||
      ((request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'),
    forwardedPrefix,
    remoteAddress: request.socket.remoteAddress,
    includeUpgradeHeaders,
  });
  if (stripCredentials) {
    removeHeaderCaseInsensitive(headers, 'cookie');
    removeHeaderCaseInsensitive(headers, 'authorization');
    removeHeaderCaseInsensitive(headers, 'referer');
    removeHeaderCaseInsensitive(headers, 'referrer');
    removeHeaderCaseInsensitive(headers, 'origin');
  }
  mergeProxyExtraHeaders(headers, extraHeaders);
  return headers;
}

function resolvePreviewRequestProtocol(request: IncomingMessage): string {
  return (
    (typeof request.headers['x-forwarded-proto'] === 'string' && request.headers['x-forwarded-proto']) ||
    ((request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http')
  );
}

export function buildPreviewPublicOrigin(request: IncomingMessage): string | null {
  return request.headers.host ? `${resolvePreviewRequestProtocol(request)}://${request.headers.host}` : null;
}

function rewritePreviewAbsoluteUrl(
  value: string,
  targetUrl: URL,
  request: IncomingMessage,
  forwardedPrefix: string
): string {
  let parsed: URL;
  try {
    parsed = new URL(value, targetUrl);
  } catch {
    return value;
  }

  const publicOrigin = buildPreviewPublicOrigin(request);
  if (parsed.origin !== targetUrl.origin || !publicOrigin) {
    return value;
  }

  const prefix = forwardedPrefix.replace(/\/+$/, '');
  const publicPath = `${prefix}${parsed.pathname.startsWith('/') ? parsed.pathname : `/${parsed.pathname}`}` || '/';
  return `${publicOrigin}${publicPath}${parsed.search}${parsed.hash}`;
}

export function rewritePreviewResponseHeader(
  key: string,
  value: string,
  targetUrl: URL,
  request: IncomingMessage,
  forwardedPrefix: string
): string {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === 'location' || normalizedKey === 'content-location') {
    return rewritePreviewAbsoluteUrl(value, targetUrl, request, forwardedPrefix);
  }

  if (normalizedKey === 'refresh') {
    return value.replace(/url=([^;]+)/i, (_match, rawUrl: string) => {
      const trimmed = rawUrl.trim();
      const quote = trimmed.startsWith('"') || trimmed.startsWith("'") ? trimmed[0] : '';
      const unquoted = quote && trimmed.endsWith(quote) ? trimmed.slice(1, -1) : trimmed;
      const rewritten = rewritePreviewAbsoluteUrl(unquoted, targetUrl, request, forwardedPrefix);
      return `url=${quote}${rewritten}${quote}`;
    });
  }

  return value;
}
