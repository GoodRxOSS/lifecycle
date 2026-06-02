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

import { PatchK8sResourceTool } from '../patchK8sResource';

let mockAllowedNamespace: string | null = null;

const mockK8sClient = {
  coreApi: {
    deleteNamespacedPod: jest.fn(),
  },
  appsApi: {
    readNamespacedDeployment: jest.fn(),
    patchNamespacedDeployment: jest.fn(),
  },
  batchApi: {
    deleteNamespacedJob: jest.fn(),
  },
  setAllowedNamespace: (ns: string | null | undefined) => {
    mockAllowedNamespace = ns?.trim() || null;
  },
  resolveNamespace: (requested?: string | null) => {
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
  },
} as any;

const deploymentResponse = {
  body: {
    metadata: { name: 'my-deploy' },
    spec: { replicas: 2 },
    status: { replicas: 2, readyReplicas: 2, availableReplicas: 2 },
  },
};

describe('PatchK8sResourceTool', () => {
  let tool: PatchK8sResourceTool;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAllowedNamespace = null;
    tool = new PatchK8sResourceTool(mockK8sClient);
  });

  it('patch operation patches deployment with strategic-merge-patch header', async () => {
    mockK8sClient.appsApi.patchNamespacedDeployment.mockResolvedValue(deploymentResponse);

    const patchObj = { spec: { replicas: 5 } };
    const result = await tool.execute({
      namespace: 'test-ns',
      resource_type: 'deployment',
      name: 'my-deploy',
      operation: 'patch',
      patch: patchObj,
    });

    expect(result.success).toBe(true);
    expect(mockK8sClient.appsApi.patchNamespacedDeployment).toHaveBeenCalledWith(
      'my-deploy',
      'test-ns',
      patchObj,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  });

  it('scale operation reads then patches deployment', async () => {
    mockK8sClient.appsApi.readNamespacedDeployment.mockResolvedValue(deploymentResponse);
    mockK8sClient.appsApi.patchNamespacedDeployment.mockResolvedValue(deploymentResponse);

    const result = await tool.execute({
      namespace: 'test-ns',
      resource_type: 'deployment',
      name: 'my-deploy',
      operation: 'scale',
      replicas: 5,
    });

    expect(result.success).toBe(true);
    expect(mockK8sClient.appsApi.readNamespacedDeployment).toHaveBeenCalledWith('my-deploy', 'test-ns');
    expect(mockK8sClient.appsApi.patchNamespacedDeployment).toHaveBeenCalled();
  });

  it('restart operation adds restartedAt annotation', async () => {
    mockK8sClient.appsApi.patchNamespacedDeployment.mockResolvedValue(deploymentResponse);

    const result = await tool.execute({
      namespace: 'test-ns',
      resource_type: 'deployment',
      name: 'my-deploy',
      operation: 'restart',
    });

    expect(result.success).toBe(true);
    const patchArg = mockK8sClient.appsApi.patchNamespacedDeployment.mock.calls[0][2];
    expect(patchArg.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt']).toBeDefined();
  });

  it('rejects delete: it is removed from the supported operations', async () => {
    const result = await tool.execute({
      namespace: 'test-ns',
      resource_type: 'pod',
      name: 'my-pod',
      operation: 'delete',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_OPERATION');
    expect(result.agentContent).toContain('Unknown operation');
    expect(mockK8sClient.coreApi.deleteNamespacedPod).not.toHaveBeenCalled();
    expect(mockK8sClient.batchApi.deleteNamespacedJob).not.toHaveBeenCalled();
  });

  it('returns error for missing patch object on patch operation', async () => {
    const result = await tool.execute({
      namespace: 'test-ns',
      resource_type: 'deployment',
      name: 'my-deploy',
      operation: 'patch',
    });

    expect(result.success).toBe(false);
    expect(result.agentContent).toContain('patch object');
  });

  it('returns error for missing replicas on scale operation', async () => {
    const result = await tool.execute({
      namespace: 'test-ns',
      resource_type: 'deployment',
      name: 'my-deploy',
      operation: 'scale',
    });

    expect(result.success).toBe(false);
    expect(result.agentContent).toContain('replicas');
  });

  it('returns error for unknown operation', async () => {
    const result = await tool.execute({
      namespace: 'test-ns',
      resource_type: 'deployment',
      name: 'my-deploy',
      operation: 'rollback',
    });

    expect(result.success).toBe(false);
    expect(result.agentContent).toContain('Unknown operation');
  });

  it('handles aborted signal', async () => {
    const result = await tool.execute(
      { namespace: 'test-ns', resource_type: 'deployment', name: 'x', operation: 'patch', patch: {} },
      { aborted: true } as any
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CANCELLED');
  });

  it('rejects a namespace outside the build scope during execution', async () => {
    mockK8sClient.setAllowedNamespace('env-mine');

    const result = await tool.execute({
      namespace: 'env-other',
      resource_type: 'deployment',
      name: 'my-deploy',
      operation: 'restart',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NAMESPACE_NOT_ALLOWED');
    expect(mockK8sClient.appsApi.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it('rejects a foreign namespace BEFORE presenting an approval', async () => {
    mockK8sClient.setAllowedNamespace('env-mine');

    await expect(
      tool.shouldConfirmExecution({
        namespace: 'env-other',
        resource_type: 'deployment',
        name: 'my-deploy',
        operation: 'restart',
      })
    ).rejects.toThrow('env-other');
  });

  it('presents an approval for the matching build namespace', async () => {
    mockK8sClient.setAllowedNamespace('env-mine');

    const confirmation = await tool.shouldConfirmExecution({
      namespace: 'env-mine',
      resource_type: 'deployment',
      name: 'my-deploy',
      operation: 'restart',
    });

    expect(confirmation).not.toBe(false);
    expect((confirmation as any).description).toContain('env-mine');
  });
});
