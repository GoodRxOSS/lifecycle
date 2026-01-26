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

export function extractJsonFromResponse(aiResponse: string, buildUuid: string): { response: string; isJson: boolean } {
  if (!aiResponse.includes('"investigation_complete"')) {
    return { response: aiResponse, isJson: false };
  }

  let candidate = aiResponse.trim();

  if (candidate.startsWith('```')) {
    candidate = candidate
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?\s*```\s*$/, '')
      .trim();
  }

  if (!candidate.startsWith('{')) {
    const jsonIdx = candidate.indexOf('{"type"');
    if (jsonIdx >= 0) candidate = candidate.substring(jsonIdx);
  }

  if (candidate.startsWith('{')) {
    try {
      JSON.parse(candidate);
      getLogger().info(`AI: late JSON detection - extracted valid JSON buildUuid=${buildUuid}`);
      return { response: candidate, isJson: true };
    } catch {
      return { response: aiResponse, isJson: false };
    }
  }

  return { response: aiResponse, isJson: false };
}
