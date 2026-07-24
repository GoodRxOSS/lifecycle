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

import { getLogger } from 'server/lib/logger';
import Build from 'server/models/Build';

type ContainerState = 'Running' | 'Waiting' | 'Terminated' | 'Unknown';

export interface ContainerInfo {
  name: string;
  image?: string;
  ready: boolean;
  restarts: number;
  state: ContainerState;
  reason?: string;
  isInit: boolean;
}

export interface PodInfo {
  podName: string;
  status: string;
  restarts: number;
  ageSeconds: number;
  age: string;
  ready: string; // "X/Y"
  containers: ContainerInfo[];
}

async function resolveBuildNamespace(uuid: string): Promise<string> {
  const build = await Build.query()
    .findOne({ uuid })
    .select('namespace')
    .catch(() => null);
  return build?.namespace || `env-${uuid}`;
}

export function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }
  return kc;
}

function buildLabelSelector(matchLabels: Record<string, string>): string {
  return Object.entries(matchLabels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function podStatus(pod: k8s.V1Pod): string {
  const phase = pod.status?.phase ?? 'Unknown';
  const statuses = pod.status?.containerStatuses ?? [];

  for (const cs of statuses) {
    const waiting = cs.state?.waiting?.reason;
    if (waiting) return waiting;

    const terminated = cs.state?.terminated?.reason;
    if (terminated && phase !== 'Running') return terminated;
  }

  return phase;
}

export function podRestarts(pod: k8s.V1Pod): number {
  return (pod.status?.containerStatuses ?? []).reduce((sum, cs) => sum + (cs.restartCount ?? 0), 0);
}

export function podReady(pod: k8s.V1Pod): string {
  const statuses = pod.status?.containerStatuses ?? [];
  const total = statuses.length;
  const ready = statuses.filter((s) => s.ready).length;
  return `${ready}/${total}`;
}

export function podAgeSeconds(pod: k8s.V1Pod): number {
  const created = pod.metadata?.creationTimestamp;
  if (!created) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(created).getTime()) / 1000));
}

function isTerminalPod(pod: k8s.V1Pod): boolean {
  if (pod.metadata?.deletionTimestamp) {
    return true;
  }

  const phase = pod.status?.phase;
  if (phase === 'Succeeded' || phase === 'Failed') {
    return true;
  }

  const appContainerStatuses = pod.status?.containerStatuses ?? [];
  return appContainerStatuses.length > 0 && appContainerStatuses.every((status) => Boolean(status.state?.terminated));
}

function isDeletingPod(pod: k8s.V1Pod): boolean {
  return Boolean(pod.metadata?.deletionTimestamp);
}

function containerState(cs?: k8s.V1ContainerStatus): { state: ContainerState; reason?: string } {
  if (!cs) return { state: 'Unknown' };

  if (cs.state?.running) return { state: 'Running' };
  if (cs.state?.waiting) return { state: 'Waiting', reason: cs.state.waiting.reason };
  if (cs.state?.terminated) return { state: 'Terminated', reason: cs.state.terminated.reason };

  return { state: 'Unknown' };
}

export function extractContainers(pod: k8s.V1Pod): ContainerInfo[] {
  const containers: ContainerInfo[] = [];

  // Init containers
  const initSpec = pod.spec?.initContainers ?? [];
  const initStatus = pod.status?.initContainerStatuses ?? [];
  const initStatusByName = new Map(initStatus.map((cs) => [cs.name, cs]));

  for (const c of initSpec) {
    const cs = initStatusByName.get(c.name);
    const { state, reason } = containerState(cs);

    containers.push({
      name: c.name,
      image: c.image,
      ready: cs?.ready ?? false,
      restarts: cs?.restartCount ?? 0,
      state,
      reason,
      isInit: true,
    });
  }

  const specContainers = pod.spec?.containers ?? [];
  const statusContainers = pod.status?.containerStatuses ?? [];
  const statusByName = new Map(statusContainers.map((cs) => [cs.name, cs]));

  // Regular containers
  for (const c of specContainers) {
    const cs = statusByName.get(c.name);
    const { state, reason } = containerState(cs);

    containers.push({
      name: c.name,
      image: c.image,
      ready: cs?.ready ?? false,
      restarts: cs?.restartCount ?? 0,
      state,
      reason,
      isInit: false,
    });
  }

  return containers;
}

function toPodInfo(pod: k8s.V1Pod): PodInfo {
  const ageSeconds = podAgeSeconds(pod);
  const containers = extractContainers(pod);

  return {
    podName: pod.metadata?.name ?? '',
    status: podStatus(pod),
    restarts: podRestarts(pod),
    ageSeconds,
    age: formatAge(ageSeconds),
    ready: podReady(pod),
    containers,
  };
}

