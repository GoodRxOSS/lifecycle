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

import { truncateUtf8Tail } from '../truncate';

describe('truncateUtf8Tail', () => {
  it('returns text unchanged when within the byte limit', () => {
    const result = truncateUtf8Tail('short log line', 100);
    expect(result).toEqual({ text: 'short log line', truncated: false });
  });

  it('keeps only the trailing maxBytes bytes of a single oversized line', () => {
    const text = 'a'.repeat(1000);
    const result = truncateUtf8Tail(text, 100);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('a'.repeat(100));
    expect(Buffer.byteLength(result.text, 'utf8')).toBe(100);
  });

  it('never splits a multi-byte character at the cut point', () => {
    // Each snowman is 3 bytes; a 10-byte cap can hold 3 whole characters (9 bytes), not a split 4th.
    const text = '☃'.repeat(50);
    const result = truncateUtf8Tail(text, 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('☃'.repeat(3));
    expect(result.text).not.toContain('�');
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(10);
  });

  it('handles a limit exactly on a character boundary', () => {
    const text = '☃'.repeat(4);
    const result = truncateUtf8Tail(text, 6);
    expect(result).toEqual({ text: '☃☃', truncated: true });
  });

  it('returns empty text when the limit is smaller than one character', () => {
    const result = truncateUtf8Tail('☃', 1);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('');
  });
});
