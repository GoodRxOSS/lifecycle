/**
 * Copyright 2026 Lifecycle contributors
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

import type { DomainDefaults } from 'server/services/types/globalConfig';

const LOCAL_PUBLIC_DOMAIN = '127.0.0.1.nip.io';

export type PublicScheme = 'http' | 'https';

function isLocalPublicHost(value: string | null | undefined): boolean {
  if (!value) return false;

  try {
    const hostname = new URL(`http://${value}`).hostname.toLowerCase();
    return hostname === LOCAL_PUBLIC_DOMAIN || hostname.endsWith(`.${LOCAL_PUBLIC_DOMAIN}`);
  } catch {
    return false;
  }
}

export function resolvePublicScheme(
  domainDefaults?: Partial<DomainDefaults> | null,
  publicUrl = domainDefaults?.http
): PublicScheme {
  if (domainDefaults?.publicScheme === 'http' || domainDefaults?.publicScheme === 'https') {
    return domainDefaults.publicScheme;
  }

  return domainDefaults?.http === LOCAL_PUBLIC_DOMAIN && isLocalPublicHost(publicUrl) ? 'http' : 'https';
}

export function toPublicHref(
  publicUrl: string | null | undefined,
  domainDefaults?: Partial<DomainDefaults> | null
): string | null {
  const value = publicUrl?.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;

  return `${resolvePublicScheme(domainDefaults, value)}://${value}`;
}
