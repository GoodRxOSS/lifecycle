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

function loadKubeConfig(): k8s.KubeConfig {
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

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function podStatus(pod: k8s.V1Pod): string {
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

function podRestarts(pod: k8s.V1Pod): number {
  return (pod.status?.containerStatuses ?? []).reduce((sum, cs) => sum + (cs.restartCount ?? 0), 0);
}

function podReady(pod: k8s.V1Pod): string {
  const statuses = pod.status?.containerStatuses ?? [];
  const total = statuses.length;
  const ready = statuses.filter((s) => s.ready).length;
  return `${ready}/${total}`;
}

function podAgeSeconds(pod: k8s.V1Pod): number {
  const created = pod.metadata?.creationTimestamp;
  if (!created) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(created).getTime()) / 1000));
}

function containerState(cs?: k8s.V1ContainerStatus): { state: ContainerState; reason?: string } {
  if (!cs) return { state: 'Unknown' };

  if (cs.state?.running) return { state: 'Running' };
  if (cs.state?.waiting) return { state: 'Waiting', reason: cs.state.waiting.reason };
  if (cs.state?.terminated) return { state: 'Terminated', reason: cs.state.terminated.reason };

  return { state: 'Unknown' };
}

function extractContainers(pod: k8s.V1Pod): ContainerInfo[] {
  const specContainers = pod.spec?.containers ?? [];
  const statusContainers = pod.status?.containerStatuses ?? [];
  const statusByName = new Map(statusContainers.map((cs) => [cs.name, cs]));

  const containers: ContainerInfo[] = [];

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

  return containers;
}

export async function getDeploymentPods(deploymentName: string, uuid: string): Promise<PodInfo[]> {
  const kc = loadKubeConfig();
  const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
  const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

  try {
    const namespace = `env-${uuid}`;
    const fullDeploymentName = `${deploymentName}-${uuid}`;

    let deployment: k8s.V1Deployment;

    try {
      const deployResp = await appsV1.readNamespacedDeployment(fullDeploymentName, namespace);
      deployment = deployResp.body;
    } catch (err: any) {
      if (err?.statusCode === 404) {
        return [];
      }
      throw err;
    }

    const matchLabels = deployment.spec?.selector?.matchLabels;
    if (!matchLabels || Object.keys(matchLabels).length === 0) {
      return [];
    }

    const labelSelector = buildLabelSelector(matchLabels);

    const podResp = await coreV1.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    const pods = podResp.body.items ?? [];

    if (pods.length === 0) {
      return [];
    }

    return pods.map((pod) => {
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
    });
  } catch (error) {
    getLogger().error({ error }, `K8s: failed to list deployment pods service=${deploymentName}`);
    throw error;
  }
}
