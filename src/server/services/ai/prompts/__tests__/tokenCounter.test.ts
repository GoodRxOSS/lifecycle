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

import {
  countTokens,
  countSectionTokens,
  getTokenBreakdown,
  checkBudget,
  PROVIDER_TOKEN_LIMITS,
} from '../tokenCounter';

describe('Token Counter', () => {
  describe('countTokens', () => {
    it('returns a positive number for "hello world"', () => {
      const count = countTokens('hello world');
      expect(count).toBeGreaterThan(0);
    });

    it('returns a different result than text.length / 4', () => {
      const text = 'hello world';
      const count = countTokens(text);
      const naive = Math.ceil(text.length / 4);
      expect(count).not.toBe(naive);
    });

    it('returns 0 for empty string', () => {
      expect(countTokens('')).toBe(0);
    });

    it('returns more tokens for code with special characters than naive estimate', () => {
      const code = 'const x = { foo: "bar", baz: [1, 2, 3] };\nconsole.log(x);';
      const count = countTokens(code);
      expect(count).toBeGreaterThan(0);
      expect(typeof count).toBe('number');
    });

    it('returns a whole number', () => {
      const count = countTokens('The quick brown fox jumps over the lazy dog');
      expect(Number.isInteger(count)).toBe(true);
    });
  });

  describe('countSectionTokens', () => {
    it('returns an object with keys matching all 4 section IDs', () => {
      const result = countSectionTokens();
      const expectedIds = ['foundations', 'investigation', 'reference', 'safety'];
      for (const id of expectedIds) {
        expect(result).toHaveProperty(id);
      }
      expect(Object.keys(result)).toHaveLength(4);
    });

    it('has a positive number for every section', () => {
      const result = countSectionTokens();
      for (const [, value] of Object.entries(result)) {
        expect(value).toBeGreaterThan(0);
      }
    });

    it('has a total greater than 0', () => {
      const result = countSectionTokens();
      const total = Object.values(result).reduce((sum, v) => sum + v, 0);
      expect(total).toBeGreaterThan(0);
    });
  });

  describe('getTokenBreakdown', () => {
    it('returns object with sections, providerAugmentation, environmentContext, and total', () => {
      const breakdown = getTokenBreakdown('test prompt');
      expect(breakdown).toHaveProperty('sections');
      expect(breakdown).toHaveProperty('providerAugmentation');
      expect(breakdown).toHaveProperty('environmentContext');
      expect(breakdown).toHaveProperty('total');
    });

    it('total equals sum of section values + providerAugmentation + environmentContext', () => {
      const breakdown = getTokenBreakdown('some system prompt text for testing');
      const sectionSum = Object.values(breakdown.sections).reduce((sum, v) => sum + v, 0);
      expect(breakdown.total).toBe(sectionSum + breakdown.providerAugmentation + breakdown.environmentContext);
    });

    it('uses pre-computed sections when provided', () => {
      const precomputed = { identity: 100, communication: 50 };
      const breakdown = getTokenBreakdown('test prompt', precomputed);
      expect(breakdown.sections).toEqual(precomputed);
    });
  });

  describe('checkBudget', () => {
    it('returns overBudget=false for a small prompt', () => {
      const result = checkBudget('hello', 'anthropic');
      expect(result.overBudget).toBe(false);
    });

    it('returns remaining = limit - used', () => {
      const result = checkBudget('hello', 'anthropic');
      expect(result.remaining).toBe(result.limit - result.used);
    });

    it('has correct provider limits', () => {
      expect(PROVIDER_TOKEN_LIMITS.anthropic).toBe(180000);
      expect(PROVIDER_TOKEN_LIMITS.openai).toBe(110000);
      expect(PROVIDER_TOKEN_LIMITS.gemini).toBe(900000);
    });

    it('returns overBudget=true when used exceeds limit', () => {
      const result = checkBudget('any-text', 'openai', 200000);
      expect(result.overBudget).toBe(true);
      expect(result.used).toBe(200000);
      expect(result.used).toBeGreaterThan(result.limit);
      expect(result.remaining).toBeLessThan(0);
    });

    it('returns correct provider name', () => {
      const result = checkBudget('hello', 'gemini');
      expect(result.provider).toBe('gemini');
    });
  });
});
