/**
 * Copyright 2026 GoodRx, Inc.
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

const mockKubernetesRequest = jest.fn();

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn(() => ({
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn(() => ({
      listNamespacedPod: mockKubernetesRequest,
      readNamespacedPodLog: mockKubernetesRequest,
      patchNamespacedDeployment: mockKubernetesRequest,
    })),
  })),
  CoreV1Api: class CoreV1Api {},
  AppsV1Api: class AppsV1Api {},
  BatchV1Api: class BatchV1Api {},
  NetworkingV1Api: class NetworkingV1Api {},
}));

import { K8sClient, K8S_NAMESPACE_SCOPE_UNAVAILABLE_MESSAGE } from '../../shared/k8sClient';
import { GetK8sResourcesTool } from '../getK8sResources';
import { GetPodLogsTool } from '../getPodLogs';
import { PatchK8sResourceTool } from '../patchK8sResource';

const cases = [
  { Tool: GetK8sResourcesTool, args: { resource_type: 'pods' } },
  { Tool: GetPodLogsTool, args: { pod_name: 'app-1' } },
  {
    Tool: PatchK8sResourceTool,
    args: { resource_type: 'deployment', name: 'app', operation: 'patch', patch: { spec: { replicas: 1 } } },
  },
];

describe('Kubernetes tool namespace boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(cases)('refuses an unscoped $Tool.Name before issuing any Kubernetes request', async ({ Tool, args }) => {
    const client = new K8sClient();
    const tool = new Tool(client);

    for (const namespace of [undefined, 'another-environment']) {
      const result = await tool.execute({ ...args, namespace });
      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'NAMESPACE_NOT_ALLOWED',
        message: K8S_NAMESPACE_SCOPE_UNAVAILABLE_MESSAGE,
      });
    }
    expect(mockKubernetesRequest).not.toHaveBeenCalled();
  });

  it.each(cases)('refuses a foreign namespace with a valid scope for $Tool.Name', async ({ Tool, args }) => {
    const client = new K8sClient();
    client.setAllowedNamespace('environment-a');
    const result = await new Tool(client).execute({ ...args, namespace: 'environment-b' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NAMESPACE_NOT_ALLOWED');
    expect(mockKubernetesRequest).not.toHaveBeenCalled();
  });

  it('uses the authoritative namespace when a scoped log request omits it', async () => {
    const client = new K8sClient();
    client.setAllowedNamespace('environment-a');
    mockKubernetesRequest.mockResolvedValue({ body: 'application started' });

    const result = await new GetPodLogsTool(client).execute({ pod_name: 'app-1' });

    expect(result.success).toBe(true);
    expect(mockKubernetesRequest.mock.calls[0].slice(0, 2)).toEqual(['app-1', 'environment-a']);
  });
});
