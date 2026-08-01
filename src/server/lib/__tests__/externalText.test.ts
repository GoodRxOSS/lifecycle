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

import { redactExternalText } from '../externalText';

it('returns short text unchanged', () => {
  expect(redactExternalText('plain output')).toBe('plain output');
});

it('clamps to the byte limit without splitting a multi-byte character', () => {
  const text = '€'.repeat(10);

  const clamped = redactExternalText(text, 8);

  expect(clamped).toBe('€€');
  expect(Buffer.byteLength(clamped, 'utf8')).toBeLessThanOrEqual(8);
  expect(clamped).not.toContain('�');
});

it('clamps exactly at a character boundary without truncating extra bytes', () => {
  expect(redactExternalText('€'.repeat(10), 9)).toBe('€€€');
});
