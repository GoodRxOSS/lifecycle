/**
 * Copyright 2025 GoodRx, Inc.
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

import { resolveUserIdentifierFromPayload } from '../userIdentifier';

describe('resolveUserIdentifierFromPayload', () => {
  it('returns undefined when payload is missing', () => {
    expect(resolveUserIdentifierFromPayload(null)).toBeUndefined();
  });

  it('uses the highest priority claim and trims whitespace', () => {
    expect(
      resolveUserIdentifierFromPayload({
        preferred_username: ' preferred-user ',
        github_username: ' github-user ',
      })
    ).toBe('github-user');
  });

  it('clamps long identifiers to 255 characters', () => {
    const longIdentifier = 'a'.repeat(300);
    const resolved = resolveUserIdentifierFromPayload({
      preferred_username: longIdentifier,
    });

    expect(resolved).toBeDefined();
    expect(resolved!.length).toBe(255);
    expect(resolved).toBe('a'.repeat(255));
  });

  it('clamps Unicode identifiers without splitting surrogate pairs', () => {
    const longUnicodeIdentifier = '😀'.repeat(300);
    const resolved = resolveUserIdentifierFromPayload({
      preferred_username: longUnicodeIdentifier,
    });

    expect(resolved).toBeDefined();
    expect(Array.from(resolved!).length).toBe(255);
    expect(/[\uD800-\uDBFF]$/.test(resolved!)).toBe(false);
  });
});
