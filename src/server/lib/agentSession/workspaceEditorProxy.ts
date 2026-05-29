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

// --- Hardening tunables (rh-2) ---
// Upstream connect+response budget; reaps pods that accept TCP but never respond.
export const EDITOR_PROXY_TIMEOUT_MS = parseInt(process.env.AGENT_SESSION_EDITOR_PROXY_TIMEOUT_MS || '30000', 10);
// WS heartbeat: ping every 30s, terminate if no pong within the deadline.
export const EDITOR_PROXY_PING_INTERVAL_MS = parseInt(
  process.env.AGENT_SESSION_EDITOR_PROXY_PING_INTERVAL_MS || '30000',
  10
);
export const EDITOR_PROXY_PONG_DEADLINE_MS = parseInt(
  process.env.AGENT_SESSION_EDITOR_PROXY_PONG_DEADLINE_MS || '10000',
  10
);
// Concurrent live proxied connections (HTTP in-flight + WS) caps. 0 disables.
export const EDITOR_PROXY_MAX_PER_SESSION = parseInt(
  process.env.AGENT_SESSION_EDITOR_PROXY_MAX_PER_SESSION || '64',
  10
);
export const EDITOR_PROXY_MAX_GLOBAL = parseInt(process.env.AGENT_SESSION_EDITOR_PROXY_MAX_GLOBAL || '512', 10);

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

// --- Coded failure mapping (err-4) ---
// Coded reasons drive the right deep-link CTA on the branded error page.
export type EditorProxyFailureReason =
  | 'auth'
  | 'workspace-suspended'
  | 'pod-gone'
  | 'unreachable'
  | 'timeout'
  | 'capacity';

export interface EditorProxyFailureMapping {
  reason: EditorProxyFailureReason;
  status: number;
  title: string;
  message: string;
  // CTA links back to the Lifecycle session so the user can resume/restart.
  cta: string;
}

const EDITOR_PROXY_FAILURE_MAPPING: Record<EditorProxyFailureReason, Omit<EditorProxyFailureMapping, 'reason'>> = {
  auth: {
    status: 401,
    title: 'Editor session expired',
    message: 'Your editor session is no longer authenticated. Reopen the editor from the session to continue.',
    cta: 'Back to session',
  },
  'workspace-suspended': {
    // 409 Conflict: the workspace exists but is paused; resume reconciles it.
    status: 409,
    title: 'Workspace suspended',
    message: 'This workspace is suspended. Resume it from the session to reopen the editor.',
    cta: 'Resume workspace',
  },
  'pod-gone': {
    // 410 Gone: the backing pod no longer exists; a restart re-provisions it.
    status: 410,
    title: 'Workspace stopped',
    message: 'The workspace runtime is no longer running. Restart it from the session to reopen the editor.',
    cta: 'Restart workspace',
  },
  unreachable: {
    status: 502,
    title: 'Editor unavailable',
    message: 'The editor runtime is starting up or temporarily unreachable. Restart the workspace if this persists.',
    cta: 'Back to session',
  },
  timeout: {
    status: 504,
    title: 'Editor timed out',
    message: 'The editor runtime did not respond in time. Restart the workspace if this persists.',
    cta: 'Restart workspace',
  },
  capacity: {
    status: 503,
    title: 'Too many editor connections',
    message: 'This session has too many open editor connections. Close some tabs and try again.',
    cta: 'Back to session',
  },
};

export interface EditorProxyFailureContext {
  // True when the upstream workspace status is not READY (suspended/failed/etc).
  workspaceUnavailable?: boolean;
  // True when a podName/namespace could not be resolved (pod gone).
  podMissing?: boolean;
}

