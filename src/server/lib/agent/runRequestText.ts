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

import type { CanonicalAgentRunMessageInput } from 'server/services/agent/canonicalMessages';

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function getRunMessageText(message: CanonicalAgentRunMessageInput): string | null {
  const text = message.parts
    .filter((part): part is Extract<CanonicalAgentRunMessageInput['parts'][number], { type: 'text' }> => {
      return part.type === 'text';
    })
    .map((part) => part.text)
    .join('\n')
    .trim();

  return text || null;
}
