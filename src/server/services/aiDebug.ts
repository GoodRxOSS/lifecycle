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

import BaseService from './_service';
import * as k8s from '@kubernetes/client-node';
import {
  DebugContext,
  LifecycleContext,
  ServiceDebugInfo,
  PodDebugInfo,
  DiagnosedIssue,
  ContextWarning,
  ContextError,
  K8sEvent,
} from './types/aiDebug';
import AIDebugGitHubToolsService from './aiDebugGitHubTools';

export default class AIDebugService extends BaseService {
  async gatherFullContext(buildUuid: string): Promise<DebugContext> {
    const warnings: ContextWarning[] = [];
    const errors: ContextError[] = [];

    const build = await this.db.models.Build.query()
      .findOne({ uuid: buildUuid })
      .withGraphFetched(
        '[pullRequest.repository, environment, deploys.[service, repository, deployable], deployables]'
      );

    if (!build) {
      throw new Error(`Build not found: ${buildUuid}`);
    }

    let lifecycleContext;
    let kubernetesServices;
    let lifecycleYaml;

    try {
      lifecycleContext = await this.gatherLifecycleContext(build);
    } catch (error) {
      errors.push({
        source: 'lifecycle',
        message: 'Failed to gather Lifecycle database context',
        error: error.message,
        recoverable: false,
      });
      throw error;
    }

    try {
      kubernetesServices = await this.gatherKubernetesInfo(build, warnings, errors);
    } catch (error) {
      errors.push({
        source: 'kubernetes',
        message: 'Failed to gather Kubernetes context',
        error: error.message,
        recoverable: true,
      });
      kubernetesServices = [];
    }

    // Fetch lifecycle.yaml from GitHub
    try {
      const gitHubTools = new AIDebugGitHubToolsService(this.db, this.redis);
      const fullName = build.pullRequest.fullName;
      const branch = build.pullRequest.branchName;

      if (fullName && branch) {
        const [owner, repo] = fullName.split('/');
        const result = await gitHubTools.executeTool('get_lifecycle_config', {
          repository_owner: owner,
          repository_name: repo,
          branch,
        });

        if (result.success) {
          lifecycleYaml = {
            path: result.path,
            content: result.content,
          };
        } else {
          lifecycleYaml = {
            path: 'lifecycle.yaml',
            content: '',
            error: result.error,
          };
          warnings.push({
            source: 'lifecycle',
            message: 'Could not fetch lifecycle.yaml from repository',
            details: result.error,
          });
        }
      }
    } catch (error) {
      warnings.push({
        source: 'lifecycle',
        message: 'Failed to fetch lifecycle.yaml',
        details: error.message,
      });
    }

    return {
      buildUuid,
      namespace: build.namespace,
      lifecycleContext,
      lifecycleYaml,
      services: kubernetesServices,
      gatheredAt: new Date(),
      warnings: warnings.length > 0 ? warnings : undefined,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  private async gatherLifecycleContext(build: any): Promise<LifecycleContext> {
    return {
      build: {
        uuid: build.uuid,
        status: build.status,
        statusMessage: build.statusMessage,
        namespace: build.namespace,
        sha: build.sha,
        trackDefaultBranches: build.trackDefaultBranches,
        capacityType: build.capacityType,
        enabledFeatures: build.enabledFeatures || [],
        dependencyGraph: build.dependencyGraph || {},
        dashboardLinks: build.dashboardLinks || {},
        createdAt: build.createdAt,
        updatedAt: build.updatedAt,
      },
      pullRequest: {
        number: build.pullRequest.number,
        title: build.pullRequest.title,
        username: build.pullRequest.githubLogin,
        branch: build.pullRequest.branchName,
        baseBranch: 'main', // TODO: Get from repository default branch
        status: build.pullRequest.status,
        url: `https://github.com/${build.pullRequest.fullName}/pull/${build.pullRequest.pullRequestNumber}`,
        latestCommit: build.pullRequest.latestCommit,
        fullName: build.pullRequest.fullName,
      },
      environment: {
        id: build.environment.id,
        name: build.environment.name,
        config: build.environment.config || {},
      },
      deploys: build.deploys.map((deploy: any) => ({
        uuid: deploy.uuid,
        serviceName: deploy.serviceName,
        status: deploy.status,
        statusMessage: deploy.statusMessage,
        type: deploy.type,
        dockerImage: deploy.dockerImage,
        branch: deploy.branch,
        repoName: deploy.repoName,
        buildNumber: deploy.buildNumber,
        env: deploy.env || {},
        initEnv: deploy.initEnv || {},
        createdAt: deploy.createdAt,
        updatedAt: deploy.updatedAt,
      })),
      repository: {
        name: build.pullRequest.repository.name,
        githubRepositoryId: build.pullRequest.repository.githubRepositoryId,
        url: build.pullRequest.repository.url,
      },
      deployables:
        build.deployables?.map((deployable: any) => ({
          serviceName: deployable.serviceName,
          repositoryId: deployable.repositoryId,
          defaultBranchName: deployable.defaultBranchName,
          commentBranchName: deployable.commentBranchName,
          helm: deployable.helm,
          deploymentDependsOn: deployable.deploymentDependsOn || [],
          builder: deployable.builder,
        })) || [],
    };
  }

  private async gatherKubernetesInfo(
    build: any,
    warnings: ContextWarning[],
    errors: ContextError[]
  ): Promise<ServiceDebugInfo[]> {
    const namespace = build.namespace;
    const services: ServiceDebugInfo[] = [];

    for (const deploy of build.deploys || []) {
      try {
        const serviceInfo = await this.gatherServiceDebugInfo(deploy, namespace, warnings);
        services.push(serviceInfo);
      } catch (error) {
        errors.push({
          source: 'kubernetes',
          message: `Failed to gather info for service ${deploy.serviceName}`,
          error: error.message,
          recoverable: true,
        });
      }
    }

    return services;
  }

  private async gatherServiceDebugInfo(
    deploy: any,
    namespace: string,
    warnings: ContextWarning[]
  ): Promise<ServiceDebugInfo> {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);

    let pods: PodDebugInfo[] = [];
    let events: K8sEvent[] = [];
    let deployment: any = undefined;

    try {
      pods = await this.gatherPodsInfo(deploy.uuid, deploy.serviceName, namespace, coreApi, warnings);
    } catch (error) {
      warnings.push({
        source: 'kubernetes',
        message: `Could not fetch pods for ${deploy.serviceName} (${deploy.uuid})`,
        details: error.message,
      });
    }

    try {
      events = await this.getServiceEvents(deploy.serviceName, namespace, coreApi);
    } catch (error) {
      warnings.push({
        source: 'kubernetes',
        message: `Could not fetch events for ${deploy.serviceName}`,
        details: error.message,
      });
    }

    try {
      deployment = await this.gatherDeploymentInfo(deploy.uuid, namespace, appsApi);
    } catch (error) {
      warnings.push({
        source: 'kubernetes',
        message: `Could not fetch deployment for ${deploy.serviceName} (${deploy.uuid})`,
        details: error.message,
      });
    }

    const issues = this.diagnoseIssues(pods, events);

    return {
      name: deploy.serviceName,
      type: deploy.type,
      status: this.determineServiceStatus(deploy, pods),
      deployInfo: {
        uuid: deploy.uuid,
        serviceName: deploy.serviceName,
        status: deploy.status,
        statusMessage: deploy.statusMessage,
        type: deploy.type,
        dockerImage: deploy.dockerImage,
        branch: deploy.branch,
        repoName: deploy.repoName,
        buildNumber: deploy.buildNumber,
        env: deploy.env,
        initEnv: deploy.initEnv,
        createdAt: deploy.createdAt,
        updatedAt: deploy.updatedAt,
      },
      deployment,
      pods,
      events,
      issues,
    };
  }

  private async gatherPodsInfo(
    deploymentUuid: string,
    serviceName: string,
    namespace: string,
    coreApi: k8s.CoreV1Api,
    warnings: ContextWarning[]
  ): Promise<PodDebugInfo[]> {
    // Try to find pods by deployment uuid first (using label selector)
    let podsResponse = await coreApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `deployment=${deploymentUuid}`
    );

    // If no pods found, try by service name as fallback
    if (podsResponse.body.items.length === 0) {
      podsResponse = await coreApi.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `app=${serviceName}`
      );
    }

