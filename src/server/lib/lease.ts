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

/** Pure lease math shared by the API-environment expiry sweep and /extend. */

const HOUR_MS = 60 * 60 * 1000;

export function computeInitialExpiry(now: Date, ttlHours: number, maxTtlHours: number): Date {
  const hours = Math.min(Math.max(ttlHours, 1), maxTtlHours);
  return new Date(now.getTime() + hours * HOUR_MS);
}

/**
 * Extends from max(now, current) so an expired-but-unswept lease resumes from
 * now, and the result never exceeds now + maxTtlHours.
 */
export function computeExtendedExpiry(
  now: Date,
  current: Date | null,
  extensionHours: number,
  maxTtlHours: number
): Date {
  const base = current ? Math.max(now.getTime(), current.getTime()) : now.getTime();
  const cap = now.getTime() + maxTtlHours * HOUR_MS;
  return new Date(Math.min(base + Math.max(extensionHours, 1) * HOUR_MS, cap));
}

export function isExpired(now: Date, expiresAt: Date | string | null | undefined): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= now.getTime();
}
