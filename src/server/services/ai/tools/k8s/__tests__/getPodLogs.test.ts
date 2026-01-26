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

const mockK8sClient = {
  coreApi: {
    readNamespacedPodLog: jest.fn(),
  },
} as any;

describe('GetPodLogsTool', () => {
  let tool: GetPodLogsTool;

  beforeEach(() => {
    jest.clearAllMocks();
    tool = new GetPodLogsTool(mockK8sClient);
  });

  it('fetches logs with default tail_lines=100', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockResolvedValue({
      body: 'line1\nline2\nline3',
    });

    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent);
    expect(data.logs).toBe('line1\nline2\nline3');
    expect(mockK8sClient.coreApi.readNamespacedPodLog).toHaveBeenCalledWith(
      'my-pod',
      'test-ns',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
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
      undefined,
      undefined,
      50
    );
  });

  it('handles API error', async () => {
    mockK8sClient.coreApi.readNamespacedPodLog.mockRejectedValue(new Error('Pod not found'));

    const result = await tool.execute({ pod_name: 'missing', namespace: 'test-ns' });
    expect(result.success).toBe(false);
    expect(result.agentContent).toContain('Pod not found');
  });

  it('handles aborted signal', async () => {
    const result = await tool.execute({ pod_name: 'my-pod', namespace: 'test-ns' }, { aborted: true } as any);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CANCELLED');
  });
});
