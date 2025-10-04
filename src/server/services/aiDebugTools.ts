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
import BaseService from './_service';

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export default class AIDebugToolsService extends BaseService {
  private kc: k8s.KubeConfig;
  private coreApi: k8s.CoreV1Api;
  private appsApi: k8s.AppsV1Api;

  constructor(db: any, redis: any) {
    super(db, redis);
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'get_pods',
        description:
          'Get current pod status in a namespace. Use this to check pod states, readiness, and container statuses.',
        input_schema: {
          type: 'object',
          properties: {
            namespace: { type: 'string', description: 'The Kubernetes namespace' },
            label_selector: {
              type: 'string',
              description: 'Optional label selector (e.g., "app=myapp" or "deployment=my-uuid")',
            },
          },
          required: ['namespace'],
        },
      },
      {
        name: 'get_deployment',
        description:
          'Get detailed information about a specific Kubernetes Deployment including replica counts, conditions, and strategy.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The deployment name' },
            namespace: { type: 'string', description: 'The Kubernetes namespace' },
          },
          required: ['name', 'namespace'],
        },
      },
      {
        name: 'get_pod_logs',
        description: 'Fetch recent logs from a specific pod. Use this to diagnose application errors.',
        input_schema: {
          type: 'object',
          properties: {
            pod_name: { type: 'string', description: 'The pod name' },
            namespace: { type: 'string', description: 'The Kubernetes namespace' },
            container: { type: 'string', description: 'Optional specific container name' },
            tail_lines: { type: 'number', description: 'Number of log lines to fetch (default: 100)' },
          },
          required: ['pod_name', 'namespace'],
        },
      },
      {
        name: 'get_events',
        description:
          'Get recent Kubernetes events for a namespace or specific resource. Useful for diagnosing deployment issues.',
        input_schema: {
          type: 'object',
          properties: {
            namespace: { type: 'string', description: 'The Kubernetes namespace' },
            field_selector: {
              type: 'string',
              description: 'Optional field selector (e.g., "involvedObject.name=mypod")',
            },
          },
          required: ['namespace'],
        },
      },
      {
        name: 'list_deployments',
        description: 'List all deployments in a namespace with their current status.',
        input_schema: {
          type: 'object',
          properties: {
            namespace: { type: 'string', description: 'The Kubernetes namespace' },
          },
          required: ['namespace'],
        },
      },
      {
        name: 'patch_deployment',
        description:
          'Update a deployment configuration (e.g., change probe ports, environment variables, resource limits). Use this to fix misconfigurations.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The deployment name' },
            namespace: { type: 'string', description: 'The Kubernetes namespace' },
            patch: {
              type: 'object',
              description:
                'JSON patch object following Kubernetes strategic merge patch format. Example: {"spec":{"template":{"spec":{"containers":[{"name":"myapp","readinessProbe":{"httpGet":{"port":8080}}}]}}}}',
            },
          },
          required: ['name', 'namespace', 'patch'],
        },
      },
      {
        name: 'scale_deployment',
        description:
          'Scale a deployment to a specific number of replicas. Use this to scale up/down or to quickly restart all pods by scaling to 0 then back up.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The deployment name' },
            namespace: { type: 'string', description: 'The Kubernetes namespace' },
            replicas: { type: 'number', description: 'The desired number of replicas' },
          },
          required: ['name', 'namespace', 'replicas'],
        },
      },
      {
        name: 'restart_deployment',
        description: 'Perform a rolling restart of a deployment. This recreates all pods without downtime.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The deployment name' },
            namespace: { type: 'string', description: 'The Kubernetes namespace' },
          },
          required: ['name', 'namespace'],
        },
      },
      {
        name: 'delete_pod',
        description:
          'Delete a specific pod to force it to restart. Kubernetes will automatically create a new pod. Use this when a pod is stuck or needs a hard restart.',
        input_schema: {
          type: 'object',
          properties: {
            pod_name: { type: 'string', description: 'The pod name to delete' },
            namespace: { type: 'string', description: 'The Kubernetes namespace' },
          },
          required: ['pod_name', 'namespace'],
        },
      },
      {
        name: 'get_jobs',
        description:
          'List Kubernetes Jobs in a namespace. Use this to find build jobs and deploy jobs. Jobs are named like {deploy-uuid}-{engine}-{jobId}-{shortSha} for builds or {deploy-uuid}-helm-{jobId}-{shortSha} for deploys.',
        input_schema: {
          type: 'object',
          properties: {
            namespace: { type: 'string', description: 'The Kubernetes namespace' },
            label_selector: { type: 'string', description: 'Optional label selector (e.g., "job-name=my-job")' },
          },
          required: ['namespace'],
        },
      },
    ];
  }

  async executeTool(toolName: string, input: any): Promise<any> {
    switch (toolName) {
      case 'get_pods':
        return this.getPods(input.namespace, input.label_selector);
      case 'get_deployment':
        return this.getDeployment(input.name, input.namespace);
      case 'get_pod_logs':
        return this.getPodLogs(input.pod_name, input.namespace, input.container, input.tail_lines);
      case 'get_events':
        return this.getEvents(input.namespace, input.field_selector);
      case 'list_deployments':
        return this.listDeployments(input.namespace);
      case 'patch_deployment':
        return this.patchDeployment(input.name, input.namespace, input.patch);
      case 'scale_deployment':
        return this.scaleDeployment(input.name, input.namespace, input.replicas);
      case 'restart_deployment':
        return this.restartDeployment(input.name, input.namespace);
      case 'delete_pod':
        return this.deletePod(input.pod_name, input.namespace);
      case 'get_jobs':
        return this.getJobs(input.namespace, input.label_selector);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private async getPods(namespace: string, labelSelector?: string): Promise<any> {
    try {
      const response = await this.coreApi.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector
      );

      return {
        success: true,
        pods: response.body.items.map((pod) => ({
          name: pod.metadata.name,
          phase: pod.status.phase,
          ready: pod.status.containerStatuses
            ? `${pod.status.containerStatuses.filter((c) => c.ready).length}/${pod.status.containerStatuses.length}`
            : '0/0',
          restarts: pod.status.containerStatuses
            ? pod.status.containerStatuses.reduce((sum, c) => sum + c.restartCount, 0)
            : 0,
          age: pod.metadata.creationTimestamp,
          containers: pod.status.containerStatuses?.map((c) => ({
            name: c.name,
            ready: c.ready,
            state: Object.keys(c.state || {})[0],
            restarts: c.restartCount,
          })),
        })),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  private async getDeployment(name: string, namespace: string): Promise<any> {
    try {
      const response = await this.appsApi.readNamespacedDeployment(name, namespace);
      const deployment = response.body;

      return {
        success: true,
        deployment: {
          name: deployment.metadata.name,
          replicas: {
            desired: deployment.spec.replicas || 0,
            current: deployment.status.replicas || 0,
            ready: deployment.status.readyReplicas || 0,
            available: deployment.status.availableReplicas || 0,
            updated: deployment.status.updatedReplicas || 0,
          },
          conditions: deployment.status.conditions?.map((c) => ({
            type: c.type,
            status: c.status,
            reason: c.reason,
            message: c.message,
          })),
          strategy: deployment.spec.strategy?.type,
          containers: deployment.spec.template.spec.containers.map((c) => ({
            name: c.name,
            image: c.image,
          })),
        },
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  private async getPodLogs(
    podName: string,
    namespace: string,
    container?: string,
    tailLines: number = 100
  ): Promise<any> {
    try {
      const response = await this.coreApi.readNamespacedPodLog(
        podName,
        namespace,
        container,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tailLines
      );

      return {
        success: true,
        logs: response.body,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  private async getEvents(namespace: string, fieldSelector?: string): Promise<any> {
    try {
      const response = await this.coreApi.listNamespacedEvent(
        namespace,
        undefined,
        undefined,
        undefined,
        fieldSelector
      );

      return {
        success: true,
        events: response.body.items
          .sort((a, b) => {
            const aTime = new Date(a.lastTimestamp || a.eventTime || 0).getTime();
            const bTime = new Date(b.lastTimestamp || b.eventTime || 0).getTime();
            return bTime - aTime;
          })
          .slice(0, 50)
          .map((event) => ({
            type: event.type,
            reason: event.reason,
            message: event.message,
            count: event.count,
            involvedObject: {
              kind: event.involvedObject.kind,
              name: event.involvedObject.name,
            },
            lastTimestamp: event.lastTimestamp || event.eventTime,
          })),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  private async listDeployments(namespace: string): Promise<any> {
    try {
      const response = await this.appsApi.listNamespacedDeployment(namespace);

      return {
        success: true,
        deployments: response.body.items.map((deployment) => ({
          name: deployment.metadata.name,
          replicas: {
            desired: deployment.spec.replicas || 0,
            ready: deployment.status.readyReplicas || 0,
            available: deployment.status.availableReplicas || 0,
          },
          age: deployment.metadata.creationTimestamp,
        })),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  private async patchDeployment(name: string, namespace: string, patch: any): Promise<any> {
    try {
      const response = await this.appsApi.patchNamespacedDeployment(
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
          name: response.body.metadata.name,
          replicas: {
            desired: response.body.spec.replicas || 0,
            ready: response.body.status.readyReplicas || 0,
          },
        },
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  private async scaleDeployment(name: string, namespace: string, replicas: number): Promise<any> {
    try {
      // First verify the deployment exists
      const existing = await this.appsApi.readNamespacedDeployment(name, namespace);
      const currentReplicas = existing.body.spec.replicas || 0;

      const patch = {
        spec: {
          replicas,
        },
      };

      const response = await this.appsApi.patchNamespacedDeployment(
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
          name: response.body.metadata.name,
          replicas: {
            desired: response.body.spec.replicas || 0,
            current: response.body.status.replicas || 0,
            ready: response.body.status.readyReplicas || 0,
            available: response.body.status.availableReplicas || 0,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: `Failed to scale deployment "${name}" in namespace "${namespace}". Error: ${error.message}`,
      };
    }
  }

  private async restartDeployment(name: string, namespace: string): Promise<any> {
    try {
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

      await this.appsApi.patchNamespacedDeployment(
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
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  private async deletePod(podName: string, namespace: string): Promise<any> {
    try {
      await this.coreApi.deleteNamespacedPod(podName, namespace);

      return {
        success: true,
        message: `Successfully deleted pod ${podName}. Kubernetes will create a new pod automatically.`,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  private async getJobs(namespace: string, labelSelector?: string): Promise<any> {
    try {
      const batchApi = this.kc.makeApiClient(k8s.BatchV1Api);
      const response = await batchApi.listNamespacedJob(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        labelSelector
      );

      const jobs = response.body.items.map((job) => ({
        name: job.metadata?.name,
        namespace: job.metadata?.namespace,
        active: job.status?.active || 0,
        succeeded: job.status?.succeeded || 0,
        failed: job.status?.failed || 0,
        completionTime: job.status?.completionTime,
        startTime: job.status?.startTime,
        conditions: job.status?.conditions,
        labels: job.metadata?.labels,
      }));

      // Sort jobs by startTime (newest first) so AI can easily find latest jobs
      jobs.sort((a, b) => {
        const timeA = a.startTime ? new Date(a.startTime).getTime() : 0;
        const timeB = b.startTime ? new Date(b.startTime).getTime() : 0;
        return timeB - timeA; // Descending order (newest first)
      });

      return {
        success: true,
        jobs,
        count: jobs.length,
        note: 'Jobs are sorted by startTime (newest first). Always check the LATEST job for each service.',
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}
