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

import { createHmac } from 'crypto';
import { APP_HOST, CHAT_PREVIEW_DOMAIN, LIFECYCLE_UI_URL } from 'shared/config';

export interface ChatPreviewPublication {
  url: string;
  host: string | null;
  path: string;
  port: number;
}

export interface ChatPreviewHostMatch {
  port: number;
  previewSlug: string;
  host: string;
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildChatPreviewResolverPath(sessionUuid: string, port: number): string {
  return `/preview/${sessionUuid}/${port}`;
}

export function resolveChatPreviewHostDomain(): string | null {
  const configured = normalizeDomain(CHAT_PREVIEW_DOMAIN);
  if (configured) {
    return configured;
  }

  const appUrl = new URL(APP_HOST);
  if (appUrl.hostname === 'localhost') {
    return appUrl.port ? `${appUrl.hostname}:${appUrl.port}` : appUrl.hostname;
  }

  return null;
}

export function resolveChatPreviewHostProtocol(): string {
  return new URL(APP_HOST).protocol;
}

function readPreviewHostSecret(): string {
  const secret =
    process.env.CHAT_PREVIEW_HOST_SECRET ||
    process.env.CHAT_PREVIEW_GRANT_SECRET ||
    process.env.ENCRYPTION_KEY ||
    process.env.NEXTAUTH_SECRET ||
    process.env.GITHUB_WEBHOOK_SECRET ||
    '';
  const normalized = secret.trim();
  if (normalized && normalized !== 'changeme' && normalized !== 'not_setup') {
    return normalized;
  }
  if (process.env.ENABLE_AUTH !== 'true') {
    return 'local-dev-chat-preview-host-secret';
  }
  throw new Error('CHAT_PREVIEW_HOST_SECRET or ENCRYPTION_KEY must be configured for host-based preview URLs.');
}

export function buildChatPreviewHostSlug({ sessionUuid, port }: { sessionUuid: string; port: number }): string {
  return createHmac('sha256', readPreviewHostSecret()).update(`${sessionUuid}:${port}`).digest('hex').slice(0, 32);
}

export function buildChatPreviewHost({ port, previewSlug }: { port: number; previewSlug: string }): string | null {
  const domain = resolveChatPreviewHostDomain();
  if (!domain) {
    return null;
  }
  return `${port}--${previewSlug}.${domain}`;
}

export function parseChatPreviewHost(hostHeader: string | null | undefined): ChatPreviewHostMatch | null {
  const domain = resolveChatPreviewHostDomain();
  if (!domain || !hostHeader) {
    return null;
  }

  const normalizedHost = normalizeDomain(hostHeader);
  const pattern = new RegExp(`^(\\d{1,5})--([a-z0-9][a-z0-9-]{5,63})\\.${escapeRegExp(domain)}$`, 'i');
  const match = normalizedHost.match(pattern);
  if (!match) {
    return null;
  }

  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return {
    port,
    previewSlug: match[2].toLowerCase(),
    host: normalizedHost,
  };
}

function resolveChatPreviewResolverBaseUrl(): string {
  const configured = LIFECYCLE_UI_URL.trim();
  if (configured) {
    return configured;
  }

  const appUrl = new URL(APP_HOST);
  if (appUrl.hostname === 'localhost' && appUrl.port === '5001') {
    appUrl.port = '3000';
    return appUrl.toString();
  }

  if (normalizeDomain(CHAT_PREVIEW_DOMAIN)) {
    throw new Error('LIFECYCLE_UI_URL must be configured when CHAT_PREVIEW_DOMAIN is enabled.');
  }

  return APP_HOST;
}

export function buildChatPreviewResolverUrl({ sessionUuid, port }: { sessionUuid: string; port: number }): string {
  return new URL(buildChatPreviewResolverPath(sessionUuid, port), resolveChatPreviewResolverBaseUrl()).toString();
}

export function resolveChatPreviewPublicPublication({
  port,
  previewSlug,
}: {
  port: number;
  previewSlug: string;
}): Pick<ChatPreviewPublication, 'url' | 'host' | 'path'> {
  const host = buildChatPreviewHost({ port, previewSlug });
  if (!host) {
    throw new Error('CHAT_PREVIEW_DOMAIN must be configured to publish remote sandbox previews.');
  }

  return {
    url: `${resolveChatPreviewHostProtocol()}//${host}/`,
    host,
    path: '/',
  };
}