// Maps a thrown error (auth string, socket error code, or explicit timeout/capacity) to a coded reason.
export function classifyEditorProxyFailure(
  error: unknown,
  ctx: EditorProxyFailureContext = {}
): EditorProxyFailureReason {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const code = (error as { code?: string } | null)?.code;

  if (message === 'editor-proxy-timeout') {
    return 'timeout';
  }
  if (message === 'editor-proxy-capacity') {
    return 'capacity';
  }
  if (message.includes('Authentication') || message.includes('Forbidden')) {
    return 'auth';
  }
  if (ctx.workspaceUnavailable) {
    return 'workspace-suspended';
  }
  if (ctx.podMissing || message.includes('Session not found')) {
    return 'pod-gone';
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ECONNRESET') {
    return 'unreachable';
  }
  return 'unreachable';
}

export function resolveEditorProxyFailureMapping(reason: EditorProxyFailureReason): EditorProxyFailureMapping {
  return { reason, ...EDITOR_PROXY_FAILURE_MAPPING[reason] };
}

// True for top-level browser navigations, which need an HTML page rather than a raw status body.
export function isEditorNavigationRequest(headers: IncomingHttpHeaders): boolean {
  const accept = headers.accept;
  const value = Array.isArray(accept) ? accept.join(',') : accept || '';
  return value.includes('text/html');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface BuildWorkspaceEditorErrorPageOpts {
  reason: EditorProxyFailureReason;
  // Absolute or relative deep-link back to the Lifecycle session.
  sessionUrl: string;
}

// Small branded HTML error page for navigation failures (err-4).
export function buildWorkspaceEditorErrorPage(opts: BuildWorkspaceEditorErrorPageOpts): string {
  const { reason, sessionUrl } = opts;
  const mapping = resolveEditorProxyFailureMapping(reason);
  const safeUrl = escapeHtml(sessionUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(mapping.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0b0d12; color: #e6e8ee; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { max-width: 30rem; padding: 2.5rem; text-align: center; }
  .badge { display: inline-block; font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase;
    color: #8a90a2; margin-bottom: 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 0.75rem; }
  p { color: #aab0c0; line-height: 1.5; margin: 0 0 1.75rem; }
  a.cta { display: inline-block; background: #4f7cff; color: #fff; text-decoration: none; font-weight: 600;
    padding: 0.7rem 1.4rem; border-radius: 0.6rem; }
  a.cta:hover { background: #3f6cef; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">Lifecycle Workspace &middot; ${escapeHtml(mapping.reason)}</div>
    <h1>${escapeHtml(mapping.title)}</h1>
    <p>${escapeHtml(mapping.message)}</p>
    <a class="cta" href="${safeUrl}">${escapeHtml(mapping.cta)}</a>
  </div>
</body>
</html>`;
}

// --- Connection registry (rh-2) ---
// Module-level live-socket registry so abandoned sockets are observable and over-cap attempts are rejected.
class EditorProxyConnectionRegistry {
  private readonly bySession = new Map<string, Set<object>>();
  private total = 0;

  size(): number {
    return this.total;
  }

  sizeForSession(sessionId: string): number {
    return this.bySession.get(sessionId)?.size ?? 0;
  }

  // Returns false (and registers nothing) when a cap would be exceeded.
  tryRegister(sessionId: string, token: object): boolean {
    if (EDITOR_PROXY_MAX_GLOBAL > 0 && this.total >= EDITOR_PROXY_MAX_GLOBAL) {
      return false;
    }
    if (EDITOR_PROXY_MAX_PER_SESSION > 0 && this.sizeForSession(sessionId) >= EDITOR_PROXY_MAX_PER_SESSION) {
      return false;
    }
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.bySession.set(sessionId, set);
    }
    if (!set.has(token)) {
      set.add(token);
      this.total += 1;
    }
    return true;
  }

  release(sessionId: string, token: object): void {
    const set = this.bySession.get(sessionId);
    if (!set || !set.has(token)) {
      return;
    }
    set.delete(token);
    this.total -= 1;
    if (set.size === 0) {
      this.bySession.delete(sessionId);
    }
  }
}

export const editorProxyConnections = new EditorProxyConnectionRegistry();
