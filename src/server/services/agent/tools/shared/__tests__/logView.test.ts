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

import {
  deduplicateConsecutiveLines,
  renderLogWindow,
  sanitizeLogText,
  searchLogLines,
  stripAnsiControl,
} from '../logView';

describe('sanitizeLogText', () => {
  it('normalizes CRLF/CR and strips ANSI escapes', () => {
    expect(sanitizeLogText('a\r\nb\rc')).toBe('a\nb\nc');
    expect(stripAnsiControl('\x1b[31mred\x1b[0m plain')).toBe('red plain');
  });
});

describe('deduplicateConsecutiveLines', () => {
  it('collapses runs of identical lines with a count', () => {
    expect(deduplicateConsecutiveLines(['a', 'a', 'a', 'b'])).toEqual(['[repeated 3x] a', 'b']);
  });
});

describe('searchLogLines', () => {
  it('is case-insensitive and returns match plus context indices', () => {
    const lines = ['one', 'two', 'ERROR here', 'four', 'five'];
    const view = searchLogLines(lines, 'error');
    expect(view.totalMatches).toBe(1);
    expect(view.rendered).toContain('3: ERROR here');
    expect(view.rendered).toContain('1- one');
    expect(view.rendered).toContain('5- five');
  });

  it('separates non-adjacent match blocks with --', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    lines[10] = 'boom first';
    lines[90] = 'boom second';
    const view = searchLogLines(lines, 'boom');
    expect(view.totalMatches).toBe(2);
    expect(view.rendered).toContain('--');
    expect(view.rendered).toContain('11: boom first');
    expect(view.rendered).toContain('91: boom second');
  });

  it('does not duplicate lines when match contexts overlap', () => {
    const lines = ['a', 'hit one', 'hit two', 'b'];
    const view = searchLogLines(lines, 'hit');
    const occurrences = view.rendered.split('\n').filter((l) => l.includes('hit one'));
    expect(occurrences).toHaveLength(1);
    expect(view.rendered).toContain('2: hit one');
    expect(view.rendered).toContain('3: hit two');
  });

  it('caps rendered matches at maxMatches but counts all', () => {
    const lines = Array.from({ length: 300 }, () => 'fail again');
    const view = searchLogLines(lines, 'fail', { maxMatches: 5 });
    expect(view.totalMatches).toBe(300);
    expect(view.renderedMatches).toBe(5);
  });

  it('respects the char cap', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `failure ${i} ${'x'.repeat(500)}`);
    const view = searchLogLines(lines, 'failure', { maxChars: 3000 });
    expect(view.charCapped).toBe(true);
    expect(view.rendered.length).toBeLessThanOrEqual(3000);
    expect(view.renderedMatches).toBeGreaterThan(0);
  });

  it('windows into a giant line around the match position', () => {
    const giant = `${'a'.repeat(50000)}NEEDLE${'b'.repeat(50000)}`;
    const view = searchLogLines(['before', giant, 'after'], 'NEEDLE');
    expect(view.totalMatches).toBe(1);
    expect(view.rendered).toContain('NEEDLE');
    expect(view.rendered).toContain('of 100006]');
    expect(view.rendered.length).toBeLessThan(5000);
  });

  it('throws on an invalid or oversized pattern', () => {
    expect(() => searchLogLines(['a'], '([')).toThrow();
    expect(() => searchLogLines(['a'], 'x'.repeat(300))).toThrow('too long');
  });
});

describe('renderLogWindow', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);

  it('returns the requested 1-based window with line numbers', () => {
    const view = renderLogWindow(lines, 10, 3);
    expect(view.startLine).toBe(10);
    expect(view.endLine).toBe(12);
    expect(view.rendered).toBe('10: line 10\n11: line 11\n12: line 12');
  });

  it('clamps start beyond the end to the last line', () => {
    const view = renderLogWindow(lines, 999, 5);
    expect(view.startLine).toBe(50);
    expect(view.rendered).toBe('50: line 50');
  });

  it('stops at the char cap and reports how far it got', () => {
    const bigLines = Array.from({ length: 100 }, (_, i) => `${'y'.repeat(800)} ${i}`);
    const view = renderLogWindow(bigLines, 1, 100, 2000);
    expect(view.charCapped).toBe(true);
    expect(view.endLine).toBeLessThan(100);
    expect(view.rendered.length).toBeLessThanOrEqual(2000);
  });

  it('clamps giant lines inside the window', () => {
    const view = renderLogWindow([`start ${'z'.repeat(9000)}`], 1, 1);
    expect(view.rendered).toContain('more chars]');
    expect(view.rendered.length).toBeLessThan(1200);
  });
});
