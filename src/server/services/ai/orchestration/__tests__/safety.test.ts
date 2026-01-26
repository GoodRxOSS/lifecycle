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

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('server/lib/logger', () => ({
  getLogger: () => mockLogger,
}));

import { ToolSafetyManager } from '../safety';
import { Tool, ToolSafetyLevel, ToolCategory, ConfirmationDetails } from '../../types/tool';
import { StreamCallbacks } from '../../types/stream';

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'test_tool',
    description: 'test',
    parameters: { type: 'object' },
    safetyLevel: ToolSafetyLevel.SAFE,
    category: 'k8s' as ToolCategory,
    execute: jest.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

const confirmDetails: ConfirmationDetails = {
  title: 'Confirm',
  description: 'Are you sure?',
  impact: 'high',
  confirmButtonText: 'Yes',
};

function makeCallbacks(overrides: Partial<StreamCallbacks> = {}): StreamCallbacks {
  return {
    onToolConfirmation: jest.fn().mockResolvedValue(true),
    ...overrides,
  } as StreamCallbacks;
}

describe('ToolSafetyManager', () => {
  let manager: ToolSafetyManager;

  beforeEach(() => {
    manager = new ToolSafetyManager(true);
    jest.clearAllMocks();
  });

  describe('argument validation', () => {
    it('returns INVALID_ARGUMENTS when args do not match schema', async () => {
      const tool = makeTool({
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      });
      const result = await manager.safeExecute(tool, {}, makeCallbacks());
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_ARGUMENTS');
    });

    it('passes validation when args match schema', async () => {
      const tool = makeTool({
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      });
      const result = await manager.safeExecute(tool, { name: 'hello' }, makeCallbacks());
      expect(result.success).toBe(true);
    });
  });

  describe('confirmation gating', () => {
    it('SAFE tool executes without confirmation', async () => {
      const callbacks = makeCallbacks();
      const tool = makeTool({ safetyLevel: ToolSafetyLevel.SAFE });
      await manager.safeExecute(tool, {}, callbacks);
      expect(callbacks.onToolConfirmation).not.toHaveBeenCalled();
    });

    it('DANGEROUS tool triggers confirmation callback', async () => {
      const callbacks = makeCallbacks();
      const tool = makeTool({
        safetyLevel: ToolSafetyLevel.DANGEROUS,
        shouldConfirmExecution: jest.fn().mockResolvedValue(confirmDetails),
      });
      await manager.safeExecute(tool, {}, callbacks);
      expect(callbacks.onToolConfirmation).toHaveBeenCalledWith(confirmDetails);
    });

    it('CAUTIOUS tool triggers confirmation callback', async () => {
      const callbacks = makeCallbacks();
      const tool = makeTool({
        safetyLevel: ToolSafetyLevel.CAUTIOUS,
        shouldConfirmExecution: jest.fn().mockResolvedValue(confirmDetails),
      });
      await manager.safeExecute(tool, {}, callbacks);
      expect(callbacks.onToolConfirmation).toHaveBeenCalledWith(confirmDetails);
    });

    it('user cancellation returns USER_CANCELLED error', async () => {
      const callbacks = makeCallbacks({ onToolConfirmation: jest.fn().mockResolvedValue(false) });
      const tool = makeTool({
        safetyLevel: ToolSafetyLevel.DANGEROUS,
        shouldConfirmExecution: jest.fn().mockResolvedValue(confirmDetails),
      });
      const result = await manager.safeExecute(tool, {}, callbacks);
      expect(result.error?.code).toBe('USER_CANCELLED');
    });

    it('missing onToolConfirmation returns NO_CONFIRMATION_HANDLER', async () => {
      const tool = makeTool({
        safetyLevel: ToolSafetyLevel.DANGEROUS,
        shouldConfirmExecution: jest.fn().mockResolvedValue(confirmDetails),
      });
      const result = await manager.safeExecute(tool, {}, {} as StreamCallbacks);
      expect(result.error?.code).toBe('NO_CONFIRMATION_HANDLER');
    });

    it('requireConfirmation=false still requires confirmation for DANGEROUS tool', async () => {
      const noConfirmManager = new ToolSafetyManager(false);
      const callbacks = makeCallbacks();
      const tool = makeTool({
        safetyLevel: ToolSafetyLevel.DANGEROUS,
        shouldConfirmExecution: jest.fn().mockResolvedValue(confirmDetails),
      });
      await noConfirmManager.safeExecute(tool, {}, callbacks);
      expect(callbacks.onToolConfirmation).toHaveBeenCalled();
    });

    it('shouldConfirmExecution returning false skips confirmation', async () => {
      const callbacks = makeCallbacks();
      const tool = makeTool({
        safetyLevel: ToolSafetyLevel.DANGEROUS,
        shouldConfirmExecution: jest.fn().mockResolvedValue(false),
      });
      await manager.safeExecute(tool, {}, callbacks);
      expect(callbacks.onToolConfirmation).not.toHaveBeenCalled();
    });
  });

  describe('execution', () => {
    it('successful execution returns tool result', async () => {
      const tool = makeTool({ execute: jest.fn().mockResolvedValue({ success: true, agentContent: 'done' }) });
      const result = await manager.safeExecute(tool, {}, makeCallbacks());
      expect(result.success).toBe(true);
      expect(result.agentContent).toBe('done');
    });

    it('tool throwing error returns EXECUTION_ERROR with recoverable:true', async () => {
      const tool = makeTool({ execute: jest.fn().mockRejectedValue(new Error('boom')) });
      const result = await manager.safeExecute(tool, {}, makeCallbacks());
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EXECUTION_ERROR');
      expect(result.error?.recoverable).toBe(true);
    });

    it('timeout returns TIMEOUT error', async () => {
      const tool = makeTool({
        execute: jest.fn().mockRejectedValue(new Error('Tool execution timeout')),
      });
      const result = await manager.safeExecute(tool, {}, makeCallbacks());
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TIMEOUT');
      expect(result.error?.recoverable).toBe(true);
    });
  });

  describe('logging', () => {
    it('non-recoverable error logs via logger.error', async () => {
      const tool = makeTool({
        execute: jest.fn().mockResolvedValue({
          success: false,
          error: { message: 'fatal', code: 'FATAL', recoverable: false },
        }),
      });
      await manager.safeExecute(tool, {}, makeCallbacks());
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});
