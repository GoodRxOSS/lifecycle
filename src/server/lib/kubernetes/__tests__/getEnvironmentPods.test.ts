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

var mockError: jest.Mock;
var mockLoadKubeConfig: jest.Mock;
var mockPodStatus: jest.Mock;
var mockPodRestarts: jest.Mock;
var mockPodReady: jest.Mock;
var mockPodAgeSeconds: jest.Mock;
var mockFormatAge: jest.Mock;
var mockExtractContainers: jest.Mock;

jest.mock('server/lib/logger', () => {
  mockError = jest.fn();
  return { getLogger: () => ({ error: mockError }) };
});
jest.mock('server/lib/kubernetes/getDeploymentPods', () => {
  mockLoadKubeConfig = jest.fn();
  mockPodStatus = jest.fn(() => 'Running');
  mockPodRestarts = jest.fn(() => 2);
  mockPodReady = jest.fn(() => true);
  mockPodAgeSeconds = jest.fn(() => 3);
  mockFormatAge = jest.fn(() => '3s');
  mockExtractContainers = jest.fn(() => []);
  return {
    loadKubeConfig: mockLoadKubeConfig,
    podStatus: mockPodStatus,
    podRestarts: mockPodRestarts,
    podReady: mockPodReady,
    podAgeSeconds: mockPodAgeSeconds,
    formatAge: mockFormatAge,
    extractContainers: mockExtractContainers,
  };
});

import { getEnvironmentPods, getEnvironmentPodsInNamespace } from '../getEnvironmentPods';

describe('getEnvironmentPodsInNamespace', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a CoreV1 client by default and passes the label selector', async () => {
    const listNamespacedPod = jest.fn().mockResolvedValue({ body: { items: [] } });
    mockLoadKubeConfig.mockReturnValue({ makeApiClient: jest.fn(() => ({ listNamespacedPod })) });

    await expect(getEnvironmentPodsInNamespace('env-a', { labelSelector: 'app=api' })).resolves.toEqual([]);
    expect(listNamespacedPod).toHaveBeenCalledWith('env-a', undefined, undefined, undefined, undefined, 'app=api');
    await expect(getEnvironmentPods('legacy')).resolves.toEqual([]);
    expect(listNamespacedPod).toHaveBeenLastCalledWith(
      'env-legacy',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
  });

  it('filters internal pods, applies a minimum maxPods limit, and maps service labels with fallbacks', async () => {
    const coreV1 = {
      listNamespacedPod: jest.fn().mockResolvedValue({
        body: {
          items: [
            { metadata: { name: 'native', labels: { 'app.kubernetes.io/name': 'native-build' } } },
            { metadata: { name: 'api', labels: { 'tags.datadoghq.com/service': 'catalog' } } },
            { metadata: { name: 'web', labels: { 'app.kubernetes.io/name': 'web' } } },
            { metadata: { name: 'unlabelled' } },
          ],
        },
      }),
    };
    await expect(getEnvironmentPodsInNamespace('env-a', { coreV1, maxPods: 0 })).resolves.toEqual([
      {
        podName: 'api',
        serviceName: 'catalog',
        status: 'Running',
        restarts: 2,
        ageSeconds: 3,
        age: '3s',
        ready: true,
        containers: [],
      },
    ]);
    await expect(getEnvironmentPodsInNamespace('env-a', { coreV1, maxPods: 5 })).resolves.toEqual([
      expect.objectContaining({ podName: 'api', serviceName: 'catalog' }),
      expect.objectContaining({ podName: 'web', serviceName: 'web' }),
      expect.objectContaining({ podName: 'unlabelled', serviceName: '' }),
    ]);
    await expect(getEnvironmentPodsInNamespace('env-a', { coreV1 })).resolves.toHaveLength(3);
  });

  it('logs and rethrows Kubernetes failures', async () => {
    const failure = new Error('forbidden');
    await expect(
      getEnvironmentPodsInNamespace('env-a', { coreV1: { listNamespacedPod: jest.fn().mockRejectedValue(failure) } })
    ).rejects.toBe(failure);
    expect(mockError).toHaveBeenCalledWith({ error: failure }, 'K8s: failed to list environment pods namespace=env-a');
  });
});
