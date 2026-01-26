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

import { useMemo } from 'react';
import { parse, STR, OBJ, ARR } from 'partial-json';
import type { StructuredDebugResponse } from '../types';
import { extractJsonContent } from '../utils';

const ALLOW_FLAGS = STR | OBJ | ARR;

interface ProgressiveJsonResult {
  parsed: Partial<StructuredDebugResponse> | null;
  isStructuredStream: boolean;
}

export function useProgressiveJson(content: string, isStreaming: boolean): ProgressiveJsonResult {
  return useMemo(() => {
    if (!isStreaming) return { parsed: null, isStructuredStream: false };

    const jsonContent = extractJsonContent(content);
    if (!jsonContent.startsWith('{')) return { parsed: null, isStructuredStream: false };
    if (!jsonContent.includes('"type"')) return { parsed: null, isStructuredStream: false };

    try {
      const result = parse(jsonContent, ALLOW_FLAGS);
      if (result && typeof result === 'object' && 'type' in result) {
        const typeVal = String(result.type || '');
        if (typeVal === 'investigation_complete' || typeVal.startsWith('investigation')) {
          return {
            parsed: {
              type: 'investigation_complete',
              summary: result.summary || '',
              fixesApplied: result.fixesApplied ?? false,
              services: Array.isArray(result.services) ? result.services : [],
              repository: result.repository,
            },
            isStructuredStream: true,
          };
        }
      }
    } catch {
      // partial-json throws on truly malformed input during early streaming tokens
    }
    return { parsed: null, isStructuredStream: false };
  }, [content, isStreaming]);
}
