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

const mockProcessSecretRefs = jest.fn();
const mockWaitForSecretSync = jest.fn();
const mockReadNamespacedSecret = jest.fn();
const mockCreateOrUpdateNamespace = jest.fn();

jest.mock('server/services/secretProcessor', () => ({
  SecretProcessor: jest.fn().mockImplementation(() => ({
    processSecretRefs: (...args: any[]) => mockProcessSecretRefs(...args),
    waitForSecretSync: (...args: any[]) => mockWaitForSecretSync(...args),
  })),
}));

jest.mock('@kubernetes/client-node', () => ({
  CoreV1Api: jest.fn(),
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn(() => ({
      readNamespacedSecret: (...args: any[]) => mockReadNamespacedSecret(...args),
    })),
  })),
}));

jest.mock('server/lib/kubernetes', () => ({
  createOrUpdateNamespace: (...args: any[]) => mockCreateOrUpdateNamespace(...args),
}));

import { resolveCodefreshExternalSecrets } from '../codefreshExternalSecrets';

describe('resolveCodefreshExternalSecrets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessSecretRefs.mockImplementation(({ secretRefs }) => ({
      secretRefs,
      expectedKeysPerSecret: { 'lfc-example-service-aws': secretRefs.map((ref: any) => ref.envKey) },
      syncTokensPerSecret: { 'lfc-example-service-aws': 'sync-token' },
      warnings: [],
    }));
    mockWaitForSecretSync.mockResolvedValue(undefined);
    mockCreateOrUpdateNamespace.mockResolvedValue(undefined);
  });

  test('fails when the synced Kubernetes secret is missing the expected key', async () => {
    mockReadNamespacedSecret.mockResolvedValue({
      body: {
        data: {},
      },
    });

    await expect(
      resolveCodefreshExternalSecrets({
        env: {
          API_TOKEN: '{{aws:repo/example/service:API_TOKEN}}',
        },
        serviceName: 'example-service',
        namespace: 'env-build-uuid',
        buildUuid: 'build-uuid',
        secretProviders: {
          aws: {
            enabled: true,
            clusterSecretStore: 'aws-secrets',
            refreshInterval: '1h',
          },
        },
      })
    ).rejects.toThrow("synced Kubernetes secret is missing key 'API_TOKEN'");
  });
});
