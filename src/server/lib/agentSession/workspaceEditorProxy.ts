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

import { IncomingHttpHeaders, STATUS_CODES } from 'http';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface BuildWorkspaceEditorProxyHeadersOpts {
  requestHeaders: IncomingHttpHeaders;
  targetHost: string;
  forwardedHost: string;
  forwardedProto: string;
  forwardedPrefix: string;
  remoteAddress?: string | null;
  includeUpgradeHeaders?: boolean;
}

function shouldForwardHeader(headerName: string, includeUpgradeHeaders: boolean): boolean {
  if (headerName === 'host' || headerName === 'content-length') {
    return false;
  }

  if (!HOP_BY_HOP_HEADERS.has(headerName)) {
    return true;
  }

  if (!includeUpgradeHeaders) {
    return false;
  }

  return headerName === 'connection' || headerName === 'upgrade';
}

export function buildWorkspaceEditorProxyHeaders(opts: BuildWorkspaceEditorProxyHeadersOpts): Record<string, string> {
  const {
    requestHeaders,
    targetHost,
    forwardedHost,
    forwardedProto,
    forwardedPrefix,
    remoteAddress,
    includeUpgradeHeaders = false,
  } = opts;

  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(requestHeaders)) {
    if (value == null) {
      continue;
    }

    const normalizedKey = key.toLowerCase();
    if (!shouldForwardHeader(normalizedKey, includeUpgradeHeaders)) {
      continue;
    }

    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  headers.host = targetHost;
  headers['x-forwarded-host'] = forwardedHost || targetHost;
  headers['x-forwarded-proto'] = forwardedProto;
  headers['x-forwarded-prefix'] = forwardedPrefix;

  if (remoteAddress) {
    headers['x-forwarded-for'] = requestHeaders['x-forwarded-for']
      ? `${requestHeaders['x-forwarded-for']}, ${remoteAddress}`
      : remoteAddress;
  }

  if (includeUpgradeHeaders) {
    headers.connection = headers.connection || 'Upgrade';
    headers.upgrade = headers.upgrade || 'websocket';
  }

  return headers;
}

export interface SerializeSocketHttpResponseOpts {
  statusCode: number;
  statusMessage?: string | null;
  headers?: IncomingHttpHeaders;
  body?: Buffer | string | null;
}

export function serializeSocketHttpResponse(opts: SerializeSocketHttpResponseOpts): Buffer {
  const { statusCode, statusMessage, headers = {}, body } = opts;
  const bodyBuffer =
    typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.isBuffer(body) ? body : Buffer.alloc(0);

  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage || STATUS_CODES[statusCode] || 'Unknown'}`];
  let hasContentLength = false;

  for (const [key, value] of Object.entries(headers)) {
    if (value == null) {
      continue;
    }

    if (key.toLowerCase() === 'content-length') {
      hasContentLength = true;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        lines.push(`${key}: ${entry}`);
      }
      continue;
    }

    lines.push(`${key}: ${value}`);
  }

  if (bodyBuffer.length > 0 && !hasContentLength) {
    lines.push(`Content-Length: ${bodyBuffer.length}`);
  }

  const headBuffer = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8');
  return bodyBuffer.length > 0 ? Buffer.concat([headBuffer, bodyBuffer]) : headBuffer;
}
