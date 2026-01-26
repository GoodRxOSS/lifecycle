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

import { ToolRegistry } from '../registry';
import { Tool, ToolSafetyLevel, ToolCategory } from '../../types/tool';

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

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('register() adds tool and get() returns it', () => {
    const tool = makeTool();
    registry.register(tool);
    expect(registry.get('test_tool')).toBe(tool);
  });

  it('register() throws if duplicate name', () => {
    registry.register(makeTool());
    expect(() => registry.register(makeTool())).toThrow('Tool test_tool already registered');
  });

  it('registerMultiple() registers array of tools', () => {
    const tools = [makeTool({ name: 'a' }), makeTool({ name: 'b' })];
    registry.registerMultiple(tools);
    expect(registry.getAll()).toHaveLength(2);
  });

  it('unregister() removes tool', () => {
    registry.register(makeTool());
    registry.unregister('test_tool');
    expect(registry.get('test_tool')).toBeUndefined();
  });

  it('get() returns undefined for unknown tool', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('getAll() returns all registered tools', () => {
    registry.register(makeTool({ name: 'a' }));
    registry.register(makeTool({ name: 'b' }));
    expect(registry.getAll()).toHaveLength(2);
  });

  it('getByCategory() returns only matching tools', () => {
    registry.register(makeTool({ name: 'k8s_tool', category: 'k8s' }));
    registry.register(makeTool({ name: 'gh_tool', category: 'github' }));
    const k8s = registry.getByCategory('k8s');
    expect(k8s).toHaveLength(1);
    expect(k8s[0].name).toBe('k8s_tool');
  });

  it('getByCategory() returns empty array for category with no tools', () => {
    expect(registry.getByCategory('github')).toEqual([]);
  });

  it('getFiltered() filters by custom predicate', () => {
    registry.register(makeTool({ name: 'safe', safetyLevel: ToolSafetyLevel.SAFE }));
    registry.register(makeTool({ name: 'danger', safetyLevel: ToolSafetyLevel.DANGEROUS }));
    const dangerous = registry.getFiltered((t) => t.safetyLevel === ToolSafetyLevel.DANGEROUS);
    expect(dangerous).toHaveLength(1);
    expect(dangerous[0].name).toBe('danger');
  });

  it('execute() calls tool.execute with args and signal', async () => {
    const tool = makeTool();
    registry.register(tool);
    const signal = new AbortController().signal;
    const result = await registry.execute('test_tool', { foo: 'bar' }, signal);
    expect(result.success).toBe(true);
    expect(tool.execute).toHaveBeenCalledWith({ foo: 'bar' }, signal);
  });

  it('execute() returns TOOL_NOT_FOUND for unknown tool', async () => {
    const result = await registry.execute('unknown', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TOOL_NOT_FOUND');
  });

  it('execute() catches thrown error and returns TOOL_EXECUTION_ERROR', async () => {
    const tool = makeTool({
      execute: jest.fn().mockRejectedValue(new Error('boom')),
    });
    registry.register(tool);
    const result = await registry.execute('test_tool', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TOOL_EXECUTION_ERROR');
    expect(result.error?.recoverable).toBe(true);
  });
});
