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

import { validateBuildUuidFormat } from '../buildUuidValidator';

describe('validateBuildUuidFormat', () => {
  test.each(['abc', 'abc-123', 'a1-b2-c3'])('accepts Kubernetes-safe UUID %s', (uuid) => {
    expect(validateBuildUuidFormat(uuid)).toBeNull();
  });

  test.each([
    ['ab', 'UUID must be between 3 and 50 characters'],
    ['a'.repeat(51), 'UUID must be between 3 and 50 characters'],
    ['ABC', 'UUID can only contain lowercase letters, numbers, and hyphens'],
    ['abc_def', 'UUID can only contain lowercase letters, numbers, and hyphens'],
    ['-abc', 'UUID cannot start or end with a hyphen'],
    ['abc-', 'UUID cannot start or end with a hyphen'],
  ])('rejects invalid UUID %s', (uuid, error) => {
    expect(validateBuildUuidFormat(uuid)).toBe(error);
  });
});
