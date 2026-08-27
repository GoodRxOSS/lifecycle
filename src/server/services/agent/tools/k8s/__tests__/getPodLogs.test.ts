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

import { GetPodLogsTool } from '../getPodLogs';
import type { K8sClient } from '../../shared/k8sClient';

let mockAllowedNamespace: string | null = null;

const mockResolveNamespace = jest.fn((requested?: string | null) => {
  const requestedTrimmed = requested?.trim() || null;
  if (!mockAllowedNamespace) {
    if (!requestedTrimmed) throw new Error('namespace is required');
    return requestedTrimmed;
  }
  if (!requestedTrimmed) return mockAllowedNamespace;
  if (requestedTrimmed !== mockAllowedNamespace) {
    throw new Error(
      `namespace "${requestedTrimmed}" is outside this environment's namespace "${mockAllowedNamespace}" and cannot be accessed.`
    );
  }
  return mockAllowedNamespace;
});

const mockK8sClient = {
  coreApi: {
    readNamespacedPodLog: jest.fn(),
  },
  setAllowedNamespace: (ns: string | null | undefined) => {
    mockAllowedNamespace = ns?.trim() || null;
  },
  resolveNamespace: mockResolveNamespace,
};

describe('GetPodLogsTool', () => {
  let tool: GetPodLogsTool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAllowedNamespace = null;
    tool = new GetPodLogsTool(mockK8sClient as unknown as K8sClient);
  });

  it('publishes the stable tool name and required pod-name schema', () => {
    expect(tool.name).toBe('get_pod_logs');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['pod_name'],
      properties: {
        pod_name: { type: 'string' },
        namespace: { type: 'string' },
        container: { type: 'string' },
        previous: { type: 'boolean' },
        tail_lines: { type: 'number' },
        head_lines: { type: 'number' },
        search: { type: 'string' },
      },
    });
  });

  it('fetches logs with default tail_lines=100', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({
      body: 'line1\nline2\nline3',
    });

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns' });
    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('Logs for pod my-pod: 3 lines after dedupe');
    expect(result.agentContent).toContain('```\nline1\nline2\nline3\n```');
    expect(mockK8sClient.coreApi.readNamespacedPodLog).toHaveBeenCalledWith(
      'my-pod',
      'test-ns',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      100
    );
  });

  it('respects custom tail_lines and container args', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({ body: 'logs' });

    await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns', container: 'sidecar', tail_lines: 50 });
    expect(mockK8sClient.coreApi.readNamespacedPodLog).toHaveBeenCalledWith(
      'my-pod',
      'test-ns',
      'sidecar',
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      50
    );
  });

  it('uses documented defaults when zero line limits are supplied', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({ body: 'logs' });

    const result = await tool.execute({
      pod_name: 'my-pod',
      namespace: 'test-ns',
      tail_lines: 0,
      head_lines: 0,
    });

    expect(result.success).toBe(true);
    expect(result.displayContent?.content).toContain('head=50 tail=100');
    expect(mockK8sClient.coreApi.readNamespacedPodLog).toHaveBeenLastCalledWith(
      'my-pod',
      'test-ns',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      100
    );
  });

  it('reads the previous (crashed) container instance when previous=true', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({ body: 'crash output' });

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns', previous: true });
    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('(previous instance)');
    expect(result.agentContent).toContain('crash output');
    expect(mockK8sClient.coreApi.readNamespacedPodLog).toHaveBeenCalledWith(
      'my-pod',
      'test-ns',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      100
    );
  });

  it('handles API error', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockRejectedValue(new Error('Pod not found'));

    const result = await tool.execute({ pod_name: 'missing', namespace: 'test-ns' });
    expect(result.success).toBe(false);
    expect(result.agentContent).toContain('Pod not found');
  });

  it('uses a safe generic message when the API rejects without an error value', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockRejectedValue(undefined);

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns' });

    expect(result).toMatchObject({
      success: false,
      agentContent: 'Error: Failed to fetch pod logs',
      error: { code: 'EXECUTION_ERROR', message: 'Failed to fetch pod logs' },
    });
  });

  it('returns an actionable error when no previous container instance exists', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockRejectedValue(
      new Error('previous terminated container "app" not found')
    );

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns', previous: true });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_PREVIOUS_CONTAINER');
    expect(result.agentContent).toContain('the pod has not restarted yet');
    expect(result.agentContent).toContain('Read current logs');
  });

  it('preserves unrelated errors while requesting a previous container instance', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockRejectedValue(new Error('Kubernetes permission denied'));

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns', previous: true });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'EXECUTION_ERROR', message: 'Kubernetes permission denied' },
    });
  });

  it('handles aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns' }, controller.signal);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CANCELLED');
    expect(mockResolveNamespace).not.toHaveBeenCalled();
    expect(mockK8sClient.coreApi.readNamespacedPodLog).not.toHaveBeenCalled();
  });

  it('rejects a namespace outside the build scope', async () => {
    mockK8sClient.setAllowedNamespace('env-mine');

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'env-other' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NAMESPACE_NOT_ALLOWED');
    expect(mockResolveNamespace).toHaveBeenCalledWith('env-other');
    expect(mockK8sClient.coreApi.readNamespacedPodLog).not.toHaveBeenCalled();
  });

  it('uses a safe namespace error when the resolver throws without a message', async () => {
    mockResolveNamespace.mockImplementationOnce(() => {
      throw { message: '' };
    });

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns' });

    expect(result).toMatchObject({
      success: false,
      agentContent: 'Error: Namespace not allowed',
      error: { code: 'NAMESPACE_NOT_ALLOWED', message: 'Namespace not allowed' },
    });
    expect(mockK8sClient.coreApi.readNamespacedPodLog).not.toHaveBeenCalled();
  });

  it('defaults to the build namespace when none is supplied', async () => {
    mockK8sClient.setAllowedNamespace('env-mine');
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({ body: 'logs' });

    const result = await tool.execute({ pod_name: 'my-pod' });
    expect(result.success).toBe(true);
    expect(mockK8sClient.coreApi.readNamespacedPodLog).toHaveBeenCalledWith(
      'my-pod',
      'env-mine',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      100
    );
  });

  it('uses the namespace returned by the scope resolver', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({ body: 'logs' });

    await tool.execute({ pod_name: 'my-pod', namespace: '  test-ns  ' });

    expect(mockResolveNamespace).toHaveBeenCalledWith('  test-ns  ');
    expect(mockK8sClient.coreApi.readNamespacedPodLog).toHaveBeenCalledWith(
      'my-pod',
      'test-ns',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      100
    );
  });

  it('sanitizes control sequences and deduplicates consecutive log lines', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({
      body: '\u001b[31mrepeated\u001b[0m\r\nrepeated\rrepeated\nnext\u0000',
    });

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns', search: '   ' });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('2 lines after dedupe');
    expect(result.agentContent).toContain('[repeated 3x] repeated\nnext');
    expect(result.agentContent).not.toContain('\u001b');
    expect(result.agentContent).not.toContain('\u0000');
  });

  it('represents an empty log body with the current deduplicated empty-line marker', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({ body: '' });

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns' });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('1 lines after dedupe');
    expect(result.agentContent).toContain('[repeated 2x]');
    expect(result.displayContent?.content).toBe('Pod logs: 1 lines from my-pod (1 total, head=50 tail=100)');
  });

  it('renders head and tail lines with an explicit truncation summary', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({
      body: Array.from({ length: 8 }, (_, index) => `line-${index + 1}`).join('\n'),
    });

    const result = await tool.execute({
      pod_name: 'my-pod',
      namespace: 'test-ns',
      head_lines: 2,
      tail_lines: 2,
    });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('8 lines after dedupe (truncated to head=2 tail=2 of 8 deduped lines)');
    expect(result.agentContent).toContain('line-1\nline-2');
    expect(result.agentContent).toContain('line-7\nline-8');
    expect(result.agentContent).not.toContain('line-4');
    expect(result.displayContent?.content).toBe('Pod logs: 5 lines from my-pod (8 total, head=2 tail=2)');
  });

  it('keeps oversized log output within the character cap', async () => {
    const body = Array.from({ length: 40 }, (_, index) => `${index}-${'x'.repeat(1500)}`).join('\n');
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({ body });

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns' });

    expect(result.success).toBe(true);
    expect(result.agentContent.length).toBeLessThan(31_000);
    expect(result.agentContent).toContain('[Truncated: showing last');
  });

  it('renders case-insensitive regex matches with context and fetched-tail line numbers', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({
      body: ['before', 'ERROR first', 'after', 'gap', 'error second'].join('\n'),
    });

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns', search: 'error' });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('2 lines match /error/i');
    expect(result.agentContent).toContain('2: ERROR first');
    expect(result.agentContent).toContain('5: error second');
    expect(result.displayContent?.content).toBe('Pod log search: 2 matches');
  });

  it('returns search guidance when the fetched previous-instance tail has no matches', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({ body: 'all clear\nstill clear' });

    const result = await tool.execute({
      pod_name: 'my-pod',
      namespace: 'test-ns',
      previous: true,
      search: 'fatal',
    });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('No lines match /fatal/i');
    expect(result.agentContent).toContain('2-line fetched tail of pod my-pod (previous instance)');
    expect(result.agentContent).toContain('Raise tail_lines');
    expect(result.displayContent?.content).toBe('Pod log search: 0 matches');
  });

  it('rejects an invalid search expression after fetching the scoped logs', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({ body: 'logs' });

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns', search: '[' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETERS');
    expect(result.agentContent).toContain('Invalid search pattern:');
    expect(mockK8sClient.coreApi.readNamespacedPodLog).toHaveBeenCalledTimes(1);
  });

  it('reports when a broad search is capped to its first fifty matches', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({
      body: Array.from({ length: 60 }, (_, index) => `error-${index + 1}`).join('\n'),
    });

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns', search: 'error' });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('60 lines match /error/i');
    expect(result.agentContent).toContain('(showing first 50; narrow the pattern)');
    expect(result.displayContent?.content).toBe('Pod log search: 60 matches');
  });
});
