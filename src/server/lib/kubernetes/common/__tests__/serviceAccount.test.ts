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

const mockCreateNamespacedServiceAccount = jest.fn();
const mockPatchNamespacedServiceAccount = jest.fn();
const mockEnsureRoleAndBinding = jest.fn();
const mockGetAllConfigs = jest.fn();

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn(() => ({
      createNamespacedServiceAccount: (...args: unknown[]) => mockCreateNamespacedServiceAccount(...args),
      patchNamespacedServiceAccount: (...args: unknown[]) => mockPatchNamespacedServiceAccount(...args),
    })),
  })),
  CoreV1Api: jest.fn(),
}));

jest.mock('../../rbac', () => ({
  ensureRoleAndBinding: (...args: unknown[]) => mockEnsureRoleAndBinding(...args),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({ getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args) }),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { resolveServiceAccountAnnotations, ensureServiceAccount, ensureServiceAccountForJob } from '../serviceAccount';

const EKS_KEY = 'eks.amazonaws.com/role-arn';
const GKE_KEY = 'iam.gke.io/gcp-service-account';

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateNamespacedServiceAccount.mockResolvedValue({});
  mockPatchNamespacedServiceAccount.mockResolvedValue({});
  mockEnsureRoleAndBinding.mockResolvedValue(undefined);
});

describe('resolveServiceAccountAnnotations', () => {
  it('returns empty for missing config', () => {
    expect(resolveServiceAccountAnnotations(undefined)).toEqual({});
    expect(resolveServiceAccountAnnotations({})).toEqual({});
  });

  it('maps legacy role to the EKS annotation', () => {
    expect(resolveServiceAccountAnnotations({ role: 'arn:aws:iam::123:role/lc' })).toEqual({
      [EKS_KEY]: 'arn:aws:iam::123:role/lc',
    });
  });

  it('trims the legacy role value', () => {
    expect(resolveServiceAccountAnnotations({ role: '  arn:aws:iam::123:role/lc ' })).toEqual({
      [EKS_KEY]: 'arn:aws:iam::123:role/lc',
    });
  });

  it.each(['replace_me', 'default', '', '  '])('never emits placeholder role %j', (role) => {
    expect(resolveServiceAccountAnnotations({ role })).toEqual({});
  });

  it('passes explicit annotations through (GKE workload identity)', () => {
    expect(
      resolveServiceAccountAnnotations({ annotations: { [GKE_KEY]: 'sa@project.iam.gserviceaccount.com' } })
    ).toEqual({ [GKE_KEY]: 'sa@project.iam.gserviceaccount.com' });
  });

  it('drops placeholder values inside explicit annotations', () => {
    expect(
      resolveServiceAccountAnnotations({ annotations: { [GKE_KEY]: 'replace_me', 'example.com/keep': 'yes' } })
    ).toEqual({ 'example.com/keep': 'yes' });
  });

  it('lets explicit annotations win over the legacy role', () => {
    expect(
      resolveServiceAccountAnnotations({
        role: 'arn:aws:iam::123:role/old',
        annotations: { [EKS_KEY]: 'arn:aws:iam::123:role/new' },
      })
    ).toEqual({ [EKS_KEY]: 'arn:aws:iam::123:role/new' });
  });
});

