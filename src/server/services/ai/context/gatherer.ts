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

import BaseService from '../../_service';
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
} from '../../types/aiAgent';
import { GitHubClient } from '../tools/shared/githubClient';
import { getLogger } from 'server/lib/logger';

export default class AIAgentContextService extends BaseService {
  private static defaultBranchCache: Map<string, { data: string; expiry: number }> = new Map();
  private static DEFAULT_BRANCH_CACHE_TTL_MS = 86400000;

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

    const githubClient = new GitHubClient();
    const octokit = await githubClient.getOctokit('ai-agent-context-gatherer');

    let lifecycleContext;
    let kubernetesServices;
    let lifecycleYaml;

    try {
      lifecycleContext = await this.gatherLifecycleContext(build, octokit);
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

    try {
      const fullName = build.pullRequest.fullName;
      const branch = build.pullRequest.branchName;

      if (fullName && branch) {
        const [owner, repo] = fullName.split('/');

        const possiblePaths = ['lifecycle.yaml', 'lifecycle.yml'];
        let response;
        let foundPath: string | null = null;

        for (const path of possiblePaths) {
          try {
            response = await octokit.request(`GET /repos/${owner}/${repo}/contents/${path}`, {
              ref: branch,
            });
            foundPath = path;
            break;
          } catch (error) {
            continue;
          }
        }

        if (foundPath && response?.data && 'content' in response.data && response.data.type === 'file') {
          const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
          lifecycleYaml = {
            path: foundPath,
            content,
          };
        } else {
          lifecycleYaml = {
            path: 'lifecycle.yaml',
            content: '',
            error: 'lifecycle.yaml or lifecycle.yml not found in repository',
          };
          warnings.push({
            source: 'lifecycle',
            message: 'Could not fetch lifecycle configuration from repository',
            details: 'Neither lifecycle.yaml nor lifecycle.yml found',
          });
        }
      }
    } catch (error) {
      warnings.push({
        source: 'lifecycle',
        message: 'Failed to fetch lifecycle configuration',
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

  private async gatherLifecycleContext(build: any, octokit: any): Promise<LifecycleContext> {
    const fullName = build.pullRequest.fullName;
    const [owner, repo] = fullName ? fullName.split('/') : [];
    const defaultBranch = owner && repo ? await this.getDefaultBranch(owner, repo, octokit) : 'main';

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
        baseBranch: defaultBranch,
        status: build.pullRequest.status,
        url: `https://github.com/${build.pullRequest.fullName}/pull/${build.pullRequest.pullRequestNumber}`,
        latestCommit: build.pullRequest.latestCommit,
        fullName: build.pullRequest.fullName,
        commentId: build.pullRequest.commentId,
        labels: build.pullRequest.labels || [],
      },
      environment: {
        id: build.environment.id,
        name: build.environment.name,
        config: build.environment.config || {},
      },
      deploys: build.deploys.map((deploy: any) => ({
        uuid: deploy.uuid,
        serviceName: deploy.deployable?.name || deploy.service?.name || deploy.uuid,
        status: deploy.status,
        statusMessage: deploy.statusMessage,
        type: deploy.deployable?.type || deploy.type,
        dockerImage: deploy.dockerImage,
        branch: deploy.branch,
        repoName: deploy.repoName,
        buildNumber: deploy.buildNumber,
        buildPipelineId: deploy.buildPipelineId,
        deployPipelineId: deploy.deployPipelineId,
        builderEngine: deploy.deployable?.builder?.engine,
        helmChart: deploy.deployable?.helm?.chart,
        repositoryId: deploy.deployable?.repositoryId,
      })),
      repository: {
        name: build.pullRequest.repository.name,
        githubRepositoryId: build.pullRequest.repository.githubRepositoryId,
        url: build.pullRequest.repository.url,
      },
    };
  }

  private async getDefaultBranch(owner: string, repo: string, octokit: any): Promise<string> {
    const fullName = `${owner}/${repo}`.toLowerCase();

    try {
      const now = Date.now();
      const memoryCached = AIAgentContextService.defaultBranchCache.get(fullName);
      if (memoryCached && now < memoryCached.expiry) {
        return memoryCached.data;
      }

      const redisKey = `default_branch:${fullName}`;
      const redisValue = await this.redis.get(redisKey);
      if (redisValue) {
        AIAgentContextService.defaultBranchCache.set(fullName, {
          data: redisValue,
          expiry: now + AIAgentContextService.DEFAULT_BRANCH_CACHE_TTL_MS,
        });
        return redisValue;
      }

      const response = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
      const defaultBranch = response.data.default_branch;

      await this.redis.set(redisKey, defaultBranch, 'EX', 86400);
      AIAgentContextService.defaultBranchCache.set(fullName, {
        data: defaultBranch,
        expiry: now + AIAgentContextService.DEFAULT_BRANCH_CACHE_TTL_MS,
      });

      return defaultBranch;
    } catch (error) {
      getLogger().warn(`AIAgentContext: failed to fetch default branch repo=${fullName} error=${error}`);
      return 'main';
    }
  }

  private static FAILED_DEPLOY_STATUSES = new Set(['BUILD_FAILED', 'DEPLOY_FAILED', 'ERROR']);

  private async gatherKubernetesInfo(
    build: any,
    warnings: ContextWarning[],
    errors: ContextError[]
  ): Promise<ServiceDebugInfo[]> {
    const namespace = build.namespace;
    const services: ServiceDebugInfo[] = [];

    for (const deploy of build.deploys || []) {
      const serviceName = deploy.deployable?.name || deploy.service?.name || deploy.uuid;
      const isFailed = AIAgentContextService.FAILED_DEPLOY_STATUSES.has(deploy.status);

      if (isFailed) {
        try {
          const serviceInfo = await this.gatherServiceDebugInfo(deploy, namespace, warnings);
          services.push(serviceInfo);
        } catch (error) {
          errors.push({
            source: 'kubernetes',
            message: `Failed to gather info for service ${serviceName}`,
            error: error.message,
            recoverable: true,
          });
        }
      } else {
        services.push({
          name: serviceName,
          type: deploy.deployable?.type || deploy.type,
          status: this.determineServiceStatus(deploy, []),
          deployInfo: {
            uuid: deploy.uuid,
            serviceName,
            status: deploy.status,
            statusMessage: deploy.statusMessage,
            type: deploy.deployable?.type || deploy.type,
            dockerImage: deploy.dockerImage,
            branch: deploy.branch,
            repoName: deploy.repoName,
            buildNumber: deploy.buildNumber,
            env: deploy.env,
            initEnv: deploy.initEnv,
            createdAt: deploy.createdAt,
            updatedAt: deploy.updatedAt,
          },
          pods: [],
          events: [],
          issues: [],
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

    const serviceName = deploy.deployable?.name || deploy.service?.name || deploy.uuid;

    let pods: PodDebugInfo[] = [];
    let events: K8sEvent[] = [];
    let deployment: any = undefined;

    try {
      pods = await this.gatherPodsInfo(deploy.uuid, serviceName, namespace, coreApi, warnings);
    } catch (error) {
      warnings.push({
        source: 'kubernetes',
        message: `Could not fetch pods for ${serviceName} (${deploy.uuid})`,
        details: error.message,
      });
    }

    try {
      events = await this.getServiceEvents(serviceName, namespace, coreApi);
    } catch (error) {
      warnings.push({
        source: 'kubernetes',
        message: `Could not fetch events for ${serviceName}`,
        details: error.message,
      });
    }

    try {
      deployment = await this.gatherDeploymentInfo(deploy.uuid, namespace, appsApi);
    } catch (error) {
      warnings.push({
        source: 'kubernetes',
        message: `Could not fetch deployment for ${serviceName} (${deploy.uuid})`,
        details: error.message,
      });
    }

    const issues = this.diagnoseIssues(pods, events);

    return {
      name: serviceName,
      type: deploy.deployable?.type || deploy.type,
      status: this.determineServiceStatus(deploy, pods),
      deployInfo: {
        uuid: deploy.uuid,
        serviceName: serviceName,
        status: deploy.status,
        statusMessage: deploy.statusMessage,
        type: deploy.deployable?.type || deploy.type,
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
    tailLines: number = 50
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

      return eventsResponse.body.items.slice(-5).map((event) => ({
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
        .filter((event) => {
          const name = event.involvedObject?.name || '';
          return name.includes(serviceName);
        })
        .slice(-5)
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