    return Promise.all(
      podsResponse.body.items.map(async (pod) => {
        let recentLogs = '';
        try {
          recentLogs = await this.getRecentLogs(pod.metadata.name, namespace, coreApi);
        } catch (error) {
          warnings.push({
            source: 'logs',
            message: `Could not fetch logs for pod ${pod.metadata.name}`,
            details: error.message,
          });
        }

        return {
          name: pod.metadata.name,
          phase: pod.status.phase,
          conditions: pod.status.conditions || [],
          containerStatuses: pod.status.containerStatuses || [],
          recentLogs,
          events: await this.getPodEvents(pod.metadata.name, namespace, coreApi).catch(() => []),
        };
      })
    );
  }

  private async gatherDeploymentInfo(serviceName: string, namespace: string, appsApi: k8s.AppsV1Api): Promise<any> {
    try {
      const deploymentResponse = await appsApi.readNamespacedDeployment(serviceName, namespace);
      const deployment = deploymentResponse.body;

      return {
        name: deployment.metadata.name,
        replicas: {
          desired: deployment.spec.replicas || 0,
          current: deployment.status.replicas || 0,
          ready: deployment.status.readyReplicas || 0,
          available: deployment.status.availableReplicas || 0,
        },
        conditions: deployment.status.conditions || [],
        strategy: deployment.spec.strategy?.type || 'Unknown',
        containers: deployment.spec.template.spec.containers.map((c) => ({
          name: c.name,
          image: c.image,
        })),
      };
    } catch (error) {
      // Deployment might not exist yet or service doesn't use deployments
      return undefined;
    }
  }

  private async getRecentLogs(
    podName: string,
    namespace: string,
    coreApi: k8s.CoreV1Api,
    tailLines: number = 100
  ): Promise<string> {
    const logsResponse = await coreApi.readNamespacedPodLog(
      podName,
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      tailLines
    );
    return logsResponse.body;
  }

  private async getPodEvents(podName: string, namespace: string, coreApi: k8s.CoreV1Api): Promise<K8sEvent[]> {
    try {
      const eventsResponse = await coreApi.listNamespacedEvent(
        namespace,
        undefined,
        undefined,
        undefined,
        `involvedObject.name=${podName}`
      );

      return eventsResponse.body.items.slice(-10).map((event) => ({
        type: event.type,
        reason: event.reason,
        message: event.message,
        count: event.count,
        firstTimestamp: event.firstTimestamp,
        lastTimestamp: event.lastTimestamp,
      }));
    } catch (error) {
      return [];
    }
  }

  private async getServiceEvents(serviceName: string, namespace: string, coreApi: k8s.CoreV1Api): Promise<K8sEvent[]> {
    try {
      const eventsResponse = await coreApi.listNamespacedEvent(namespace);

      return eventsResponse.body.items
        .filter((event) => event.involvedObject?.labels?.app === serviceName)
        .slice(-20)
        .map((event) => ({
          type: event.type,
          reason: event.reason,
          message: event.message,
          count: event.count,
          firstTimestamp: event.firstTimestamp,
          lastTimestamp: event.lastTimestamp,
        }));
    } catch (error) {
      return [];
    }
  }

  private diagnoseIssues(pods: PodDebugInfo[], events: K8sEvent[]): DiagnosedIssue[] {
    const issues: DiagnosedIssue[] = [];

    for (const pod of pods) {
      if (pod.phase === 'Pending') {
        const unschedulable = pod.conditions.find((c: any) => c.type === 'PodScheduled' && c.status === 'False');
        if (unschedulable) {
          issues.push({
            severity: 'critical',
            category: 'resources',
            title: 'Pod cannot be scheduled',
            description: unschedulable.message || 'Pod is pending scheduling',
            suggestedFix: 'Check resource requests, node capacity, and node selectors',
            detectedBy: 'rules',
          });
        }
      }

      for (const container of pod.containerStatuses) {
        if (container.state?.waiting?.reason === 'ImagePullBackOff') {
          issues.push({
            severity: 'critical',
            category: 'image',
            title: 'Cannot pull container image',
            description: `Image ${container.image} cannot be pulled from registry`,
            suggestedFix: 'Verify image name, registry access, and image pull secrets',
            detectedBy: 'rules',
          });
        }

        if (container.state?.waiting?.reason === 'CrashLoopBackOff') {
          issues.push({
            severity: 'critical',
            category: 'configuration',
            title: 'Container is crash looping',
            description: `Container ${container.name} repeatedly crashes on startup`,
            suggestedFix: 'Check application logs for startup errors and verify configuration',
            detectedBy: 'rules',
          });
        }

        if (container.lastState?.terminated?.reason === 'OOMKilled') {
          issues.push({
            severity: 'critical',
            category: 'resources',
            title: 'Container killed due to out of memory',
            description: `Container ${container.name} exceeded memory limit and was killed`,
            suggestedFix: 'Increase memory limits or optimize application memory usage',
            detectedBy: 'rules',
          });
        }

        if (container.restartCount > 5) {
          issues.push({
            severity: 'warning',
            category: 'configuration',
            title: 'High restart count',
            description: `Container has restarted ${container.restartCount} times`,
            suggestedFix: 'Investigate logs for recurring errors or configuration issues',
            detectedBy: 'rules',
          });
        }
      }
    }

    for (const event of events) {
      if (event.type === 'Warning' && event.reason === 'FailedScheduling') {
        issues.push({
          severity: 'critical',
          category: 'resources',
          title: 'Failed to schedule pod',
          description: event.message,
          suggestedFix: 'Check cluster capacity and resource requests',
          detectedBy: 'rules',
        });
      }
    }

    return issues;
  }

  private determineServiceStatus(
    deploy: any,
    pods: PodDebugInfo[]
  ): 'pending' | 'building' | 'deploying' | 'running' | 'failed' {
    if (deploy.status === 'ERROR' || deploy.status === 'BUILD_FAILED' || deploy.status === 'DEPLOY_FAILED') {
      return 'failed';
    }
    if (deploy.status === 'BUILDING' || deploy.status === 'CLONING') {
      return 'building';
    }
    if (deploy.status === 'DEPLOYING' || deploy.status === 'WAITING') {
      return 'deploying';
    }
    if (deploy.status === 'PENDING' || deploy.status === 'QUEUED') {
      return 'pending';
    }

    const runningPods = pods.filter((p) => p.phase === 'Running');
    if (runningPods.length > 0 && runningPods.length === pods.length) {
      return 'running';
    }

    const failedPods = pods.filter((p) => p.phase === 'Failed' || p.phase === 'CrashLoopBackOff');
    if (failedPods.length > 0) {
      return 'failed';
    }

    return 'deploying';
  }
}
