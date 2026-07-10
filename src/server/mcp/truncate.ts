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

/**
 * Keep at most the trailing `maxBytes` UTF-8 bytes of `text`, never splitting a
 * multi-byte character. Line-count limits alone don't bound archived log payloads:
 * a single long line (JSON, base64 blobs) can be arbitrarily large.
 */
export function truncateUtf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return { text, truncated: false };
  }

  let start = buffer.length - maxBytes;
  // 0b10xxxxxx marks a UTF-8 continuation byte; advance to the next character boundary.
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start += 1;
  }

  return { text: buffer.subarray(start).toString('utf8'), truncated: true };
}
