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

import { BaseTool } from '../baseTool';
import { ToolResult } from '../types';
import { K8sClient } from '../shared/k8sClient';

export class PatchK8sResourceTool extends BaseTool {
  static readonly Name = 'patch_k8s_resource';

  constructor(private k8sClient: K8sClient) {
    super(
      "Modify Kubernetes resources in THIS environment's namespace. Supports operations: patch (update config), scale (change replicas), restart (rolling restart). IMPORTANT: these changes are EPHEMERAL — Lifecycle reverts patch/scale/restart on the next deploy/reconcile. Use them only to validate a hypothesis or temporarily unblock. The DURABLE fix is an approval-gated update_file to lifecycle.yaml or its referenced files. The namespace defaults to this environment's namespace; any other namespace is rejected.",
      {
        type: 'object',
        properties: {
          namespace: {
            type: 'string',
            description:
              "Optional. Defaults to this environment's namespace. If provided, it MUST equal the environment's namespace; any other value is rejected.",
          },
          resource_type: {
            type: 'string',
            description: 'Resource type (e.g., "deployment", "pod", "job")',
          },
          name: { type: 'string', description: 'The resource name' },
          operation: {
            type: 'string',
            description:
              'Operation to perform: "patch", "scale", or "restart". All are ephemeral and reverted on the next deploy/reconcile.',
            enum: ['patch', 'scale', 'restart'],
          },
          patch: {
            type: 'object',
            description:
              'For operation=patch: JSON patch object following Kubernetes strategic merge patch format. Example: {"spec":{"template":{"spec":{"containers":[{"name":"myapp","readinessProbe":{"httpGet":{"port":8080}}}]}}}}',
          },
          replicas: {
            type: 'number',
            description: 'For operation=scale: The desired number of replicas',
          },
        },
        required: ['namespace', 'resource_type', 'name', 'operation'],
      }
    );
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (this.checkAborted(signal)) {
      return this.createErrorResult('Operation cancelled', 'CANCELLED');
    }

    let namespace: string;
    try {
      // SECURITY: lock to the build's namespace; reject any foreign namespace.
      namespace = this.k8sClient.resolveNamespace(args.namespace as string | undefined);
    } catch (error: any) {
      return this.createErrorResult(error.message || 'Namespace not allowed', 'NAMESPACE_NOT_ALLOWED');
    }

    try {
      const resourceType = args.resource_type as string;
      const name = args.name as string;
      const operation = args.operation as string;
      const patch = args.patch as any;
      const replicas = args.replicas as number | undefined;

      const normalizedType = resourceType.toLowerCase().replace(/s$/, '');
      const normalizedOp = operation.toLowerCase();

      let result: any;

      switch (normalizedOp) {
        case 'patch':
          if (!patch) {
            return this.createErrorResult('Patch operation requires a patch object', 'INVALID_PARAMETERS');
          }
          result = await this.handlePatchOperation(normalizedType, name, namespace, patch);
          break;

        case 'scale':
          if (replicas === undefined) {
            return this.createErrorResult('Scale operation requires replicas parameter', 'INVALID_PARAMETERS');
          }
          result = await this.handleScaleOperation(normalizedType, name, namespace, replicas);
          break;

        case 'restart':
          result = await this.handleRestartOperation(normalizedType, name, namespace);
          break;

        default:
          return this.createErrorResult(
            `Unknown operation: ${operation}. Supported operations: patch, scale, restart`,
            'INVALID_OPERATION'
          );
      }

      const displayContent = `${normalizedOp} ${normalizedType}/${name} in ${namespace}`;
      return this.createSuccessResult(JSON.stringify(result), displayContent);
    } catch (error: any) {
      return this.createErrorResult(error.message || 'Failed to modify resource', 'EXECUTION_ERROR');
    }
  }

  private async handlePatchOperation(resourceType: string, name: string, namespace: string, patch: any): Promise<any> {
    if (resourceType === 'deployment') {
      return this.patchDeployment(name, namespace, patch);
    }
    throw new Error(`Patch operation not supported for resource type: ${resourceType}`);
  }

  private async handleScaleOperation(
    resourceType: string,
    name: string,
    namespace: string,
    replicas: number
  ): Promise<any> {
    if (resourceType === 'deployment') {
      return this.scaleDeployment(name, namespace, replicas);
    }
    throw new Error(`Scale operation not supported for resource type: ${resourceType}`);
  }

  private async handleRestartOperation(resourceType: string, name: string, namespace: string): Promise<any> {
    if (resourceType === 'deployment') {
      return this.restartDeployment(name, namespace);
    }
    throw new Error(`Restart operation not supported for resource type: ${resourceType}`);
  }

  private async patchDeployment(name: string, namespace: string, patch: any): Promise<any> {
    const response = await this.k8sClient.appsApi.patchNamespacedDeployment(
      name,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
      }
    );

    return {
      success: true,
      message: `Successfully patched deployment ${name}`,
      deployment: {
        name: response.body.metadata?.name,
        replicas: {
          desired: response.body.spec?.replicas || 0,
          ready: response.body.status?.readyReplicas || 0,
        },
      },
    };
  }

  private async scaleDeployment(name: string, namespace: string, replicas: number): Promise<any> {
    const existing = await this.k8sClient.appsApi.readNamespacedDeployment(name, namespace);
    const currentReplicas = existing.body.spec?.replicas || 0;

    const patch = {
      spec: {
        replicas,
      },
    };

    const response = await this.k8sClient.appsApi.patchNamespacedDeployment(
      name,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
      }
    );

    return {
      success: true,
      message: `Scaled deployment ${name} from ${currentReplicas} to ${replicas} replicas`,
      before: {
        desired: currentReplicas,
      },
      after: {
        name: response.body.metadata?.name,
        replicas: {
          desired: response.body.spec?.replicas || 0,
          current: response.body.status?.replicas || 0,
          ready: response.body.status?.readyReplicas || 0,
          available: response.body.status?.availableReplicas || 0,
        },
      },
    };
  }

  private async restartDeployment(name: string, namespace: string): Promise<any> {
    const now = new Date().toISOString();
    const patch = {
      spec: {
        template: {
          metadata: {
            annotations: {
              'kubectl.kubernetes.io/restartedAt': now,
            },
          },
        },
      },
    };

    await this.k8sClient.appsApi.patchNamespacedDeployment(
      name,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
      }
    );

    return {
      success: true,
      message: `Successfully triggered rolling restart of deployment ${name}`,
      restartedAt: now,
    };
  }
}
