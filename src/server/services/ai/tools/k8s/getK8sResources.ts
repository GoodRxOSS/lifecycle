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
import { OutputLimiter } from '../outputLimiter';

export class GetK8sResourcesTool extends BaseTool {
  static readonly Name = 'get_k8s_resources';

  constructor(private k8sClient: K8sClient) {
    super(
      'Get any Kubernetes resource type in a namespace. Supports: pods, deployments, services, ingresses, secrets, configmaps, jobs, statefulsets, daemonsets, replicasets, events. Use this to discover what resources exist in the namespace.',
      {
        type: 'object',
        properties: {
          namespace: { type: 'string', description: 'The Kubernetes namespace' },
          resource_type: {
            type: 'string',
            description:
              'Resource type to list (e.g., "pods", "deployments", "services", "ingresses", "secrets", "configmaps", "jobs", "statefulsets", "events"). Accepts singular or plural forms.',
            enum: [
              'pods',
              'deployments',
              'services',
              'ingresses',
              'secrets',
              'configmaps',
              'jobs',
              'statefulsets',
              'daemonsets',
              'replicasets',
              'events',
            ],
          },
          name: {
            type: 'string',
            description: 'Optional: Get details for a specific resource by name',
          },
          label_selector: {
            type: 'string',
            description: 'Optional: Filter by label selector (e.g., "app=myapp")',
          },
          field_selector: {
            type: 'string',
            description:
              'Optional: Filter by field selector (e.g., "involvedObject.name=mypod"). Primarily used for events.',
          },
        },
        required: ['namespace', 'resource_type'],
      },
      ToolSafetyLevel.SAFE,
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
      const name = args.name as string | undefined;
      const labelSelector = args.label_selector as string | undefined;
      const fieldSelector = args.field_selector as string | undefined;

      const normalizedType = resourceType.toLowerCase().replace(/s$/, '');

      let result: any;

      switch (normalizedType) {
        case 'pod':
          result = name ? await this.getSpecificPod(namespace, name) : await this.getPods(namespace, labelSelector);
          break;

        case 'deployment':
          result = name ? await this.getDeployment(name, namespace) : await this.listDeployments(namespace);
          break;

        case 'service':
          result = await this.listServices(namespace, labelSelector);
          break;

        case 'ingress':
        case 'ingresse':
          result = await this.listIngresses(namespace, labelSelector);
          break;

        case 'secret':
          result = await this.listSecrets(namespace, labelSelector);
          break;

        case 'configmap':
          result = await this.listConfigMaps(namespace, labelSelector);
          break;

        case 'job':
          result = await this.getJobs(namespace, labelSelector);
          break;

        case 'statefulset':
          result = await this.listStatefulSets(namespace, labelSelector);
          break;

        case 'daemonset':
          result = await this.listDaemonSets(namespace, labelSelector);
          break;

        case 'replicaset':
          result = await this.listReplicaSets(namespace, labelSelector);
          break;

        case 'event':
          result = await this.getEvents(namespace, fieldSelector);
          break;

        default:
          return this.createErrorResult(
            `Unsupported resource type: ${resourceType}. Supported types: pods, deployments, services, ingresses, secrets, configmaps, jobs, statefulsets, daemonsets, replicasets, events`,
            'INVALID_RESOURCE_TYPE'
          );
      }

      const displayContent = this.formatDisplay(normalizedType, result);
      const serialized = JSON.stringify(result);
      const agentContent = OutputLimiter.truncateJsonSafely(serialized);
      return this.createSuccessResult(agentContent, displayContent);
    } catch (error: any) {
      return this.createErrorResult(error.message || 'Unknown error', 'EXECUTION_ERROR');
    }
  }

