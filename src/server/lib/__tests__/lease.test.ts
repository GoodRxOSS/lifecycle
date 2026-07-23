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

import { computeExtendedExpiry, computeInitialExpiry, isExpired } from 'server/lib/lease';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-07-07T12:00:00Z');

describe('computeInitialExpiry', () => {
  it('adds the requested hours', () => {
    expect(computeInitialExpiry(now, 72, 336).getTime()).toBe(now.getTime() + 72 * HOUR);
  });

  it('caps at maxTtlHours and floors at one hour', () => {
    expect(computeInitialExpiry(now, 10_000, 336).getTime()).toBe(now.getTime() + 336 * HOUR);
    expect(computeInitialExpiry(now, 0, 336).getTime()).toBe(now.getTime() + 1 * HOUR);
  });
});

describe('computeExtendedExpiry', () => {
  it('extends from the current expiry when it is in the future', () => {
    const current = new Date(now.getTime() + 10 * HOUR);
    expect(computeExtendedExpiry(now, current, 24, 336).getTime()).toBe(current.getTime() + 24 * HOUR);
  });

  it('resumes from now when the lease already expired', () => {
    const current = new Date(now.getTime() - 5 * HOUR);
    expect(computeExtendedExpiry(now, current, 24, 336).getTime()).toBe(now.getTime() + 24 * HOUR);
  });

  it('treats a missing lease as starting now', () => {
    expect(computeExtendedExpiry(now, null, 24, 336).getTime()).toBe(now.getTime() + 24 * HOUR);
  });

  it('never exceeds now + maxTtlHours', () => {
    const current = new Date(now.getTime() + 330 * HOUR);
    expect(computeExtendedExpiry(now, current, 24, 336).getTime()).toBe(now.getTime() + 336 * HOUR);
  });
});

describe('isExpired', () => {
  it('is false without a lease and true at/after the deadline', () => {
    expect(isExpired(now, null)).toBe(false);
    expect(isExpired(now, undefined)).toBe(false);
    expect(isExpired(now, new Date(now.getTime() + 1))).toBe(false);
    expect(isExpired(now, now.toISOString())).toBe(true);
    expect(isExpired(now, new Date(now.getTime() - 1))).toBe(true);
  });
});
