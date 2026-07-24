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

const DEFAULT_MAX_CHARS = 30000;
const MARKER_RESERVE = 200;

const MAX_LOG_LINE_CHARS = 1000;
// Lines between the clamp target and this threshold pass through, so already-clamped
// lines (target + marker) are stable on re-entry.
const LOG_LINE_CLAMP_THRESHOLD = 1100;

// Signals that usually carry the actual failure in long logs.
const ERROR_SIGNAL_RE =
  /\b(error|fatal|exception|panic|traceback|failed|cannot|denied|segfault|oom(killed)?|exit code|stack trace|unhandled)\b/i;
const ERROR_WINDOW = 20; // lines retained around the last error signal

function makeMarker(kept: number, total: number): string {
  return `\n[Truncated: showing ${kept} of ${total} chars — use tighter filters to get specific data]`;
}

function isJsonString(s: string): boolean {
  const trimmed = s.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

export class OutputLimiter {
  static clampLogLine(line: string): string {
    if (line.length <= LOG_LINE_CLAMP_THRESHOLD) return line;
    return `${line.slice(0, MAX_LOG_LINE_CHARS)}… [+${line.length - MAX_LOG_LINE_CHARS} more chars]`;
  }

  // Tail-keeping truncation for log content, where the failure usually sits at the end.
  static truncateTail(content: string, maxChars: number = DEFAULT_MAX_CHARS): string {
    if (content.length <= maxChars) return content;
    const marker = `[Truncated: showing last ${maxChars - MARKER_RESERVE} of ${content.length} chars]\n`;
    const kept = maxChars - marker.length;
    return marker + content.slice(-kept);
  }

  static truncate(content: string, maxChars: number = DEFAULT_MAX_CHARS): string {
    if (content.length <= maxChars) return content;

    if (isJsonString(content)) {
      try {
        const parsed = JSON.parse(content);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          return OutputLimiter.truncateJsonObject(parsed, maxChars);
        }
      } catch {
        // fall through to plain text
      }
    }

    const marker = makeMarker(maxChars - MARKER_RESERVE, content.length);
    const kept = maxChars - marker.length;
    return content.slice(0, kept) + marker;
  }

  private static truncateJsonObject(obj: Record<string, unknown>, maxChars: number): string {
    const fields = Object.keys(obj).map((key) => ({
      key,
      size: JSON.stringify(obj[key]).length,
    }));
    fields.sort((a, b) => b.size - a.size);

    const result = { ...obj };
    let serialized = JSON.stringify(result);

    for (const field of fields) {
      if (serialized.length <= maxChars) break;
      const val = result[field.key];
      if (typeof val === 'string' && val.length > 200) {
        const overage = serialized.length - maxChars;
        const targetLen = Math.max(100, val.length - overage - MARKER_RESERVE);
        const marker = makeMarker(targetLen, val.length);
        result[field.key] = val.slice(0, targetLen) + marker;
        serialized = JSON.stringify(result);
      } else if (Array.isArray(val) && val.length > 5) {
        const kept = [...val.slice(0, 3), ...val.slice(-2)];
        result[field.key] = kept;
        serialized = JSON.stringify(result);
      }
    }

    if (serialized.length > maxChars) {
      const marker = makeMarker(maxChars - MARKER_RESERVE, serialized.length);
      return serialized.slice(0, maxChars - marker.length) + marker;
    }

    return serialized;
  }

  static truncateLogOutput(
    content: string,
    maxChars: number = DEFAULT_MAX_CHARS,
    headLines: number = 50,
    tailLines: number = 100,
    // Retain a window around the last error signal in the dropped middle.
    retainErrorRegion: boolean = true
  ): string {
    const lines = content.split('\n').map(OutputLimiter.clampLogLine);
    if (lines.length <= headLines + tailLines) {
      const joined = lines.join('\n');
      if (joined.length <= maxChars) return joined;
      return OutputLimiter.truncateTail(joined, maxChars);
    }

    const headEnd = headLines;
    const tailStart = lines.length - tailLines;

    // Find the last error-signal line that falls in the omitted middle.
    let errorIdx = -1;
    if (retainErrorRegion) {
      for (let i = tailStart - 1; i >= headEnd; i--) {
        if (ERROR_SIGNAL_RE.test(lines[i])) {
          errorIdx = i;
          break;
        }
      }
    }

    if (errorIdx === -1) {
      const head = lines.slice(0, headLines);
      const tail = lines.slice(-tailLines);
      const omitted = lines.length - headLines - tailLines;
      const marker = `\n... [Truncated: ${omitted} lines omitted of ${lines.length} total] ...\n`;
      const result = head.join('\n') + marker + tail.join('\n');
      return result.length > maxChars ? OutputLimiter.truncateTail(result, maxChars) : result;
    }

    return OutputLimiter.buildWithErrorRegion(lines, headLines, tailLines, errorIdx, maxChars);
  }

  // Splice an error-region window between head and tail, trimming head/tail to stay under the cap.
  private static buildWithErrorRegion(
    lines: string[],
    headLines: number,
    tailLines: number,
    errorIdx: number,
    maxChars: number
  ): string {
    const half = Math.floor(ERROR_WINDOW / 2);
    const total = lines.length;

    const render = (h: number, t: number): string => {
      const errStart = Math.max(h, errorIdx - half);
      const errEnd = Math.min(total - t, errorIdx + half + 1);
      const head = lines.slice(0, h);
      const errRegion = lines.slice(errStart, errEnd);
      const tail = lines.slice(total - t);

      const headOmitted = errStart - h;
      const tailOmitted = total - t - errEnd;
      const errMarker = `\n... [retained error region — ${errRegion.length} lines around last error signal] ...\n`;
      const parts = [head.join('\n')];
      if (headOmitted > 0) parts.push(`\n... [Truncated: ${headOmitted} lines omitted] ...`);
      parts.push(errMarker + errRegion.join('\n'));
      if (tailOmitted > 0) parts.push(`\n... [Truncated: ${tailOmitted} lines omitted] ...\n`);
      else parts.push('\n');
      parts.push(tail.join('\n'));
      return parts.join('');
    };

    let h = headLines;
    let t = tailLines;
    let result = render(h, t);
    // Trim head/tail proportionally until under the cap (error region is never dropped).
    while (result.length > maxChars && (h > 0 || t > 0)) {
      h = h > 5 ? Math.max(5, h - Math.ceil(h * 0.25)) : 0;
      t = t > 5 ? Math.max(5, t - Math.ceil(t * 0.25)) : 0;
      result = render(h, t);
    }

    return result.length > maxChars ? OutputLimiter.truncateTail(result, maxChars) : result;
  }

  static truncateJsonSafely(jsonString: string, maxChars: number = DEFAULT_MAX_CHARS): string {
    if (jsonString.length <= maxChars) return jsonString;

    try {
      const parsed = JSON.parse(jsonString);
      if (typeof parsed !== 'object' || parsed === null) {
        return OutputLimiter.truncate(jsonString, maxChars);
      }

      const result = OutputLimiter.walkAndTruncate(parsed, maxChars);
      let serialized = JSON.stringify(result);

      if (serialized.length > maxChars) {
        return OutputLimiter.truncate(serialized, maxChars);
      }

      JSON.parse(serialized);
      return serialized;
    } catch {
      return OutputLimiter.truncate(jsonString, maxChars);
    }
  }

  private static walkAndTruncate(obj: unknown, budget: number): unknown {
    if (obj === null || typeof obj !== 'object') {
      if (typeof obj === 'string' && obj.length > 1000) {
        const targetLen = Math.min(obj.length, 500);
        const marker = makeMarker(targetLen, obj.length);
        return obj.slice(0, targetLen) + marker;
      }
      return obj;
    }

    if (Array.isArray(obj)) {
      const serializedLen = JSON.stringify(obj).length;
      if (serializedLen > budget && obj.length > 5) {
        const first3 = obj.slice(0, 3).map((item) => OutputLimiter.walkAndTruncate(item, budget));
        const last2 = obj.slice(-2).map((item) => OutputLimiter.walkAndTruncate(item, budget));
        return [...first3, { _truncated: `${obj.length - 5} items omitted` }, ...last2];
      }
      return obj.map((item) => OutputLimiter.walkAndTruncate(item, budget));
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = OutputLimiter.walkAndTruncate(val, budget);
    }
    return result;
  }
}
