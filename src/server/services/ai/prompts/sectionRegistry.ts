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

import { CORE_SECTION, WORKFLOW_SECTION, DOMAIN_SECTION, EXAMPLES_SECTION, SAFETY_SECTION } from './sections';

export interface PromptSection {
  id: string;
  content: string;
  order: number;
  rationale: string;
}

export const PROMPT_SECTIONS: PromptSection[] = [
  {
    id: 'core',
    content: CORE_SECTION,
    order: 1,
    rationale: 'Agent identity, communication style, and tool usage rules establish behavioral frame',
  },
  {
    id: 'workflow',
    content: WORKFLOW_SECTION,
    order: 2,
    rationale: 'Investigation, debug, fix workflows and output format define operational patterns',
  },
  {
    id: 'domain',
    content: DOMAIN_SECTION,
    order: 3,
    rationale: 'Configuration architecture and domain knowledge provide reference material',
  },
  {
    id: 'examples',
    content: EXAMPLES_SECTION,
    order: 4,
    rationale: 'Concrete examples reinforce patterns before safety rules',
  },
  {
    id: 'safety',
    content: SAFETY_SECTION,
    order: 5,
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
