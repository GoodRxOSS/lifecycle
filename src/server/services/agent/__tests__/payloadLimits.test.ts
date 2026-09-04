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

import { limitDurablePayloadRecord, limitDurablePayloadValue, MAX_AGENT_DURABLE_PAYLOAD_BYTES } from '../payloadLimits';

describe('durable payload limits', () => {
  describe('limitDurablePayloadValue', () => {
    it('preserves the original value at the exact JSON byte limit', () => {
      const value = { status: 'ready' };
      const maxDurablePayloadBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');

      expect(limitDurablePayloadValue(value, { maxDurablePayloadBytes })).toBe(value);
    });

    it('uses UTF-8 byte length and returns the configured serialized preview when oversized', () => {
      expect(
        limitDurablePayloadValue('éé', {
          maxDurablePayloadBytes: 5,
          payloadPreviewBytes: 2,
        })
      ).toEqual({
        truncated: true,
        originalJsonBytes: 6,
        preview: '"é',
      });
    });

    it('preserves undefined when its JSON fallback fits the default limit', () => {
      expect(limitDurablePayloadValue(undefined)).toBeUndefined();
    });

    it('applies the exported default cap to serialized JSON bytes', () => {
      const value = 'x'.repeat(MAX_AGENT_DURABLE_PAYLOAD_BYTES);

      expect(limitDurablePayloadValue(value)).toEqual({
        truncated: true,
        originalJsonBytes: MAX_AGENT_DURABLE_PAYLOAD_BYTES + 2,
        preview: expect.any(String),
      });
    });
  });

  describe('limitDurablePayloadRecord', () => {
    it('uses the default limit for a normal record', () => {
      const payload = { status: 'ready' };

      expect(limitDurablePayloadRecord(payload)).toBe(payload);
    });

    it('preserves the original record when its serialized size is within the explicit limit', () => {
      const payload = { status: 'ready', attempts: 1 };
      const maxDurablePayloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');

      expect(limitDurablePayloadRecord(payload, { maxDurablePayloadBytes })).toBe(payload);
    });

    it('limits oversized fields when the resulting record fits the total limit', () => {
      const payload = { small: 'ok', huge: 'x'.repeat(140) };

      expect(
        limitDurablePayloadRecord(payload, {
          maxDurablePayloadBytes: 100,
          payloadPreviewBytes: 5,
        })
      ).toEqual({
        small: 'ok',
        huge: {
          truncated: true,
          originalJsonBytes: 142,
          preview: '"xxxx',
        },
      });
    });

    it('limits the whole record when individually acceptable fields still exceed the total limit', () => {
      const payload = { first: '1234567890', second: 'abcdefghij' };

      expect(
        limitDurablePayloadRecord(payload, {
          maxDurablePayloadBytes: 20,
          payloadPreviewBytes: 8,
        })
      ).toEqual({
        truncated: true,
        originalJsonBytes: 44,
        preview: '{"first"',
      });
    });
  });
});
