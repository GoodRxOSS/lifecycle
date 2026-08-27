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

jest.mock('@kubernetes/client-node', () => {
  const KubeConfig = jest.fn(() => ({
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn((apiType: unknown) => ({ apiType })),
  }));

  return {
    KubeConfig,
    CoreV1Api: class CoreV1Api {},
    AppsV1Api: class AppsV1Api {},
    BatchV1Api: class BatchV1Api {},
    NetworkingV1Api: class NetworkingV1Api {},
  };
});

import * as k8s from '@kubernetes/client-node';

import { K8sClient } from '../k8sClient';

type MockKubeConfig = {
  loadFromDefault: jest.Mock;
  makeApiClient: jest.Mock;
};

const mockedKubeConfigConstructor = k8s.KubeConfig as unknown as jest.Mock<MockKubeConfig>;

function latestKubeConfig(): MockKubeConfig {
  return mockedKubeConfigConstructor.mock.results.at(-1)?.value;
}

describe('K8sClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads the default Kubernetes configuration and creates each API client', () => {
    const client = new K8sClient();
    const { loadFromDefault, makeApiClient } = latestKubeConfig();

    expect(mockedKubeConfigConstructor).toHaveBeenCalledTimes(1);
    expect(loadFromDefault).toHaveBeenCalledTimes(1);
    expect(makeApiClient).toHaveBeenNthCalledWith(1, k8s.CoreV1Api);
    expect(makeApiClient).toHaveBeenNthCalledWith(2, k8s.AppsV1Api);
    expect(makeApiClient).toHaveBeenNthCalledWith(3, k8s.BatchV1Api);
    expect(makeApiClient).toHaveBeenNthCalledWith(4, k8s.NetworkingV1Api);
    expect(client.coreApi).toEqual({ apiType: k8s.CoreV1Api });
    expect(client.appsApi).toEqual({ apiType: k8s.AppsV1Api });
    expect(client.batchApi).toEqual({ apiType: k8s.BatchV1Api });
    expect(client.networkingApi).toEqual({ apiType: k8s.NetworkingV1Api });
  });

  it('trims an allowed namespace and clears it for absent or blank values', () => {
    const client = new K8sClient();

    expect(client.getAllowedNamespace()).toBeNull();

    client.setAllowedNamespace('  lifecycle-42  ');
    expect(client.getAllowedNamespace()).toBe('lifecycle-42');

    for (const value of ['', '   ', null, undefined]) {
      client.setAllowedNamespace(value);
      expect(client.getAllowedNamespace()).toBeNull();
    }
  });

  it('requires and trims the requested namespace when no build namespace is configured', () => {
    const client = new K8sClient();

    expect(client.resolveNamespace('  requested-namespace  ')).toBe('requested-namespace');
    for (const value of ['', '   ', null, undefined]) {
      expect(() => client.resolveNamespace(value)).toThrow('namespace is required');
    }
  });

  it('defaults an omitted request to the configured build namespace', () => {
    const client = new K8sClient();
    client.setAllowedNamespace('lifecycle-42');

    for (const value of ['', '   ', null, undefined]) {
      expect(client.resolveNamespace(value)).toBe('lifecycle-42');
    }
  });

  it('accepts only the configured build namespace when a request is supplied', () => {
    const client = new K8sClient();
    client.setAllowedNamespace('lifecycle-42');

    expect(client.resolveNamespace('  lifecycle-42  ')).toBe('lifecycle-42');
    expect(() => client.resolveNamespace('another-namespace')).toThrow(
      'namespace "another-namespace" is outside this environment\'s namespace "lifecycle-42" and cannot be accessed.'
    );
  });
});