  private async getPods(namespace: string, labelSelector?: string): Promise<any> {
    const response = await this.k8sClient.coreApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    const allPods = response.body.items.map((pod) => ({
      name: pod.metadata?.name,
      phase: pod.status?.phase,
      ready: pod.status?.containerStatuses
        ? `${pod.status.containerStatuses.filter((c) => c.ready).length}/${pod.status.containerStatuses.length}`
        : '0/0',
      restarts: pod.status?.containerStatuses
        ? pod.status.containerStatuses.reduce((sum, c) => sum + c.restartCount, 0)
        : 0,
      age: pod.metadata?.creationTimestamp,
      containers: pod.status?.containerStatuses?.map((c) => ({
        name: c.name,
        ready: c.ready,
        state: Object.keys(c.state || {})[0],
        restarts: c.restartCount,
      })),
    }));

    const isUnhealthy = (pod: any) =>
      pod.phase !== 'Running' ||
      pod.restarts > 5 ||
      pod.containers?.some((c: any) => !c.ready || (c.state !== 'running' && c.state !== undefined));

    const unhealthy = allPods.filter(isUnhealthy);
    const healthy = allPods.filter((p) => !isUnhealthy(p));

    if (allPods.length > 50) {
      return {
        success: true,
        total: allPods.length,
        unhealthyCount: unhealthy.length,
        healthyCount: healthy.length,
        unhealthyPods: unhealthy,
        healthyPods: healthy.map((p) => ({ name: p.name, phase: p.phase, ready: p.ready })),
        note: `${allPods.length} pods total. ${unhealthy.length} unhealthy shown with full detail. ${healthy.length} healthy shown as summary. Use label_selector to narrow results or get_pod_logs for specific pods.`,
      };
    }

    return {
      success: true,
      pods: allPods,
    };
  }

  private async getSpecificPod(namespace: string, name: string): Promise<any> {
    const response = await this.k8sClient.coreApi.readNamespacedPod(name, namespace);
    const pod = response.body;

    return {
      success: true,
      pod: {
        name: pod.metadata?.name,
        phase: pod.status?.phase,
        conditions: pod.status?.conditions,
        containerStatuses: pod.status?.containerStatuses,
        hostIP: pod.status?.hostIP,
        podIP: pod.status?.podIP,
        startTime: pod.status?.startTime,
      },
    };
  }

