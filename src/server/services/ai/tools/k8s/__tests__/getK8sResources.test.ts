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

import { GetK8sResourcesTool } from '../getK8sResources';

const mockK8sClient = {
  coreApi: {
    listNamespacedPod: jest.fn(),
    readNamespacedPod: jest.fn(),
    readNamespacedPodLog: jest.fn(),
    listNamespacedService: jest.fn(),
    listNamespacedSecret: jest.fn(),
    listNamespacedConfigMap: jest.fn(),
    listNamespacedEvent: jest.fn(),
    deleteNamespacedPod: jest.fn(),
  },
  appsApi: {
    listNamespacedDeployment: jest.fn(),
    readNamespacedDeployment: jest.fn(),
    patchNamespacedDeployment: jest.fn(),
    listNamespacedStatefulSet: jest.fn(),
    listNamespacedDaemonSet: jest.fn(),
    listNamespacedReplicaSet: jest.fn(),
  },
  batchApi: {
    listNamespacedJob: jest.fn(),
    deleteNamespacedJob: jest.fn(),
  },
  networkingApi: {
    listNamespacedIngress: jest.fn(),
  },
} as any;

describe('GetK8sResourcesTool', () => {
  let tool: GetK8sResourcesTool;

  beforeEach(() => {
    jest.clearAllMocks();
    tool = new GetK8sResourcesTool(mockK8sClient);
  });

  it('lists pods', async () => {
    mockK8sClient.coreApi.listNamespacedPod.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'pod-1', creationTimestamp: '2025-01-01T00:00:00Z' },
            status: {
              phase: 'Running',
              containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }],
            },
          },
          {
            metadata: { name: 'pod-2', creationTimestamp: '2025-01-01T00:00:00Z' },
            status: {
              phase: 'Pending',
              containerStatuses: [{ name: 'app', ready: false, restartCount: 2, state: { waiting: {} } }],
            },
          },
        ],
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'pods' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent);
    expect(data.pods).toHaveLength(2);
    expect(data.pods[0].name).toBe('pod-1');
    expect(data.pods[0].phase).toBe('Running');
    expect(data.pods[0].ready).toBe('1/1');
    expect(data.pods[0].restarts).toBe(0);
    expect(data.pods[1].restarts).toBe(2);
  });

  it('gets specific pod by name', async () => {
    mockK8sClient.coreApi.readNamespacedPod.mockResolvedValue({
      body: {
        metadata: { name: 'my-pod' },
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: [{ name: 'app', ready: true, restartCount: 0 }],
          hostIP: '10.0.0.1',
          podIP: '10.0.1.5',
          startTime: '2025-01-01T00:00:00Z',
        },
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'pods', name: 'my-pod' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent);
    expect(data.pod.name).toBe('my-pod');
    expect(data.pod.podIP).toBe('10.0.1.5');
  });

  it('lists deployments', async () => {
    mockK8sClient.appsApi.listNamespacedDeployment.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'deploy-1', creationTimestamp: '2025-01-01T00:00:00Z' },
            spec: { replicas: 3 },
            status: { readyReplicas: 3, availableReplicas: 3 },
          },
        ],
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'deployments' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent);
    expect(data.deployments).toHaveLength(1);
    expect(data.deployments[0].name).toBe('deploy-1');
  });

  it('gets specific deployment by name', async () => {
    mockK8sClient.appsApi.readNamespacedDeployment.mockResolvedValue({
      body: {
        metadata: { name: 'my-deploy' },
        spec: {
          replicas: 2,
          strategy: { type: 'RollingUpdate' },
          template: { spec: { containers: [{ name: 'app', image: 'nginx:latest' }] } },
        },
        status: { replicas: 2, readyReplicas: 2, availableReplicas: 2, updatedReplicas: 2 },
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'deployments', name: 'my-deploy' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent);
    expect(data.deployment.name).toBe('my-deploy');
    expect(data.deployment.replicas.desired).toBe(2);
  });

  it('lists services', async () => {
    mockK8sClient.coreApi.listNamespacedService.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'svc-1' },
            spec: {
              type: 'ClusterIP',
              clusterIP: '10.96.0.1',
              ports: [{ name: 'http', port: 80, targetPort: 8080, protocol: 'TCP' }],
              selector: { app: 'web' },
            },
          },
        ],
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'services' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent);
    expect(data.services).toHaveLength(1);
    expect(data.services[0].name).toBe('svc-1');
    expect(data.count).toBe(1);
  });

  it('returns error for unsupported resource type', async () => {
    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'unknown' });
    expect(result.success).toBe(false);
    expect(result.agentContent).toContain('Unsupported resource type');
  });

  it('handles aborted signal', async () => {
    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'pods' }, { aborted: true } as any);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CANCELLED');
  });

  it('handles API error gracefully', async () => {
    mockK8sClient.coreApi.listNamespacedPod.mockRejectedValue(new Error('Forbidden'));

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'pods' });
    expect(result.success).toBe(false);
    expect(result.agentContent).toContain('Forbidden');
  });
});
