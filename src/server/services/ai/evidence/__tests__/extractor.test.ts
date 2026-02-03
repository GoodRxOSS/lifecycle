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

import { extractEvidence, generateResultPreview } from '../extractor';
import type { ToolResult } from '../../types/tool';

const ctx = { toolCallId: 'tc-1' };

function ok(agentContent: string): ToolResult {
  return { success: true, agentContent };
}

function fail(): ToolResult {
  return { success: false };
}

describe('extractEvidence', () => {
  it('returns evidence_file for get_file', () => {
    const result = extractEvidence(
      'get_file',
      { file_path: 'src/index.ts', repository_owner: 'org', repository_name: 'repo' },
      ok(JSON.stringify({ path: 'src/index.ts', content: 'hello' })),
      ctx
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'evidence_file',
      toolCallId: 'tc-1',
      filePath: 'src/index.ts',
      repository: 'org/repo',
    });
  });

  it('infers typescript language for .ts file', () => {
    const result = extractEvidence(
      'get_file',
      { file_path: 'src/app.ts' },
      ok(JSON.stringify({ path: 'src/app.ts' })),
      ctx
    );
    expect(result[0]).toHaveProperty('language', 'typescript');
  });

  it('returns undefined language for unknown extension', () => {
    const result = extractEvidence(
      'get_file',
      { file_path: 'data.xyz' },
      ok(JSON.stringify({ path: 'data.xyz' })),
      ctx
    );
    expect(result[0]).toHaveProperty('language', undefined);
  });

  it('returns evidence_commit + evidence_file for update_file with commit info', () => {
    const result = extractEvidence(
      'update_file',
      { file_path: 'src/a.ts', commit_message: 'fix bug', repository_owner: 'o', repository_name: 'r' },
      ok(JSON.stringify({ commit_sha: 'abc123', commit_url: 'https://github.com/o/r/commit/abc123' })),
      ctx
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: 'evidence_commit', commitUrl: 'https://github.com/o/r/commit/abc123' });
    expect(result[1]).toMatchObject({ type: 'evidence_file', filePath: 'src/a.ts' });
  });

  it('returns only evidence_file for update_file without commit info', () => {
    const result = extractEvidence(
      'update_file',
      { file_path: 'src/a.ts' },
      ok(JSON.stringify({ message: 'ok' })),
      ctx
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'evidence_file' });
  });

  it('returns evidence_resource for get_k8s_resources', () => {
    const result = extractEvidence(
      'get_k8s_resources',
      { resource_type: 'deployment', name: 'web', namespace: 'ns' },
      ok(JSON.stringify({})),
      ctx
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'evidence_resource',
      resourceType: 'deployment',
      resourceName: 'web',
      namespace: 'ns',
    });
  });

  it('returns evidence_resource with type=pod for get_pod_logs', () => {
    const result = extractEvidence(
      'get_pod_logs',
      { pod_name: 'web-abc', namespace: 'ns' },
      ok(JSON.stringify({ logs: 'line1' })),
      ctx
    );
    expect(result[0]).toMatchObject({ type: 'evidence_resource', resourceType: 'pod', resourceName: 'web-abc' });
  });

  it('returns evidence_resource for patch_k8s_resource', () => {
    const result = extractEvidence(
      'patch_k8s_resource',
      { resource_type: 'deployment', name: 'api', namespace: 'ns' },
      ok(JSON.stringify({})),
      ctx
    );
    expect(result[0]).toMatchObject({ type: 'evidence_resource', resourceType: 'deployment', resourceName: 'api' });
  });

  it('returns evidence_resource for get_lifecycle_logs', () => {
    const result = extractEvidence(
      'get_lifecycle_logs',
      { resource_type: 'service', name: 'worker', namespace: 'ns' },
      ok(JSON.stringify({})),
      ctx
    );
    expect(result[0]).toMatchObject({ type: 'evidence_resource' });
  });

  it('returns empty array for unknown tool', () => {
    expect(extractEvidence('unknown_tool', {}, ok('{}'), ctx)).toEqual([]);
  });

  it('returns empty array for failed result', () => {
    expect(extractEvidence('get_file', { file_path: 'a.ts' }, fail(), ctx)).toEqual([]);
  });

  it('returns empty array on extraction error', () => {
    expect(extractEvidence('get_file', null as any, ok('not-json'), ctx)).toEqual([]);
  });
});

describe('generateResultPreview', () => {
  it('returns path and line count for get_file', () => {
    const preview = generateResultPreview(
      'get_file',
      { file_path: 'src/a.ts' },
      ok(JSON.stringify({ path: 'src/a.ts', content: 'line1\nline2\nline3' }))
    );
    expect(preview).toBe('src/a.ts (3 lines)');
  });

  it('returns committed message for update_file', () => {
    const preview = generateResultPreview('update_file', { commit_message: 'fix typo' }, ok(JSON.stringify({})));
    expect(preview).toBe('Committed: fix typo');
  });

  it('returns pod phase summary for get_k8s_resources with pods', () => {
    const preview = generateResultPreview(
      'get_k8s_resources',
      {},
      ok(JSON.stringify({ pods: [{ phase: 'Running' }, { phase: 'Running' }, { phase: 'Pending' }] }))
    );
    expect(preview).toBe('3 pods: 2 Running, 1 Pending');
  });

  it('returns item count for get_k8s_resources with items', () => {
    const preview = generateResultPreview(
      'get_k8s_resources',
      { resource_type: 'service' },
      ok(JSON.stringify({ items: [{}, {}, {}] }))
    );
    expect(preview).toBe('3 service found');
  });

  it('returns log line count for get_pod_logs', () => {
    const preview = generateResultPreview(
      'get_pod_logs',
      { pod_name: 'web-1' },
      ok(JSON.stringify({ logs: 'a\nb\nc' }))
    );
    expect(preview).toBe('3 log lines from web-1');
  });

  it('returns row count for query_database', () => {
    const preview = generateResultPreview('query_database', {}, ok(JSON.stringify({ rows: [{ id: 1 }, { id: 2 }] })));
    expect(preview).toBe('2 rows returned');
  });

  it('returns patched info for patch_k8s_resource', () => {
    const preview = generateResultPreview(
      'patch_k8s_resource',
      { resource_type: 'deployment', name: 'api' },
      ok(JSON.stringify({}))
    );
    expect(preview).toBe('Patched deployment/api');
  });

  it('returns undefined for unknown tool', () => {
    expect(generateResultPreview('unknown', {}, ok('{}'))).toBeUndefined();
  });

  it('returns undefined for failed result', () => {
    expect(generateResultPreview('get_file', {}, fail())).toBeUndefined();
  });
});
