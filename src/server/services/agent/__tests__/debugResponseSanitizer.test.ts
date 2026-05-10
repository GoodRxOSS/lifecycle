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
  assistantRunHasText,
  sanitizeDebugRepairAssistantMessages,
  sanitizeDebugRepairAssistantText,
} from '../debugResponseSanitizer';
import type { AgentUIMessage } from '../types';

describe('debugResponseSanitizer', () => {
  it('removes unsupported post-repair monitoring promises and Observe action text', () => {
    const text = [
      'Repair Summary',
      'Change: Updated lifecycle.yaml.',
      'I will continue to monitor the build to ensure it completes successfully.',
      '',
      'Next choices:',
      '',
      'Observe: Wait for the build and deployment to complete.',
      '- **Observe**: Wait for the build and deployment to complete.',
      'Investigate more: Check the progress of the new build logs.',
    ].join('\n');

    expect(sanitizeDebugRepairAssistantText(text)).toBe(
      [
        'Repair Summary',
        'Change: Updated lifecycle.yaml.',
        '',
        'Next choices:',
        '',
        'Investigate more: Check the progress of the new build logs.',
      ].join('\n')
    );
  });

  it('sanitizes assistant text after the latest user message before final run metadata is applied', () => {
    const messages: AgentUIMessage[] = [
      {
        id: 'assistant-history',
        role: 'assistant',
        metadata: { runId: 'run-history' },
        parts: [
          {
            type: 'text',
            text: 'Observe: Historical text should remain untouched.',
          },
        ],
      } as AgentUIMessage,
      {
        id: 'user-active',
        role: 'user',
        parts: [{ type: 'text', text: 'Please repair the issue.' }],
      } as AgentUIMessage,
      {
        id: 'assistant-active',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text: 'I will continue to monitor the build.\nObserve: Wait for the build.',
          },
        ],
      } as AgentUIMessage,
    ];

    const sanitized = sanitizeDebugRepairAssistantMessages(messages, 'run-active');

    expect((sanitized[0].parts[0] as { text?: string }).text).toBe('Observe: Historical text should remain untouched.');
    expect((sanitized[2].parts[0] as { text?: string }).text).toBe('');
  });

  it('detects when the current assistant message already contains appended repair observation text', () => {
    const messages: AgentUIMessage[] = [
      {
        id: 'assistant-active',
        role: 'assistant',
        metadata: { runId: 'run-active' },
        parts: [
          {
            type: 'text',
            text: 'Repair Summary\n\nCommit: https://github.com/example-org/example-repo/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa. Fresh Lifecycle state: Lifecycle picked up the repair commit.',
          },
        ],
      } as AgentUIMessage,
    ];

    expect(
      assistantRunHasText(
        messages,
        'run-active',
        'Commit: https://github.com/example-org/example-repo/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa. Fresh Lifecycle state: Lifecycle picked up the repair commit.'
      )
    ).toBe(true);
    expect(assistantRunHasText(messages, 'run-other', 'Fresh Lifecycle state')).toBe(false);
  });
});
