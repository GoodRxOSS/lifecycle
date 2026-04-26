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

import AgentMessage from 'server/models/AgentMessage';
import AgentThread from 'server/models/AgentThread';

describe('Agent model validation', () => {
  test('allows default thread records to validate without an app-supplied uuid', () => {
    expect(() =>
      AgentThread.fromJson({
        sessionId: 42,
        metadata: {},
      })
    ).not.toThrow();
  });

  test('allows canonical messages without a uiMessage projection', () => {
    expect(() =>
      AgentMessage.fromJson({
        threadId: 42,
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
        metadata: {},
      })
    ).not.toThrow();
  });
});
