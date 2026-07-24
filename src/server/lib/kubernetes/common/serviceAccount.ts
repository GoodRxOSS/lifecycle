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

import * as k8s from '@kubernetes/client-node';
import { V1ServiceAccount } from '@kubernetes/client-node';
import GlobalConfigService from 'server/services/globalConfig';
import { RoleSettings } from 'server/services/types/globalConfig';
import { getLogger } from 'server/lib/logger';
import { ensureRoleAndBinding, ServiceAccountPermissions } from '../rbac';

const PLACEHOLDER_VALUES = new Set(['', 'replace_me', 'default']);

function isPlaceholder(value?: string): boolean {
  return !value || PLACEHOLDER_VALUES.has(value.trim());
}

/**
 * Renders global serviceAccount config into Kubernetes annotations.
 * Legacy `role` maps to the EKS key; explicit `annotations` win on conflict.
 * Placeholder values (empty, replace_me, default) are never emitted.
 */
export function resolveServiceAccountAnnotations(
  settings?: Pick<RoleSettings, 'role' | 'annotations'>
): Record<string, string> {
  const annotations: Record<string, string> = {};
  const role = settings?.role?.trim();
  if (role && !isPlaceholder(role)) {
    annotations['eks.amazonaws.com/role-arn'] = role;
  }
  for (const [key, value] of Object.entries(settings?.annotations ?? {})) {
    if (!isPlaceholder(value)) {
      annotations[key] = value;
    }
  }
  return annotations;
}

/**
 * Single reconciler for service accounts in environment namespaces:
 * creates or patches the ServiceAccount with the given annotations, then
 * ensures its namespace-scoped Role and RoleBinding.
 */
export async function ensureServiceAccount({
  namespace,
  name,
  annotations = {},
  permissions,
}: {
  namespace: string;
  name: string;
  annotations?: Record<string, string>;
  permissions: ServiceAccountPermissions;
}): Promise<void> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

  const serviceAccount: V1ServiceAccount = {
    metadata: { name, namespace, annotations },
  };

  try {
    await coreV1Api.createNamespacedServiceAccount(namespace, serviceAccount);
    getLogger().debug(`ServiceAccount: created ${name} namespace=${namespace}`);
  } catch (error) {
    if (error?.response?.statusCode === 409) {
      await coreV1Api.patchNamespacedServiceAccount(
        name,
        namespace,
        serviceAccount,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );
      getLogger().debug(`ServiceAccount: updated ${name} namespace=${namespace}`);
    } else {
      getLogger({ namespace, serviceAccountName: name, error }).error('ServiceAccount: setup failed');
      throw error;
    }
  }

  await ensureRoleAndBinding({ namespace, serviceAccountName: name, permissions });
}

export async function ensureServiceAccountForJob(
  namespace: string,
  jobType: 'build' | 'deploy' | 'webhook'
): Promise<string> {
  const { serviceAccount } = await GlobalConfigService.getInstance().getAllConfigs();
  const name = serviceAccount?.name || 'default';
  const annotations = resolveServiceAccountAnnotations(serviceAccount);

  getLogger().info(`ServiceAccount: setting up for job type=${jobType} namespace=${namespace} serviceAccount=${name}`);

  await ensureServiceAccount({ namespace, name, annotations, permissions: 'deploy' });
  if (name !== 'default') {
    await ensureServiceAccount({ namespace, name: 'default', permissions: 'deploy' });
  }

  return name;
}
