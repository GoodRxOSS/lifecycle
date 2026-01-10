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

import { V1ServiceAccount, V1Role, V1RoleBinding } from '@kubernetes/client-node';
import * as k8s from '@kubernetes/client-node';
import { getLogger } from '../logger/index';

export interface RBACConfig {
  namespace: string;
  serviceAccountName: string;
  awsRoleArn?: string;
  permissions: 'build' | 'deploy' | 'full';
}

const PERMISSION_RULES = {
  build: [
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
  deploy: [
    {
      apiGroups: ['*'],
      resources: ['*'],
      verbs: ['*'],
    },
  ],
  full: [
    {
      apiGroups: ['*'],
      resources: ['*'],
      verbs: ['*'],
    },
  ],
};

export async function setupServiceAccountWithRBAC(config: RBACConfig): Promise<void> {
  const { namespace, serviceAccountName, awsRoleArn, permissions } = config;

  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
  const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);

  // Create or update ServiceAccount
  const serviceAccount: V1ServiceAccount = {
    metadata: {
      name: serviceAccountName,
      namespace,
      annotations: awsRoleArn
        ? {
            'eks.amazonaws.com/role-arn': awsRoleArn,
          }
        : {},
    },
  };

  try {
    await coreV1Api.createNamespacedServiceAccount(namespace, serviceAccount);
    getLogger().debug(`ServiceAccount: created ${serviceAccountName} namespace=${namespace}`);
  } catch (error) {
    if (error?.response?.statusCode === 409) {
      await coreV1Api.patchNamespacedServiceAccount(
        serviceAccountName,
        namespace,
        serviceAccount,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );
      getLogger().debug(`ServiceAccount: updated ${serviceAccountName} namespace=${namespace}`);
    } else {
      throw error;
    }
  }

  // Create or update Role
  const roleName = `${serviceAccountName}-role`;
  const role: V1Role = {
    metadata: {
      name: roleName,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'lifecycle',
        'app.kubernetes.io/component': 'rbac',
        'app.kubernetes.io/permission-level': permissions,
      },
    },
    rules: PERMISSION_RULES[permissions],
  };

  try {
    await rbacApi.createNamespacedRole(namespace, role);
    getLogger().debug(`RBAC: created role ${roleName} namespace=${namespace}`);
  } catch (error) {
    if (error?.response?.statusCode === 409) {
      await rbacApi.patchNamespacedRole(
        roleName,
        namespace,
        role,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );
      getLogger().debug(`RBAC: updated role ${roleName} namespace=${namespace}`);
    } else {
      throw error;
    }
  }

  // Create RoleBinding
  const roleBindingName = `${serviceAccountName}-binding`;
  const roleBinding: V1RoleBinding = {
    metadata: {
      name: roleBindingName,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'lifecycle',
        'app.kubernetes.io/component': 'rbac',
      },
    },
    subjects: [
      {
        kind: 'ServiceAccount',
        name: serviceAccountName,
        namespace,
      },
    ],
    roleRef: {
      kind: 'Role',
      name: roleName,
      apiGroup: 'rbac.authorization.k8s.io',
    },
  };

  try {
    await rbacApi.createNamespacedRoleBinding(namespace, roleBinding);
    getLogger().debug(`RBAC: created binding ${roleBindingName} namespace=${namespace}`);
  } catch (error) {
    if (error?.response?.statusCode === 409) {
      getLogger().debug(`RBAC: binding exists ${roleBindingName} namespace=${namespace}`);
    } else {
      throw error;
    }
  }
}

export async function setupBuildServiceAccountInNamespace(
  namespace: string,
  serviceAccountName: string = 'native-build-sa',
  awsRoleArn?: string
): Promise<void> {
  await setupServiceAccountWithRBAC({
    namespace,
    serviceAccountName,
    awsRoleArn,
    permissions: 'build',
  });
}

export async function setupDeployServiceAccountInNamespace(
  namespace: string,
  serviceAccountName: string = 'default',
  awsRoleArn?: string
): Promise<void> {
  await setupServiceAccountWithRBAC({
    namespace,
    serviceAccountName,
    awsRoleArn,
    permissions: 'deploy',
  });

  if (serviceAccountName !== 'default') {
    await setupServiceAccountWithRBAC({
      namespace,
      serviceAccountName: 'default',
      permissions: 'deploy',
    });
  }
}

export async function createServiceAccountUsingExistingFunction(
  namespace: string,
  _serviceAccountName: string,
  role?: string
): Promise<void> {
  const { createOrUpdateServiceAccount } = await import('../kubernetes');
  await createOrUpdateServiceAccount({ namespace, role });
}