  private async getDeployment(name: string, namespace: string): Promise<any> {
    const response = await this.k8sClient.appsApi.readNamespacedDeployment(name, namespace);
    const deployment = response.body;

    return {
      success: true,
      deployment: {
        name: deployment.metadata?.name,
        replicas: {
          desired: deployment.spec?.replicas || 0,
          current: deployment.status?.replicas || 0,
          ready: deployment.status?.readyReplicas || 0,
          available: deployment.status?.availableReplicas || 0,
          updated: deployment.status?.updatedReplicas || 0,
        },
        conditions: deployment.status?.conditions?.map((c) => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message,
        })),
        strategy: deployment.spec?.strategy?.type,
        containers: deployment.spec?.template.spec?.containers.map((c) => ({
          name: c.name,
          image: c.image,
        })),
      },
    };
  }

  private async listDeployments(namespace: string): Promise<any> {
    const response = await this.k8sClient.appsApi.listNamespacedDeployment(namespace);

    const allDeployments = response.body.items.map((deployment) => ({
      name: deployment.metadata?.name,
      replicas: {
        desired: deployment.spec?.replicas || 0,
        ready: deployment.status?.readyReplicas || 0,
        available: deployment.status?.availableReplicas || 0,
      },
      age: deployment.metadata?.creationTimestamp,
    }));

    const isUnhealthy = (d: any) => d.replicas.ready < d.replicas.desired || d.replicas.available < d.replicas.desired;

    const unhealthy = allDeployments.filter(isUnhealthy);
    const healthy = allDeployments.filter((d) => !isUnhealthy(d));

    if (allDeployments.length > 50) {
      return {
        success: true,
        total: allDeployments.length,
        unhealthyCount: unhealthy.length,
        healthyCount: healthy.length,
        unhealthyDeployments: unhealthy,
        healthyDeployments: healthy.map((d) => ({ name: d.name, ready: `${d.replicas.ready}/${d.replicas.desired}` })),
        note: `${allDeployments.length} deployments total. ${unhealthy.length} unhealthy shown with full detail. ${healthy.length} healthy shown as summary.`,
      };
    }

    return {
      success: true,
      deployments: allDeployments,
    };
  }

  private async listServices(namespace: string, labelSelector?: string): Promise<any> {
    const response = await this.k8sClient.coreApi.listNamespacedService(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    const allServices = response.body.items.map((svc) => ({
      name: svc.metadata?.name,
      type: svc.spec?.type,
      clusterIP: svc.spec?.clusterIP,
      ports: svc.spec?.ports?.map((p) => ({
        name: p.name,
        port: p.port,
        targetPort: p.targetPort,
        protocol: p.protocol,
      })),
      selector: svc.spec?.selector,
    }));

    if (allServices.length > 50) {
      return {
        success: true,
        total: allServices.length,
        services: allServices.map((s) => ({ name: s.name, type: s.type, ports: s.ports?.map((p: any) => p.port) })),
        note: `${allServices.length} services total. Showing summary. Use label_selector to narrow results.`,
      };
    }

    return {
      success: true,
      services: allServices,
      count: allServices.length,
    };
  }

  private async listIngresses(namespace: string, labelSelector?: string): Promise<any> {
    const response = await this.k8sClient.networkingApi.listNamespacedIngress(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    return {
      success: true,
      ingresses: response.body.items.map((ing) => ({
        name: ing.metadata?.name,
        hosts: ing.spec?.rules?.map((r) => r.host) || [],
        paths: ing.spec?.rules?.flatMap((r) => r.http?.paths?.map((p) => p.path) || []) || [],
        ingressClassName: ing.spec?.ingressClassName,
        tls: ing.spec?.tls?.map((t) => ({ hosts: t.hosts, secretName: t.secretName })),
      })),
      count: response.body.items.length,
    };
  }

  private async listSecrets(namespace: string, labelSelector?: string): Promise<any> {
    const response = await this.k8sClient.coreApi.listNamespacedSecret(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    return {
      success: true,
      secrets: response.body.items.map((secret) => ({
        name: secret.metadata?.name,
        type: secret.type,
        keys: Object.keys(secret.data || {}),
      })),
      count: response.body.items.length,
    };
  }

  private async listConfigMaps(namespace: string, labelSelector?: string): Promise<any> {
    const response = await this.k8sClient.coreApi.listNamespacedConfigMap(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    return {
      success: true,
      configmaps: response.body.items.map((cm) => ({
        name: cm.metadata?.name,
        keys: Object.keys(cm.data || {}),
        dataSize: Object.values(cm.data || {}).reduce((sum, val) => sum + val.length, 0),
      })),
      count: response.body.items.length,
    };
  }

  private async getJobs(namespace: string, labelSelector?: string): Promise<any> {
    const response = await this.k8sClient.batchApi.listNamespacedJob(
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

    jobs.sort((a, b) => {
      const timeA = a.startTime ? new Date(a.startTime).getTime() : 0;
      const timeB = b.startTime ? new Date(b.startTime).getTime() : 0;
      return timeB - timeA;
    });

    if (jobs.length > 50) {
      const failed = jobs.filter((j) => j.failed > 0);
      const active = jobs.filter((j) => j.active > 0);
      const recent = jobs.slice(0, 20);
      return {
        success: true,
        total: jobs.length,
        failedCount: failed.length,
        activeCount: active.length,
        failedJobs: failed.slice(0, 20),
        activeJobs: active,
        recentJobs: recent,
        note: `${jobs.length} jobs total. ${failed.length} failed, ${active.length} active. Use label_selector to narrow results.`,
      };
    }

    return {
      success: true,
      jobs,
      count: jobs.length,
      note: 'Jobs are sorted by startTime (newest first). Always check the LATEST job for each service.',
    };
  }

  private async listStatefulSets(namespace: string, labelSelector?: string): Promise<any> {
    const response = await this.k8sClient.appsApi.listNamespacedStatefulSet(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    return {
      success: true,
      statefulsets: response.body.items.map((sts) => ({
        name: sts.metadata?.name,
        replicas: {
          desired: sts.spec?.replicas || 0,
          ready: sts.status?.readyReplicas || 0,
          current: sts.status?.replicas || 0,
        },
        serviceName: sts.spec?.serviceName,
      })),
      count: response.body.items.length,
    };
  }

  private async listDaemonSets(namespace: string, labelSelector?: string): Promise<any> {
    const response = await this.k8sClient.appsApi.listNamespacedDaemonSet(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    return {
      success: true,
      daemonsets: response.body.items.map((ds) => ({
        name: ds.metadata?.name,
        desired: ds.status?.desiredNumberScheduled || 0,
        current: ds.status?.currentNumberScheduled || 0,
        ready: ds.status?.numberReady || 0,
        available: ds.status?.numberAvailable || 0,
      })),
      count: response.body.items.length,
    };
  }

  private async listReplicaSets(namespace: string, labelSelector?: string): Promise<any> {
    const response = await this.k8sClient.appsApi.listNamespacedReplicaSet(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    return {
      success: true,
      replicasets: response.body.items.map((rs) => ({
        name: rs.metadata?.name,
        replicas: {
          desired: rs.spec?.replicas || 0,
          ready: rs.status?.readyReplicas || 0,
          available: rs.status?.availableReplicas || 0,
        },
        ownerReferences: rs.metadata?.ownerReferences?.map((ref) => ({
          kind: ref.kind,
          name: ref.name,
        })),
      })),
      count: response.body.items.length,
    };
  }

  private async getEvents(namespace: string, fieldSelector?: string): Promise<any> {
    const response = await this.k8sClient.coreApi.listNamespacedEvent(
      namespace,
      undefined,
      undefined,
      undefined,
      fieldSelector
    );

    const allEvents = response.body.items
      .sort((a, b) => {
        const aTime = new Date(a.lastTimestamp || a.eventTime || 0).getTime();
        const bTime = new Date(b.lastTimestamp || b.eventTime || 0).getTime();
        return bTime - aTime;
      })
      .map((event) => ({
        type: event.type,
        reason: event.reason,
        message: event.message,
        count: event.count,
        involvedObject: {
          kind: event.involvedObject?.kind,
          name: event.involvedObject?.name,
        },
        lastTimestamp: event.lastTimestamp || event.eventTime,
      }));

    const warnings = allEvents.filter((e) => e.type === 'Warning');
    const normal = allEvents.filter((e) => e.type !== 'Warning');

    return {
      success: true,
      total: allEvents.length,
      warningCount: warnings.length,
      normalCount: normal.length,
      warnings: warnings.slice(0, 50),
      recentNormal: normal.slice(0, 10),
      note: `${allEvents.length} events total. ${warnings.length} warnings shown first (up to 50), then ${Math.min(
        normal.length,
        10
      )} recent normal events.`,
    };
  }

  private formatDisplay(resourceType: string, result: any): string {
    if (resourceType === 'pod' && result.total && result.unhealthyPods) {
      const unhealthyList = result.unhealthyPods
        .map((p: any) => `  - ${p.name}: ${p.phase} (${p.ready} ready, ${p.restarts} restarts)`)
        .join('\n');
      return `${result.total} pods (${result.unhealthyCount} unhealthy, ${result.healthyCount} healthy)${
        unhealthyList ? `\nUnhealthy:\n${unhealthyList}` : ''
      }`;
    }

    if (resourceType === 'pod' && result.pods) {
      return `Found ${result.pods.length} pods:\n${result.pods
        .map((p: any) => `  - ${p.name}: ${p.phase} (${p.ready} ready, ${p.restarts} restarts)`)
        .join('\n')}`;
    }

    if (resourceType === 'pod' && result.pod) {
      return `Pod: ${result.pod.name} (${result.pod.phase})`;
    }

    if (resourceType === 'deployment' && result.total && result.unhealthyDeployments) {
      const unhealthyList = result.unhealthyDeployments
        .map((d: any) => `  - ${d.name}: ${d.replicas.ready}/${d.replicas.desired} ready`)
        .join('\n');
      return `${result.total} deployments (${result.unhealthyCount} unhealthy, ${result.healthyCount} healthy)${
        unhealthyList ? `\nUnhealthy:\n${unhealthyList}` : ''
      }`;
    }

    if (resourceType === 'deployment' && result.deployment) {
      return `Deployment: ${result.deployment.name} (${result.deployment.replicas.ready}/${result.deployment.replicas.desired} ready)`;
    }

    if (resourceType === 'event' && result.total != null) {
      return `${result.total} events (${result.warningCount} warnings, ${result.normalCount} normal)`;
    }

    const listKeys: Record<string, string> = {
      deployments: 'deployments',
      services: 'services',
      ingresses: 'ingresses',
      secrets: 'secrets',
      configmaps: 'configmaps',
      jobs: 'jobs',
      statefulsets: 'statefulsets',
      daemonsets: 'daemonsets',
      replicasets: 'replicasets',
      events: 'events',
    };

    const pluralType = resourceType + 's';
    const key = listKeys[pluralType];
    if (key && Array.isArray(result[key])) {
      return `Found ${result[key].length} ${pluralType}`;
    }

    return `K8s ${resourceType} result`;
  }
}
