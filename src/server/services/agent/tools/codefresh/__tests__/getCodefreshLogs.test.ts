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
import { resetCodefreshLogCacheForTests } from '../logFetchCache';

const PIPELINE_ID = '672ea2c44b9c09ed7c91a8ef';

function okFetch(output: string, truncatedAtSource = false) {
  mockGetLogsResult.mockResolvedValue({ ok: true, output, truncatedAtSource });
}

describe('GetCodefreshLogsTool', () => {
  let tool: GetCodefreshLogsTool;

  beforeEach(() => {
    jest.clearAllMocks();
    resetCodefreshLogCacheForTests();
    tool = new GetCodefreshLogsTool();
  });

  it('returns the tail view on a successful fetch', async () => {
    okFetch('line1\nline2\nline3');
    const result = await tool.execute({ pipeline_id: PIPELINE_ID });
    expect(result.success).toBe(true);
    expect(result.agentContent).toContain(`Codefresh logs for pipeline ${PIPELINE_ID}: 3 lines fetched`);
    expect(result.agentContent).toContain('```\nline1\nline2\nline3\n```');
    expect(result.agentContent).toContain('search="<regex>"');
  });

  it('reports LOGS_UNAVAILABLE (retryable) when fetch fails', async () => {
    mockGetLogsResult.mockResolvedValue({ ok: false, reason: 'codefresh logs: not found' });
    const result = await tool.execute({ pipeline_id: PIPELINE_ID });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('LOGS_UNAVAILABLE');
    expect(result.error?.message).toContain(PIPELINE_ID);
    expect(result.error?.message).toContain('codefresh logs: not found');
    expect(result.error?.message).toContain('do NOT assume the build is clean');
  });

  it('reports LOGS_UNAVAILABLE when fetch succeeds but logs are empty/whitespace', async () => {
    okFetch('   \n\n  \t ');
    const result = await tool.execute({ pipeline_id: PIPELINE_ID });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('LOGS_UNAVAILABLE');
  });

  it('requires a pipeline_id', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETERS');
    expect(mockGetLogsResult).not.toHaveBeenCalled();
  });

  it('rejects a pipeline_id that is not a 24-char hex ObjectId', async () => {
    const result = await tool.execute({ pipeline_id: 'abc123; rm -rf /' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETERS');
    expect(result.error?.message).toContain('24-character hex');
    expect(mockGetLogsResult).not.toHaveBeenCalled();
  });

  it('notes when the source log was truncated at fetch time', async () => {
    okFetch('line1\nline2', true);
    const result = await tool.execute({ pipeline_id: PIPELINE_ID });
    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('exceeded the 24MB fetch cap');
  });

  it('clamps giant lines so the tail view still shows the surrounding lines', async () => {
    const logs = [`giant-start ${'x'.repeat(500000)}`, 'normal line', 'ERROR: build failed at the end'].join('\n');
    okFetch(logs);
    const result = await tool.execute({ pipeline_id: PIPELINE_ID });
    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('more chars]');
    expect(result.agentContent).toContain('ERROR: build failed at the end');
    expect((result.agentContent as string).length).toBeLessThan(35000);
  });

  it('searches the full log and returns absolute line numbers with context', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `build step ${i}`);
    lines[2999] = 'npm ERR! code ELIFECYCLE';
    okFetch(lines.join('\n'));

    const result = await tool.execute({ pipeline_id: PIPELINE_ID, search: 'npm ERR!' });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('1 lines match /npm ERR!/i');
    expect(result.agentContent).toContain('3000: npm ERR! code ELIFECYCLE');
    expect(result.agentContent).toContain('2999- build step 2998');
    expect(result.agentContent).toContain('3001- build step 3000');
  });

  it('search finds a match inside a giant line and windows around it', async () => {
    const giant = `${'a'.repeat(400000)} fatal: out of memory ${'b'.repeat(400000)}`;
    okFetch(`start\n${giant}\nend`);

    const result = await tool.execute({ pipeline_id: PIPELINE_ID, search: 'out of memory' });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('fatal: out of memory');
    expect(result.agentContent).toContain('chars');
    expect((result.agentContent as string).length).toBeLessThan(35000);
  });

  it('says when a search matches nothing', async () => {
    okFetch('line1\nline2');
    const result = await tool.execute({ pipeline_id: PIPELINE_ID, search: 'no-such-thing' });
    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('No lines match /no-such-thing/i');
  });

  it('rejects an invalid search regex with a parse error', async () => {
    okFetch('line1');
    const result = await tool.execute({ pipeline_id: PIPELINE_ID, search: '([' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETERS');
    expect(result.error?.message).toContain('Invalid search pattern');
  });

  it('returns an exact line window for start_line', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `log line ${i + 1}`);
    okFetch(lines.join('\n'));

    const result = await tool.execute({ pipeline_id: PIPELINE_ID, start_line: 500, max_lines: 3 });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('Lines 500–502 of 1000');
    expect(result.agentContent).toContain('500: log line 500');
    expect(result.agentContent).toContain('502: log line 502');
    expect(result.agentContent).not.toContain('503: log line 503');
  });

  it('serves repeat calls for the same pipeline from the cache', async () => {
    okFetch('line1\nline2\nline3');
    await tool.execute({ pipeline_id: PIPELINE_ID });
    await tool.execute({ pipeline_id: PIPELINE_ID, search: 'line2' });
    const windowed = await tool.execute({ pipeline_id: PIPELINE_ID, start_line: 2, max_lines: 1 });

    expect(mockGetLogsResult).toHaveBeenCalledTimes(1);
    expect(windowed.agentContent).toContain('2: line2');
  });

  it('collapses repeated lines in the tail view', async () => {
    const logs = ['start', ...Array.from({ length: 40 }, () => 'retrying connection'), 'done'].join('\n');
    okFetch(logs);
    const result = await tool.execute({ pipeline_id: PIPELINE_ID });
    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('[repeated 40x] retrying connection');
  });
});
