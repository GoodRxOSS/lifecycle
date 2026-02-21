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

import { buildClaudeExecScript } from '../execProxy';

describe('execProxy', () => {
  describe('buildClaudeExecScript', () => {
    it('does not add a system prompt flag when one is not configured', () => {
      const script = buildClaudeExecScript('claude-sonnet-4-6');

      expect(script).toContain("exec claude -p --model 'claude-sonnet-4-6'");
      expect(script).not.toContain('--append-system-prompt');
    });

    it('adds the configured system prompt flag when provided', () => {
      const script = buildClaudeExecScript('claude-sonnet-4-6', 'Follow the repository instructions.');

      expect(script).toContain("--append-system-prompt 'Follow the repository instructions.'");
    });

    it('shell-escapes single quotes in the configured system prompt', () => {
      const script = buildClaudeExecScript('claude-sonnet-4-6', "Use repo's style guide.");

      expect(script).toContain("--append-system-prompt 'Use repo'\"'\"'s style guide.'");
    });
  });
});
