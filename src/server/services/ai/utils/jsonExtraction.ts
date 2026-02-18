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

import { getLogger } from 'server/lib/logger';

export function extractBalancedJson(str: string, startIndex: number): string | null {
  if (str[startIndex] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < str.length; i++) {
    const ch = str[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return str.substring(startIndex, i + 1);
      }
    }
  }

  return null;
}

export function extractJsonFromResponse(
  aiResponse: string,
  buildUuid: string
): { response: string; isJson: boolean; preamble?: string } {
  if (!aiResponse.includes('"investigation_complete"')) {
    return { response: aiResponse, isJson: false };
  }

  const original = aiResponse.trim();

  let candidate = original;

  const fenceStart = candidate.indexOf('```');
  const hasFence = fenceStart >= 0;
  const preambleBeforeFence = hasFence ? candidate.substring(0, fenceStart).trim() : '';

  candidate = candidate
    .replace(/```(?:json)?\s*\n?/g, '')
    .replace(/\n?\s*```/g, '')
    .trim();

  const jsonIdx = candidate.indexOf('{"type"');
  if (jsonIdx < 0) {
    const braceIdx = candidate.indexOf('{');
    if (braceIdx < 0) return { response: aiResponse, isJson: false };

    const preambleRaw = candidate.substring(0, braceIdx).trim();
    const balanced = extractBalancedJson(candidate, braceIdx);
    if (balanced) {
      try {
        JSON.parse(balanced);
        getLogger().info(`AI: late JSON detection - extracted valid JSON buildUuid=${buildUuid}`);
        return {
          response: balanced,
          isJson: true,
          ...(preambleRaw ? { preamble: preambleRaw } : {}),
        };
      } catch {
        return { response: aiResponse, isJson: false };
      }
    }
    return { response: aiResponse, isJson: false };
  }

  const preambleRaw = hasFence ? preambleBeforeFence : candidate.substring(0, jsonIdx).trim();

  const balanced = extractBalancedJson(candidate, jsonIdx);
  if (balanced) {
    try {
      JSON.parse(balanced);
      getLogger().info(`AI: late JSON detection - extracted valid JSON buildUuid=${buildUuid}`);
      return {
        response: balanced,
        isJson: true,
        ...(preambleRaw ? { preamble: preambleRaw } : {}),
      };
    } catch {
      return { response: aiResponse, isJson: false };
    }
  }

  return { response: aiResponse, isJson: false };
}
