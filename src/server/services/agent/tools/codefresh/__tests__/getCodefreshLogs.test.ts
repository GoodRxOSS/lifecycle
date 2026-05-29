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

const mockGetLogsResult = jest.fn();
jest.mock('server/lib/codefresh', () => ({
  getLogsResult: (...args: any[]) => mockGetLogsResult(...args),
}));

import { GetCodefreshLogsTool } from '../getCodefreshLogs';

describe('GetCodefreshLogsTool', () => {
  let tool: GetCodefreshLogsTool;

  beforeEach(() => {
    jest.clearAllMocks();
    tool = new GetCodefreshLogsTool();
  });

  it('returns logs on a successful fetch', async () => {
    mockGetLogsResult.mockResolvedValue({ ok: true, output: 'line1\nline2\nline3' });
    const result = await tool.execute({ pipeline_id: 'abc123' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent as string);
    expect(data.logs).toContain('line1');
    expect(data.totalLines).toBe(3);
  });

  it('reports LOGS_UNAVAILABLE (retryable) when fetch fails', async () => {
    mockGetLogsResult.mockResolvedValue({ ok: false, reason: 'codefresh logs: not found' });
    const result = await tool.execute({ pipeline_id: 'badid' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('LOGS_UNAVAILABLE');
    expect(result.error?.recoverable).toBe(true);
    expect(result.error?.message).toContain('badid');
    expect(result.error?.message).toContain('do NOT assume the build is clean');
  });

  it('reports LOGS_UNAVAILABLE when fetch succeeds but logs are empty/whitespace', async () => {
    mockGetLogsResult.mockResolvedValue({ ok: true, output: '   \n\n  \t ' });
    const result = await tool.execute({ pipeline_id: 'emptybuild' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('LOGS_UNAVAILABLE');
    expect(result.error?.recoverable).toBe(true);
  });

  it('requires a pipeline_id', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETERS');
    expect(mockGetLogsResult).not.toHaveBeenCalled();
  });
});
