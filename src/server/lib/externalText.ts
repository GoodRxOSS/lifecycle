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

import { scrubSecretsFromText } from 'server/lib/secretScrub';
import { stripAnsiControl } from 'server/services/agent/tools/shared/logView';

function clampUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) {
    return text;
  }
  let end = Math.max(0, Math.trunc(maxBytes));
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
}

export function redactExternalText(value: unknown, maxBytes = 16 * 1024): string {
  const normalized = stripAnsiControl(
    String(value ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
  );
  return clampUtf8(scrubSecretsFromText(normalized), maxBytes);
}
