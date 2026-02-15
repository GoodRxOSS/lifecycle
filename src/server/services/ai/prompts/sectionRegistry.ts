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

import { FOUNDATIONS_SECTION, INVESTIGATION_SECTION, REFERENCE_SECTION, SAFETY_SECTION } from './sections';

export interface PromptSection {
  id: string;
  content: string;
  order: number;
  rationale: string;
}

export const PROMPT_SECTIONS: PromptSection[] = [
  {
    id: 'reference',
    content: REFERENCE_SECTION,
    order: 1,
    rationale:
      'Domain knowledge first — long-context research shows 30% improvement when reference data precedes instructions',
  },
  {
    id: 'foundations',
    content: FOUNDATIONS_SECTION,
    order: 2,
    rationale: 'Agent identity, communication style, and constraints after domain context is established',
  },
  {
    id: 'investigation',
    content: INVESTIGATION_SECTION,
    order: 3,
    rationale: 'Investigation methodology, output format, and examples define operational patterns',
  },
  {
    id: 'safety',
    content: SAFETY_SECTION,
    order: 4,
    rationale: 'Safety rules positioned LAST for recency bias advantage',
  },
];

export function assembleBasePrompt(excludeIds: string[] = []): string {
  return PROMPT_SECTIONS.slice()
    .sort((a, b) => a.order - b.order)
    .filter((s) => s.id !== 'safety' && !excludeIds.includes(s.id))
    .map((s) => s.content)
    .join('\n\n');
}
