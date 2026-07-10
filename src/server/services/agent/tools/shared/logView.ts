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

import { OutputLimiter } from '../outputLimiter';

export const MAX_SEARCH_PATTERN_CHARS = 256;

export function stripAnsiControl(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07]*\x07/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  );
}

export function sanitizeLogText(text: string): string {
  return stripAnsiControl(String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
}

export function deduplicateConsecutiveLines(lines: string[]): string[] {
  const result: string[] = [];
  let lastLine = '';
  let count = 1;
  for (const line of lines) {
    if (line === lastLine) {
      count++;
    } else {
      if (count > 1) result.push(`[repeated ${count}x] ${lastLine}`);
      else if (lastLine) result.push(lastLine);
      lastLine = line;
      count = 1;
    }
  }
  if (count > 1) result.push(`[repeated ${count}x] ${lastLine}`);
  else if (lastLine) result.push(lastLine);
  return result;
}

export type LogSearchView = {
  totalMatches: number;
  renderedMatches: number;
  charCapped: boolean;
  timedOut: boolean;
  scannedLines: number;
  rendered: string;
};

type LineMatch = { index: number; matchStart: number };

const IN_LINE_WINDOW_BEFORE = 150;
const IN_LINE_WINDOW_TOTAL = 1000;

// Matches inside giant lines render a window around the match, not the line head —
// otherwise the hit would be clamped away with the rest of the line.
function formatMatchedLine(line: string, lineNo: number, matchStart: number): string {
  if (line.length <= 1100) return `${lineNo}: ${line}`;
  const from = Math.max(0, matchStart - IN_LINE_WINDOW_BEFORE);
  const to = Math.min(line.length, from + IN_LINE_WINDOW_TOTAL);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < line.length ? '…' : '';
  return `${lineNo}: [chars ${from + 1}–${to} of ${line.length}] ${prefix}${line.slice(from, to)}${suffix}`;
}

export function searchLogLines(
  lines: string[],
  pattern: string,
  opts: { maxMatches?: number; contextLines?: number; maxChars?: number; timeBoxMs?: number } = {}
): LogSearchView {
  if (pattern.length > MAX_SEARCH_PATTERN_CHARS) {
    throw new Error(`search pattern too long (max ${MAX_SEARCH_PATTERN_CHARS} chars)`);
  }
  const re = new RegExp(pattern, 'i');
  const { maxMatches = 50, contextLines = 2, maxChars = 26000, timeBoxMs = 2000 } = opts;

  const deadline = Date.now() + timeBoxMs;
  const kept: LineMatch[] = [];
  let totalMatches = 0;
  let timedOut = false;
  let scannedLines = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if ((i & 1023) === 0 && Date.now() > deadline) {
      timedOut = true;
      scannedLines = i;
      break;
    }
    const m = re.exec(lines[i]);
    if (m) {
      totalMatches++;
      if (kept.length < maxMatches) kept.push({ index: i, matchStart: m.index });
    }
  }

  const matchByLine = new Map<number, LineMatch>();
  const renderIndices: number[] = [];
  const seen = new Set<number>();
  for (const match of kept) {
    matchByLine.set(match.index, match);
    const from = Math.max(0, match.index - contextLines);
    const to = Math.min(lines.length - 1, match.index + contextLines);
    for (let i = from; i <= to; i++) {
      if (!seen.has(i)) {
        seen.add(i);
        renderIndices.push(i);
      }
    }
  }
  renderIndices.sort((a, b) => a - b);

  const out: string[] = [];
  let chars = 0;
  let charCapped = false;
  let renderedMatches = 0;
  let prev = -2;
  for (const i of renderIndices) {
    const match = matchByLine.get(i);
    const text = match
      ? formatMatchedLine(lines[i], i + 1, match.matchStart)
      : `${i + 1}- ${OutputLimiter.clampLogLine(lines[i])}`;
    const separator = prev >= 0 && i > prev + 1 ? '--\n' : '';
    if (chars + separator.length + text.length + 1 > maxChars) {
      charCapped = true;
      break;
    }
    if (separator) out.push('--');
    out.push(text);
    chars += separator.length + text.length + 1;
    if (match) renderedMatches++;
    prev = i;
  }

  return { totalMatches, renderedMatches, charCapped, timedOut, scannedLines, rendered: out.join('\n') };
}

export type LogWindowView = {
  rendered: string;
  startLine: number;
  endLine: number;
  charCapped: boolean;
};

export function renderLogWindow(
  lines: string[],
  startLine: number,
  maxLines: number,
  maxChars: number = 28000
): LogWindowView {
  const start = Math.min(Math.max(1, Math.floor(startLine)), Math.max(1, lines.length));
  const end = Math.min(lines.length, start + Math.max(1, Math.floor(maxLines)) - 1);

  const out: string[] = [];
  let chars = 0;
  let last = start - 1;
  let charCapped = false;
  for (let n = start; n <= end; n++) {
    const text = `${n}: ${OutputLimiter.clampLogLine(lines[n - 1])}`;
    if (chars + text.length + 1 > maxChars) {
      charCapped = true;
      break;
    }
    out.push(text);
    chars += text.length + 1;
    last = n;
  }

  return { rendered: out.join('\n'), startLine: start, endLine: last, charCapped };
}
