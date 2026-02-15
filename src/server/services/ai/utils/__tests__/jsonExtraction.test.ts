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

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { extractJsonFromResponse, extractBalancedJson } from '../jsonExtraction';

describe('extractBalancedJson', () => {
  it('extracts a simple JSON object', () => {
    const result = extractBalancedJson('{"a": 1}', 0);
    expect(result).toBe('{"a": 1}');
  });

  it('extracts nested JSON objects', () => {
    const input = '{"a": {"b": {"c": 1}}}';
    expect(extractBalancedJson(input, 0)).toBe(input);
  });

  it('extracts JSON starting at an offset', () => {
    const input = 'prefix {"type": "x"} suffix';
    expect(extractBalancedJson(input, 7)).toBe('{"type": "x"}');
  });

  it('handles braces inside strings', () => {
    const input = '{"text": "a { b } c"}';
    expect(extractBalancedJson(input, 0)).toBe(input);
  });

  it('handles escaped quotes in strings', () => {
    const input = '{"text": "say \\"hello\\""}';
    expect(extractBalancedJson(input, 0)).toBe(input);
  });

  it('returns null for non-brace start', () => {
    expect(extractBalancedJson('abc', 0)).toBeNull();
  });

  it('returns null for unbalanced braces', () => {
    expect(extractBalancedJson('{incomplete', 0)).toBeNull();
  });
});

describe('extractJsonFromResponse', () => {
  const buildUuid = 'test-uuid';

  it('returns isJson: false for non-investigation text', () => {
    const result = extractJsonFromResponse('Hello world', buildUuid);
    expect(result).toEqual({ response: 'Hello world', isJson: false });
  });

  it('extracts pure JSON string', () => {
    const json = '{"type": "investigation_complete", "summary": "done"}';
    const result = extractJsonFromResponse(json, buildUuid);
    expect(result.isJson).toBe(true);
    expect(JSON.parse(result.response)).toEqual({ type: 'investigation_complete', summary: 'done' });
  });

  it('extracts fenced JSON (```json)', () => {
    const input = '```json\n{"type": "investigation_complete", "data": []}\n```';
    const result = extractJsonFromResponse(input, buildUuid);
    expect(result.isJson).toBe(true);
    expect(JSON.parse(result.response)).toEqual({ type: 'investigation_complete', data: [] });
  });

  it('extracts preamble text + fenced JSON', () => {
    const input = 'Here are the findings:\n\n```json\n{"type": "investigation_complete", "summary": "ok"}\n```';
    const result = extractJsonFromResponse(input, buildUuid);
    expect(result.isJson).toBe(true);
    expect(JSON.parse(result.response)).toEqual({ type: 'investigation_complete', summary: 'ok' });
  });

  it('extracts preamble text + raw JSON (no fences)', () => {
    const input = 'Analysis complete.\n{"type": "investigation_complete", "items": [1, 2]}';
    const result = extractJsonFromResponse(input, buildUuid);
    expect(result.isJson).toBe(true);
    expect(JSON.parse(result.response)).toEqual({ type: 'investigation_complete', items: [1, 2] });
  });

  it('content field parses with JSON.parse()', () => {
    const json = '{"type": "investigation_complete", "nested": {"a": [1, 2, 3]}}';
    const result = extractJsonFromResponse(json, buildUuid);
    expect(result.isJson).toBe(true);
    const parsed = JSON.parse(result.response);
    expect(parsed.nested.a).toEqual([1, 2, 3]);
  });

  it('handles JSON with trailing text after fence', () => {
    const input = '```json\n{"type": "investigation_complete"}\n```\n\nLet me know if you need more details.';
    const result = extractJsonFromResponse(input, buildUuid);
    expect(result.isJson).toBe(true);
    expect(JSON.parse(result.response)).toEqual({ type: 'investigation_complete' });
  });

  it('returns isJson: false for text mentioning investigation_complete without valid JSON', () => {
    const input = 'The "investigation_complete" status was set but no data found.';
    const result = extractJsonFromResponse(input, buildUuid);
    expect(result.isJson).toBe(false);
  });
});
