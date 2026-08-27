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

import { QueryDatabaseTool } from '../queryDatabase';

function createClient() {
  return {
    queryTable: jest.fn(),
  } as any;
}

function parseAgentContent(result: Awaited<ReturnType<QueryDatabaseTool['execute']>>) {
  return JSON.parse(result.agentContent);
}

describe('QueryDatabaseTool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('publishes the scoped read-only database contract', () => {
    const tool = new QueryDatabaseTool(createClient());

    expect(tool.name).toBe('query_database');
    expect(tool.description).toContain('THIS build only');
    expect(tool.description).toContain('READ-ONLY');
    expect(tool.parameters.required).toEqual(['table']);
  });

  it('returns cancellation without querying the database', async () => {
    const client = createClient();
    const tool = new QueryDatabaseTool(client);

    const result = await tool.execute({ table: 'builds' }, { aborted: true } as AbortSignal);

    expect(result.success).toBe(false);
    expect(result.error).toEqual({ code: 'CANCELLED', message: 'Operation cancelled' });
    expect(client.queryTable).not.toHaveBeenCalled();
  });

  it('passes every supported query option through and formats an empty result', async () => {
    const client = createClient();
    client.queryTable.mockResolvedValue({ records: [], totalCount: 0, warnings: [] });
    const tool = new QueryDatabaseTool(client);
    const args = {
      table: 'deploys',
      filters: { status: 'failed' },
      relations: ['build', 'deployable'],
      limit: 10,
      select: ['id', 'status'],
      orderBy: 'createdAt:desc',
      offset: 20,
    };

    const result = await tool.execute(args);

    expect(client.queryTable).toHaveBeenCalledWith(args);
    expect(parseAgentContent(result)).toEqual({
      success: true,
      table: 'deploys',
      count: 0,
      totalCount: 0,
      records: [],
    });
    expect(result.displayContent).toEqual({ type: 'text', content: 'Found 0 deploys (0 total)' });
  });

  it('omits unselected heavy values while preserving ordinary, nullish, and primitive records', async () => {
    const client = createClient();
    client.queryTable.mockResolvedValue({
      records: [
        null,
        'legacy-row',
        {
          id: 7,
          status: 'failed',
          manifest: 'abc',
          config: { image: 'example:v1' },
          env: null,
          capacityType: undefined,
        },
      ],
      totalCount: 3,
      warnings: ['relation deployable was compacted'],
    });
    const tool = new QueryDatabaseTool(client);

    const result = await tool.execute({ table: 'deploys' });
    const content = parseAgentContent(result);

    expect(content.records[0]).toBeNull();
    expect(content.records[1]).toBe('legacy-row');
    expect(content.records[2]).toEqual({
      id: 7,
      status: 'failed',
      manifest: '[omitted 3 chars — pass select:["manifest"] to fetch]',
      config: `[omitted ${JSON.stringify({ image: 'example:v1' }).length} chars — pass select:["config"] to fetch]`,
      env: null,
    });
    expect(content.warnings).toEqual(['relation deployable was compacted']);
  });

  it('returns explicitly selected heavy objects without compaction', async () => {
    const client = createClient();
    const config = { service: { image: 'example:v2' } };
    client.queryTable.mockResolvedValue({ records: [{ id: 8, config }], totalCount: 1 });
    const tool = new QueryDatabaseTool(client);

    const result = await tool.execute({ table: 'builds', select: ['config'] });

    expect(parseAgentContent(result).records).toEqual([{ id: 8, config }]);
  });

  it('keeps the tail of an explicitly selected oversized heavy string', async () => {
    const client = createClient();
    const buildOutput = `discarded-prefix-${'x'.repeat(16000)}-failure-at-tail`;
    client.queryTable.mockResolvedValue({ records: [{ buildOutput }], totalCount: 1, warnings: null });
    const tool = new QueryDatabaseTool(client);

    const result = await tool.execute({ table: 'deploys', select: ['buildOutput'] });
    const returned = parseAgentContent(result).records[0].buildOutput as string;

    expect(returned).not.toContain('discarded-prefix');
    expect(returned).toContain('failure-at-tail');
    expect(returned).toContain(`[showing last 15000 of ${buildOutput.length} chars]`);
  });

  it('returns dependency errors through the execution-error contract', async () => {
    const client = createClient();
    client.queryTable.mockRejectedValue(new Error('database unavailable'));
    const tool = new QueryDatabaseTool(client);

    const result = await tool.execute({ table: 'builds' });

    expect(result.success).toBe(false);
    expect(result.error).toEqual({ code: 'EXECUTION_ERROR', message: 'database unavailable' });
  });

  it('uses a stable fallback when a dependency rejects without an Error', async () => {
    const client = createClient();
    client.queryTable.mockRejectedValue('connection closed');
    const tool = new QueryDatabaseTool(client);

    const result = await tool.execute({ table: 'builds' });

    expect(result.error).toEqual({ code: 'EXECUTION_ERROR', message: 'Database query failed' });
  });
});