function sortPodsByAge(pods: PodInfo[]): PodInfo[] {
  return pods.sort((left, right) => left.ageSeconds - right.ageSeconds);
}

function getJobPodSelector(job: k8s.V1Job): string | undefined {
  const matchLabels = job.spec?.selector?.matchLabels;

  if (matchLabels && Object.keys(matchLabels).length > 0) {
    return buildLabelSelector(matchLabels);
  }

  const jobName = job.metadata?.name;
  return jobName ? `job-name=${jobName}` : undefined;
}

function isOwnedByCronJob(job: k8s.V1Job, cronJob: k8s.V1CronJob): boolean {
  const cronJobName = cronJob.metadata?.name;
  const cronJobUid = cronJob.metadata?.uid;

  return (job.metadata?.ownerReferences ?? []).some(
    (owner) =>
      owner.kind === 'CronJob' &&
      ((cronJobUid && owner.uid === cronJobUid) || (!cronJobUid && cronJobName && owner.name === cronJobName))
  );
}

async function listPodsBySelectors(
  coreV1: k8s.CoreV1Api,
  namespace: string,
  selectors: string[],
  includeTerminalPods: boolean
): Promise<PodInfo[]> {
  const podsByName = new Map<string, k8s.V1Pod>();

  for (const selector of selectors) {
    const podResp = await coreV1.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, selector);

    for (const pod of podResp.body.items ?? []) {
      const podName = pod.metadata?.name;
      if (!podName) continue;
      podsByName.set(podName, pod);
    }
  }

  const pods = Array.from(podsByName.values()).filter((pod) =>
    includeTerminalPods ? !isDeletingPod(pod) : !isTerminalPod(pod)
  );

  return sortPodsByAge(pods.map(toPodInfo));
}

export async function getDeploymentPods(deploymentName: string, uuid: string): Promise<PodInfo[]> {
  const kc = loadKubeConfig();
  const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
  const batchV1 = kc.makeApiClient(k8s.BatchV1Api);
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

  try {
    const namespace = await resolveBuildNamespace(uuid);
    const fullDeploymentName = `${deploymentName}-${uuid}`;

    const workloadSelector = `app.kubernetes.io/instance=${fullDeploymentName}`;
    let workloadPodSelector: string | undefined;

    // Try to find a Deployment using the label selector
    const deployResp = await appsV1.listNamespacedDeployment(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      workloadSelector
    );

    if (deployResp.body.items.length > 0) {
      const matchLabels = deployResp.body.items[0].spec?.selector?.matchLabels;
      workloadPodSelector =
        matchLabels && Object.keys(matchLabels).length > 0 ? buildLabelSelector(matchLabels) : undefined;
    } else {
      //  if no Deployment found, try to find a StatefulSet
      const stsResp = await appsV1.listNamespacedStatefulSet(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        workloadSelector
      );

      if (stsResp.body.items.length > 0) {
        const matchLabels = stsResp.body.items[0].spec?.selector?.matchLabels;
        workloadPodSelector =
          matchLabels && Object.keys(matchLabels).length > 0 ? buildLabelSelector(matchLabels) : undefined;
      }
    }

    if (workloadPodSelector) {
      return listPodsBySelectors(coreV1, namespace, [workloadPodSelector], false);
    }

    const jobResp = await batchV1.listNamespacedJob(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      workloadSelector
    );
    const jobPodSelectors = (jobResp.body.items ?? [])
      .map((job) => getJobPodSelector(job))
      .filter((selector): selector is string => Boolean(selector));

    if (jobPodSelectors.length > 0) {
      return listPodsBySelectors(coreV1, namespace, jobPodSelectors, true);
    }

    const cronJobResp = await batchV1.listNamespacedCronJob(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      workloadSelector
    );
    const cronJobs = cronJobResp.body.items ?? [];

    if (cronJobs.length === 0) {
      return [];
    }

    const allJobsResp = await batchV1.listNamespacedJob(namespace);
    const cronJobPodSelectors = (allJobsResp.body.items ?? [])
      .filter((job) => cronJobs.some((cronJob) => isOwnedByCronJob(job, cronJob)))
      .map((job) => getJobPodSelector(job))
      .filter((selector): selector is string => Boolean(selector));

    if (cronJobPodSelectors.length === 0) {
      return [];
    }

    return listPodsBySelectors(coreV1, namespace, cronJobPodSelectors, true);
  } catch (error) {
    getLogger().error({ error }, `K8s: failed to list workload pods service=${deploymentName}`);
    throw error;
  }
}
