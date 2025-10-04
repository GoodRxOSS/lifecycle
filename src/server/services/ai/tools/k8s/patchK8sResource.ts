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
import { ToolResult, ToolSafetyLevel } from '../../types/tool';
import { K8sClient } from '../shared/k8sClient';

export class PatchK8sResourceTool extends BaseTool {
  static readonly Name = 'patch_k8s_resource';

  constructor(private k8sClient: K8sClient) {
    super(
      'Modify Kubernetes resources. Supports operations: patch (update config), scale (change replicas), restart (rolling restart), delete (delete pod/job). Use this to fix misconfigurations or manage resource lifecycle.',
      {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'The Kubernetes namespace' },
          resource_type: {
            type: 'string',
            description: 'Resource type (e.g., "deployment", "pod", "job")',
          },
          name: { type: 'string', description: 'The resource name' },
          operation: {
            type: 'string',
            description: 'Operation to perform: "patch", "scale", "restart", or "delete"',
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
      },
      ToolSafetyLevel.DANGEROUS,
      'k8s'
    );
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (this.checkAborted(signal)) {
      return this.createErrorResult('Operation cancelled', 'CANCELLED', false);
    }

    try {
      const namespace = args.namespace as string;
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

        case 'delete':
          result = await this.handleDeleteOperation(normalizedType, name, namespace);
          break;

        default:
          return this.createErrorResult(
            `Unknown operation: ${operation}. Supported operations: patch, scale, restart, delete`,
            'INVALID_OPERATION'
          );
      }

      return this.createSuccessResult(JSON.stringify(result));
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

  private async handleDeleteOperation(resourceType: string, name: string, namespace: string): Promise<any> {
    if (resourceType === 'pod') {
      return this.deletePod(name, namespace);
    } else if (resourceType === 'job') {
      return this.deleteJob(name, namespace);
    }
    throw new Error(`Delete operation not supported for resource type: ${resourceType}`);
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

  private async deletePod(podName: string, namespace: string): Promise<any> {
    await this.k8sClient.coreApi.deleteNamespacedPod(podName, namespace);

    return {
      success: true,
      message: `Successfully deleted pod ${podName}. Kubernetes will create a new pod automatically.`,
    };
  }

  private async deleteJob(jobName: string, namespace: string): Promise<any> {
    await this.k8sClient.batchApi.deleteNamespacedJob(
      jobName,
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      'Background'
    );

    return {
      success: true,
      message: `Successfully deleted job ${jobName}.`,
    };
  }
}