describe('ensureServiceAccount', () => {
  it('creates the service account with annotations and sets up RBAC', async () => {
    await ensureServiceAccount({
      namespace: 'env-test',
      name: 'lifecycle-sa',
      annotations: { [GKE_KEY]: 'sa@project.iam.gserviceaccount.com' },
      permissions: 'deploy',
    });

    expect(mockCreateNamespacedServiceAccount).toHaveBeenCalledWith('env-test', {
      metadata: {
        name: 'lifecycle-sa',
        namespace: 'env-test',
        annotations: { [GKE_KEY]: 'sa@project.iam.gserviceaccount.com' },
      },
    });
    expect(mockPatchNamespacedServiceAccount).not.toHaveBeenCalled();
    expect(mockEnsureRoleAndBinding).toHaveBeenCalledWith({
      namespace: 'env-test',
      serviceAccountName: 'lifecycle-sa',
      permissions: 'deploy',
    });
  });

  it('patches when the service account already exists', async () => {
    mockCreateNamespacedServiceAccount.mockRejectedValueOnce({ response: { statusCode: 409 } });

    await ensureServiceAccount({ namespace: 'env-test', name: 'default', permissions: 'deploy' });

    expect(mockPatchNamespacedServiceAccount).toHaveBeenCalledWith(
      'default',
      'env-test',
      { metadata: { name: 'default', namespace: 'env-test', annotations: {} } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
    expect(mockEnsureRoleAndBinding).toHaveBeenCalled();
  });

  it('rethrows non-conflict errors without touching RBAC', async () => {
    mockCreateNamespacedServiceAccount.mockRejectedValueOnce({ response: { statusCode: 500 } });

    await expect(
      ensureServiceAccount({ namespace: 'env-test', name: 'default', permissions: 'deploy' })
    ).rejects.toEqual({ response: { statusCode: 500 } });
    expect(mockEnsureRoleAndBinding).not.toHaveBeenCalled();
  });
});

describe('ensureServiceAccountForJob', () => {
  it('ensures the named SA with resolved annotations plus the default SA', async () => {
    mockGetAllConfigs.mockResolvedValue({
      serviceAccount: { name: 'lifecycle-sa', role: 'arn:aws:iam::123:role/lc' },
    });

    const name = await ensureServiceAccountForJob('env-test', 'deploy');

    expect(name).toBe('lifecycle-sa');
    expect(mockCreateNamespacedServiceAccount).toHaveBeenCalledTimes(2);
    expect(mockCreateNamespacedServiceAccount).toHaveBeenNthCalledWith(1, 'env-test', {
      metadata: {
        name: 'lifecycle-sa',
        namespace: 'env-test',
        annotations: { [EKS_KEY]: 'arn:aws:iam::123:role/lc' },
      },
    });
    expect(mockCreateNamespacedServiceAccount).toHaveBeenNthCalledWith(2, 'env-test', {
      metadata: { name: 'default', namespace: 'env-test', annotations: {} },
    });
  });

  it('never emits the seeded replace_me placeholder', async () => {
    mockGetAllConfigs.mockResolvedValue({ serviceAccount: { name: 'default', role: 'replace_me' } });

    const name = await ensureServiceAccountForJob('env-test', 'webhook');

    expect(name).toBe('default');
    expect(mockCreateNamespacedServiceAccount).toHaveBeenCalledTimes(1);
    expect(mockCreateNamespacedServiceAccount).toHaveBeenCalledWith('env-test', {
      metadata: { name: 'default', namespace: 'env-test', annotations: {} },
    });
  });

  it('supports GKE workload identity via the annotations map', async () => {
    mockGetAllConfigs.mockResolvedValue({
      serviceAccount: {
        name: 'lifecycle-tools',
        annotations: { [GKE_KEY]: 'lifecycle-tools@project.iam.gserviceaccount.com' },
      },
    });

    await ensureServiceAccountForJob('env-test', 'build');

    const saBody = mockCreateNamespacedServiceAccount.mock.calls[0][1];
    expect(saBody.metadata.annotations).toEqual({
      [GKE_KEY]: 'lifecycle-tools@project.iam.gserviceaccount.com',
    });
    expect(saBody.metadata.annotations[EKS_KEY]).toBeUndefined();
  });

  it('handles missing serviceAccount config', async () => {
    mockGetAllConfigs.mockResolvedValue({});

    const name = await ensureServiceAccountForJob('env-test', 'deploy');

    expect(name).toBe('default');
    expect(mockCreateNamespacedServiceAccount).toHaveBeenCalledTimes(1);
    expect(mockCreateNamespacedServiceAccount).toHaveBeenCalledWith('env-test', {
      metadata: { name: 'default', namespace: 'env-test', annotations: {} },
    });
  });
});
