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

import { OutputLimiter } from '../outputLimiter';

describe('OutputLimiter', () => {
  describe('truncate', () => {
    it('returns short content unchanged', () => {
      expect(OutputLimiter.truncate('short')).toBe('short');
    });

    it('returns content at exactly maxChars unchanged', () => {
      const content = 'x'.repeat(100);
      expect(OutputLimiter.truncate(content, 100)).toBe(content);
    });

    it('truncates plain text over limit with marker', () => {
      const content = 'x'.repeat(500);
      const result = OutputLimiter.truncate(content, 200);
      expect(result.length).toBeLessThanOrEqual(200);
      expect(result).toContain('[Truncated:');
      expect(result).toContain('of 500 chars');
      expect(result).toContain('use tighter filters');
    });

    it('truncates JSON content while preserving JSON validity', () => {
      const obj = { logs: 'x'.repeat(50000), small: 'keep' };
      const json = JSON.stringify(obj);
      const result = OutputLimiter.truncate(json, 30000);
      expect(result.length).toBeLessThanOrEqual(30000);
      const parsed = JSON.parse(result);
      expect(parsed.small).toBe('keep');
      expect(parsed.logs).toContain('[Truncated:');
    });

    it('uses default maxChars of 30000', () => {
      const content = 'x'.repeat(40000);
      const result = OutputLimiter.truncate(content);
      expect(result.length).toBeLessThanOrEqual(30000);
    });

    it('truncates largest JSON fields first', () => {
      const obj = { big: 'a'.repeat(20000), medium: 'b'.repeat(10000), small: 'c'.repeat(100) };
      const result = OutputLimiter.truncate(JSON.stringify(obj), 5000);
      const parsed = JSON.parse(result);
      expect(parsed.small).toBe('c'.repeat(100));
      expect(parsed.big.length).toBeLessThan(20000);
    });
  });

  describe('truncateLogOutput', () => {
    it('returns short log content unchanged', () => {
      const content = 'line1\nline2\nline3';
      expect(OutputLimiter.truncateLogOutput(content)).toBe(content);
    });

    it('preserves first N and last M lines', () => {
      const lines = Array.from({ length: 500 }, (_, i) => `line${i}`);
      const content = lines.join('\n');
      const result = OutputLimiter.truncateLogOutput(content, 100000, 5, 5);
      expect(result).toContain('line0');
      expect(result).toContain('line4');
      expect(result).toContain('line499');
      expect(result).toContain('line495');
      expect(result).toContain('[Truncated:');
      expect(result).toContain('lines omitted');
    });

    it('uses default headLines=50 and tailLines=100', () => {
      const lines = Array.from({ length: 300 }, (_, i) => `line${i}`);
      const content = lines.join('\n');
      const result = OutputLimiter.truncateLogOutput(content);
      expect(result).toContain('line0');
      expect(result).toContain('line49');
      expect(result).toContain('line299');
      expect(result).toContain('line200');
      expect(result).toContain('150 lines omitted');
    });

    it('falls back to truncate() if still over maxChars after line truncation', () => {
      const lines = Array.from({ length: 200 }, (_, i) => `${'x'.repeat(500)}-line${i}`);
      const content = lines.join('\n');
      const result = OutputLimiter.truncateLogOutput(content, 5000, 50, 100);
      expect(result.length).toBeLessThanOrEqual(5000);
    });
  });

  describe('truncateJsonSafely', () => {
    it('returns small JSON unchanged', () => {
      const json = JSON.stringify({ a: 1, b: 'hello' });
      expect(OutputLimiter.truncateJsonSafely(json)).toBe(json);
    });

    it('trims large arrays keeping first 3 and last 2', () => {
      const obj = { items: Array.from({ length: 1000 }, (_, i) => ({ id: i })) };
      const json = JSON.stringify(obj);
      const result = OutputLimiter.truncateJsonSafely(json, 5000);
      const parsed = JSON.parse(result);
      expect(parsed.items.length).toBeLessThan(1000);
      expect(parsed.items[0].id).toBe(0);
      expect(parsed.items[1].id).toBe(1);
      expect(parsed.items[2].id).toBe(2);
      const lastItem = parsed.items[parsed.items.length - 1];
      expect(lastItem.id).toBe(999);
    });

    it('truncates large string values with inline marker', () => {
      const obj = { data: 'x'.repeat(5000), meta: 'keep' };
      const result = OutputLimiter.truncateJsonSafely(JSON.stringify(obj), 3000);
      const parsed = JSON.parse(result);
      expect(parsed.meta).toBe('keep');
      expect(parsed.data).toContain('[Truncated:');
      expect(parsed.data.length).toBeLessThan(5000);
    });

    it('falls back to truncate() on invalid JSON input', () => {
      const result = OutputLimiter.truncateJsonSafely('not json at all', 100);
      expect(result.length).toBeLessThanOrEqual(100);
    });

    it('produces valid JSON for all outputs', () => {
      const obj = {
        items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: 'n'.repeat(200) })),
        logs: 'log'.repeat(10000),
      };
      const result = OutputLimiter.truncateJsonSafely(JSON.stringify(obj), 10000);
      expect(() => JSON.parse(result)).not.toThrow();
      expect(result.length).toBeLessThanOrEqual(10000);
    });
  });
});
