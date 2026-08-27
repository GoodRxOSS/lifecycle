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

var mockCreateNamespacedRole: jest.Mock;
var mockPatchNamespacedRole: jest.Mock;
var mockCreateNamespacedRoleBinding: jest.Mock;

jest.mock('@kubernetes/client-node', () => {
  mockCreateNamespacedRole = jest.fn();
  mockPatchNamespacedRole = jest.fn();
  mockCreateNamespacedRoleBinding = jest.fn();
  const rbacApi = {
    createNamespacedRole: (...args: unknown[]) => mockCreateNamespacedRole(...args),
    patchNamespacedRole: (...args: unknown[]) => mockPatchNamespacedRole(...args),
    createNamespacedRoleBinding: (...args: unknown[]) => mockCreateNamespacedRoleBinding(...args),
  };
  return {
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn(() => rbacApi),
    })),
    RbacAuthorizationV1Api: jest.fn(),
  };
});

jest.mock('../../logger', () => ({
  getLogger: () => ({ debug: jest.fn() }),
}));

import { ensureRoleAndBinding, ServiceAccountPermissions } from '../rbac';

const readRules = [
  {
    apiGroups: [''],
    resources: [
      'configmaps',
      'endpoints',
      'events',
      'persistentvolumeclaims',
      'pods',
      'pods/log',
      'replicationcontrollers',
      'resourcequotas',
      'services',
    ],
    verbs: ['get', 'list', 'watch'],
  },
  {
    apiGroups: ['apps'],
    resources: ['controllerrevisions', 'daemonsets', 'deployments', 'replicasets', 'statefulsets'],
    verbs: ['get', 'list', 'watch'],
  },
  {
    apiGroups: ['batch'],
    resources: ['cronjobs', 'jobs'],
    verbs: ['get', 'list', 'watch'],
  },
  {
    apiGroups: ['networking.k8s.io'],
    resources: ['ingresses', 'networkpolicies'],
    verbs: ['get', 'list', 'watch'],
  },
  {
    apiGroups: ['autoscaling'],
    resources: ['horizontalpodautoscalers'],
    verbs: ['get', 'list', 'watch'],
  },
  {
    apiGroups: ['discovery.k8s.io'],
    resources: ['endpointslices'],
    verbs: ['get', 'list', 'watch'],
  },
  {
    apiGroups: ['events.k8s.io'],
    resources: ['events'],
    verbs: ['get', 'list', 'watch'],
  },
  {
    apiGroups: ['policy'],
    resources: ['poddisruptionbudgets'],
    verbs: ['get', 'list', 'watch'],
  },
];

const permissionCases: Array<[ServiceAccountPermissions, Array<Record<string, string[]>>]> = [
  [
    'build',
    [
      {
        apiGroups: ['batch'],
        resources: ['jobs'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      {
        apiGroups: [''],
        resources: ['pods', 'pods/log'],
        verbs: ['get', 'list', 'watch'],
      },
    ],
  ],
  ['read', readRules],
  ['deploy', [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }]],
  ['full', [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }]],
];

describe('ensureRoleAndBinding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateNamespacedRole.mockResolvedValue({});
    mockPatchNamespacedRole.mockResolvedValue({});
    mockCreateNamespacedRoleBinding.mockResolvedValue({});
  });

  it.each(permissionCases)(
    'creates the exact %s permission rules and binds them to the service account',
    async (permissions, rules) => {
      await ensureRoleAndBinding({
        namespace: 'env-build',
        serviceAccountName: 'lifecycle-tools',
        permissions,
      });

      expect(mockCreateNamespacedRole).toHaveBeenCalledWith('env-build', {
        metadata: {
          name: 'lifecycle-tools-role',
          namespace: 'env-build',
          labels: {
            'app.kubernetes.io/managed-by': 'lifecycle',
            'app.kubernetes.io/component': 'rbac',
            'app.kubernetes.io/permission-level': permissions,
          },
        },
        rules,
      });
      expect(mockCreateNamespacedRoleBinding).toHaveBeenCalledWith('env-build', {
        metadata: {
          name: 'lifecycle-tools-binding',
          namespace: 'env-build',
          labels: {
            'app.kubernetes.io/managed-by': 'lifecycle',
            'app.kubernetes.io/component': 'rbac',
          },
        },
        subjects: [{ kind: 'ServiceAccount', name: 'lifecycle-tools', namespace: 'env-build' }],
        roleRef: {
          kind: 'Role',
          name: 'lifecycle-tools-role',
          apiGroup: 'rbac.authorization.k8s.io',
        },
      });
      expect(mockPatchNamespacedRole).not.toHaveBeenCalled();
    }
  );

  it('patches an existing role with merge-patch and tolerates an existing binding', async () => {
    mockCreateNamespacedRole.mockRejectedValueOnce({ response: { statusCode: 409 } });
    mockCreateNamespacedRoleBinding.mockRejectedValueOnce({ response: { statusCode: 409 } });

    await expect(
      ensureRoleAndBinding({ namespace: 'env-build', serviceAccountName: 'builder', permissions: 'build' })
    ).resolves.toBeUndefined();

    const role = mockCreateNamespacedRole.mock.calls[0][1];
    expect(mockPatchNamespacedRole).toHaveBeenCalledWith(
      'builder-role',
      'env-build',
      role,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
  });

  it('rethrows a non-conflict role creation failure without creating a binding', async () => {
    const failure = new Error('forbidden');
    mockCreateNamespacedRole.mockRejectedValueOnce(failure);

    await expect(
      ensureRoleAndBinding({ namespace: 'env-build', serviceAccountName: 'builder', permissions: 'build' })
    ).rejects.toBe(failure);
    expect(mockPatchNamespacedRole).not.toHaveBeenCalled();
    expect(mockCreateNamespacedRoleBinding).not.toHaveBeenCalled();
  });

  it('rethrows a non-conflict role binding failure', async () => {
    const failure = new Error('binding failed');
    mockCreateNamespacedRoleBinding.mockRejectedValueOnce(failure);

    await expect(
      ensureRoleAndBinding({ namespace: 'env-build', serviceAccountName: 'builder', permissions: 'read' })
    ).rejects.toBe(failure);
    expect(mockCreateNamespacedRole).toHaveBeenCalledTimes(1);
  });
});
