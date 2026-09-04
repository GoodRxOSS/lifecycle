/**
 * Copyright 2026 Lifecycle contributors
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

const mockRenderCurrentState = jest.fn();

jest.mock('server/services/agent/EnvironmentStateService', () => ({
  __esModule: true,
  default: {
    renderCurrentState: (...args: unknown[]) => mockRenderCurrentState(...args),
  },
}));

import { GetEnvironmentStatusTool } from '../getEnvironmentStatus';

describe('GetEnvironmentStatusTool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('declares a parameterless, session-scoped environment-state tool', () => {
    const tool = new GetEnvironmentStatusTool();

    expect(tool.name).toBe('get_environment_status');
    expect(tool.description).toContain('CURRENT state of THIS environment');
    expect(tool.parameters).toEqual({ type: 'object', properties: {}, required: [] });
  });

  it('stops before state lookup when execution is cancelled', async () => {
    const tool = new GetEnvironmentStatusTool();
    tool.setSessionContext({ sessionDbId: 17, buildUuid: 'build-1' });
    const controller = new AbortController();
    controller.abort();

    await expect(tool.execute({}, controller.signal)).resolves.toMatchObject({
      success: false,
      error: { code: 'CANCELLED', message: 'Operation cancelled' },
    });
    expect(mockRenderCurrentState).not.toHaveBeenCalled();
  });

  it('fails closed when no build context has been attached', async () => {
    const tool = new GetEnvironmentStatusTool();
    tool.setSessionContext(null);

    await expect(tool.execute({})).resolves.toMatchObject({
      success: false,
      error: {
        code: 'NO_BUILD_CONTEXT',
        message: 'Environment status is unavailable: no build is attached to this session.',
      },
    });
    expect(mockRenderCurrentState).not.toHaveBeenCalled();
  });

  it('renders the attached session state and bounds oversized output', async () => {
    const context = { sessionDbId: 17, namespace: 'preview-1', buildUuid: 'build-1' };
    const block = `state-start\n${'x'.repeat(21_000)}\nstate-end`;
    mockRenderCurrentState.mockResolvedValue(block);
    const tool = new GetEnvironmentStatusTool();
    tool.setSessionContext(context);

    const result = await tool.execute({});

    expect(mockRenderCurrentState).toHaveBeenCalledWith(context);
    expect(result).toMatchObject({
      success: true,
      displayContent: { type: 'text', content: 'Fetched current environment state' },
    });
    expect(result.agentContent).toContain('state-start');
    expect(result.agentContent).toContain('[Truncated: showing');
    expect(result.agentContent.length).toBeLessThanOrEqual(20_000);
  });

  it.each([
    [new Error('database unavailable'), 'database unavailable'],
    [null, 'Failed to fetch environment state'],
  ])('returns actionable fallback guidance when state rendering fails', async (failure, message) => {
    mockRenderCurrentState.mockRejectedValue(failure);
    const tool = new GetEnvironmentStatusTool();
    tool.setSessionContext({ sessionDbId: 17, buildUuid: 'build-1' });

    await expect(tool.execute({})).resolves.toMatchObject({
      success: false,
      error: {
        code: 'EXECUTION_ERROR',
        message: `${message} — fall back to query_database for build/deploy rows.`,
      },
    });
  });
});
