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

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockCountTokens = jest.fn();
jest.mock('../../prompts/tokenCounter', () => ({
  countTokens: (...args: any[]) => mockCountTokens(...args),
}));

import { ConversationManager, ConversationState } from '../manager';
import { textMessage } from '../../types/message';

describe('ConversationManager', () => {
  let manager: ConversationManager;

  beforeEach(() => {
    manager = new ConversationManager();
    mockCountTokens.mockReset();
  });

  describe('shouldCompress', () => {
    it('returns false when tokens are below threshold', async () => {
      mockCountTokens.mockResolvedValue(50000);
      const result = await manager.shouldCompress([textMessage('user', 'hi')]);
      expect(result).toBe(false);
    });

    it('returns true when tokens are above threshold', async () => {
      mockCountTokens.mockResolvedValue(90000);
      const result = await manager.shouldCompress([textMessage('user', 'hi')]);
      expect(result).toBe(true);
    });

    it('returns false at exactly the threshold (> not >=)', async () => {
      mockCountTokens.mockResolvedValue(80000);
      const result = await manager.shouldCompress([textMessage('user', 'hi')]);
      expect(result).toBe(false);
    });
  });

  describe('compress', () => {
    it('calls LLM provider and returns parsed ConversationState', async () => {
      const mockState = {
        summary: 'Debugging pod crash',
        identifiedIssues: [{ service: 'web', issue: 'OOM', confidence: 'high' }],
        investigatedServices: ['web'],
        toolsUsed: ['getK8sResources'],
        currentTask: 'Check memory limits',
        tokenCount: 0,
        messageCount: 0,
        compressionLevel: 0,
      };
      const mockProvider = {
        streamCompletion: jest.fn().mockImplementation(async function* () {
          yield { type: 'text', content: JSON.stringify(mockState) };
        }),
      };
      mockCountTokens.mockResolvedValue(500);

      const result = await manager.compress([textMessage('user', 'check pods')], mockProvider as any);

      expect(result.summary).toBe('Debugging pod crash');
      expect(result.tokenCount).toBe(500);
      expect(result.messageCount).toBe(1);
      expect(result.compressionLevel).toBe(1);
    });
  });

  describe('buildPromptFromState', () => {
    it('produces markdown with issues, services, and current task', () => {
      const state: ConversationState = {
        summary: 'Investigating crash loop',
        identifiedIssues: [{ service: 'api', issue: 'OOMKilled', confidence: 'high' }],
        investigatedServices: ['api', 'redis'],
        toolsUsed: ['getK8sResources'],
        currentTask: 'Check resource limits',
        tokenCount: 1000,
        messageCount: 5,
        compressionLevel: 1,
      };

      const prompt = manager.buildPromptFromState(state);

      expect(prompt).toContain('Summary');
      expect(prompt).toContain('Identified Issues');
      expect(prompt).toContain('Already Investigated');
      expect(prompt).toContain('Current Task');
      expect(prompt).toContain('api');
      expect(prompt).toContain('OOMKilled');
    });
  });
});
