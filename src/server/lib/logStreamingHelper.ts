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

import { getLogger } from 'server/lib/logger/index';
import * as k8s from '@kubernetes/client-node';
import { StreamingInfo, LogSourceStatus, K8sPodInfo, K8sContainerInfo } from 'shared/types';
import { HttpError, V1ContainerStatus } from '@kubernetes/client-node';

/**
 * Reusable logic to get log streaming info for a specific Kubernetes job name,
 * using the provided namespace.
 */
export async function getLogStreamingInfoForJob(
  jobName: string | null | undefined,
  namespace: string
): Promise<StreamingInfo | LogSourceStatus> {
  if (!jobName) {
    getLogger().warn('LogStreaming: job name not provided');
    const statusResponse: LogSourceStatus = {
      status: 'Unavailable',
      streamingRequired: false,
      message: `Job name not found.`,
    };
    return statusResponse;
  }

  let podInfo: K8sPodInfo | null = null;
  try {
    podInfo = await getK8sJobStatusAndPod(jobName, namespace);
  } catch (k8sError: any) {
    getLogger().error(`LogStreaming: error fetching job status jobName=${jobName} error=${k8sError.message}`);
    const errorStatus: LogSourceStatus = {
      status: 'Unknown',
      streamingRequired: false,
      message: `Error fetching status from Kubernetes: ${k8sError.message}`,
    };
    if (
      k8sError instanceof HttpError ||
      k8sError.message?.includes('Kubernetes') ||
      (k8sError as any).statusCode === 502
    ) {
      errorStatus.message = 'Failed to communicate with Kubernetes.';
    }
    return errorStatus;
  }

  if (podInfo && podInfo.podName && (podInfo.status === 'Running' || podInfo.status === 'Pending')) {
    const streamingInfo: StreamingInfo = {
      status: podInfo.status,
      streamingRequired: true,
      websocket: {
        endpoint: '/api/logs/stream',
        parameters: {
          podName: podInfo.podName,
          namespace: podInfo.namespace,
          follow: true,
          tailLines: 200,
          timestamps: true,
        },
      },
      containers: podInfo.containers.map((c) => ({
        name: c.name,
        state: c.state,
      })),
    };
    return streamingInfo;
  } else {
    let responseStatus: LogSourceStatus['status'] = 'Unknown';
    let message = `Job pod associated with ${jobName} is not available for streaming.`;

    const podNameFromInfo = podInfo?.podName;
    const podStatusFromInfo = podInfo?.status;

    if (!podInfo || podStatusFromInfo === 'NotFound') {
      responseStatus = 'NotFound';
      message = `Job pod for ${jobName} not found. It might be completed and cleaned up.`;
    } else if (podStatusFromInfo === 'Succeeded') {
      responseStatus = 'Completed';
      message = `Job pod ${podNameFromInfo} has status: ${responseStatus}. Streaming not active.`;
    } else if (podStatusFromInfo === 'Failed') {
      responseStatus = 'Failed';
      message = `Job pod ${podNameFromInfo} has status: ${responseStatus}. Streaming not active.`;
    } else {
      responseStatus = 'Unknown';
      message = `Job pod ${podNameFromInfo || jobName} is in an unexpected state: ${podStatusFromInfo || 'Unknown'}.`;
    }

    const statusResponse: LogSourceStatus = {
      status: responseStatus,
      streamingRequired: false,
      podName: podNameFromInfo || null,
      containers: podInfo?.containers
        ? podInfo.containers.map((c) => ({
            name: c.name,
            state: c.state,
          }))
        : undefined,
      message: message,
    };
    return statusResponse;
  }
}

/**
 * Gets the status of the latest pod associated with a Kubernetes Job.
 * @param jobName The name of the Kubernetes Job.
 * @param namespace The namespace where the Job resides.
 * @returns A promise resolving to K8sPodInfo containing status and container info, or null if not found/error.
 */
export async function getK8sJobStatusAndPod(jobName: string, namespace: string): Promise<K8sPodInfo | null> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
  const batchV1Api = kc.makeApiClient(k8s.BatchV1Api);

  try {
    getLogger().debug(`LogStreaming: reading job details namespace=${namespace} jobName=${jobName}`);
    const jobResponse = await batchV1Api.readNamespacedJob(jobName, namespace);
    const job = jobResponse.body;

    if (!job?.spec?.selector?.matchLabels) {
      if (job?.status?.succeeded) {
        getLogger().warn(`LogStreaming: job succeeded but selector missing jobName=${jobName} namespace=${namespace}`);
        return { podName: null, namespace, status: 'Succeeded', containers: [] };
      }
      if (job?.status?.failed) {
        getLogger().warn(`LogStreaming: job failed but selector missing jobName=${jobName} namespace=${namespace}`);
        const failedCondition = job.status.conditions?.find((c) => c.type === 'Failed' && c.status === 'True');
        const failureMessage = failedCondition?.message || 'Job failed';
        return { podName: null, namespace, status: 'Failed', containers: [], message: failureMessage };
      }
      getLogger().error(`LogStreaming: job found but missing selector jobName=${jobName} namespace=${namespace}`);
      return { podName: null, namespace, status: 'Unknown', containers: [] };
    }

    const labelSelector = Object.entries(job.spec.selector.matchLabels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');

    getLogger().debug(
      `LogStreaming: listing pods jobName=${jobName} namespace=${namespace} labelSelector=${labelSelector}`
    );

    const podListResponse = await coreV1Api.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );
    const pods = podListResponse.body.items;

    if (!pods || pods.length === 0) {
      getLogger().warn(`LogStreaming: no pods found matching job selector jobName=${jobName} namespace=${namespace}`);
      const jobStatus = job.status;
      if (jobStatus?.succeeded && jobStatus.succeeded > 0) {
        return { podName: null, namespace, status: 'Succeeded', containers: [] };
      }
      if (jobStatus?.failed && jobStatus.failed > 0) {
        const failedCondition = jobStatus.conditions?.find((c) => c.type === 'Failed' && c.status === 'True');
        const failureReason = failedCondition?.reason || 'Failed';
        const failureMessage = failedCondition?.message || 'Job failed';
        getLogger().warn(
          `LogStreaming: job indicates failure but no pods found jobName=${jobName} namespace=${namespace} reason=${failureReason}`
        );
        return { podName: null, namespace, status: 'Failed', containers: [], message: failureMessage };
      }
      return { podName: null, namespace, status: 'NotFound', containers: [] };
    }

    pods.sort(
      (a, b) => (b.metadata?.creationTimestamp?.getTime() || 0) - (a.metadata?.creationTimestamp?.getTime() || 0)
    );
    const latestPod = pods[0];

    if (!latestPod?.metadata?.name || !latestPod?.status) {
      getLogger().error(`LogStreaming: pod missing metadata or status jobName=${jobName} namespace=${namespace}`);
      return null;
    }
    const podName = latestPod.metadata.name;
    getLogger().debug(`LogStreaming: found latest pod jobName=${jobName} namespace=${namespace} podName=${podName}`);

    let podStatus: K8sPodInfo['status'] = 'Unknown';
    const phase = latestPod.status.phase;
    if (phase === 'Pending') podStatus = 'Pending';
    else if (phase === 'Running') podStatus = 'Running';
    else if (phase === 'Succeeded') podStatus = 'Succeeded';
    else if (phase === 'Failed') podStatus = 'Failed';

    const containers: K8sContainerInfo[] = [];
    const allStatuses = [
      ...(latestPod.status.initContainerStatuses || []).map((cs) => ({ ...cs, isInit: true })),
      ...(latestPod.status.containerStatuses || []).map((cs) => ({ ...cs, isInit: false })),
    ];

    allStatuses.forEach((cs: V1ContainerStatus & { isInit: boolean }) => {
      let state = 'waiting';
      if (cs.state?.running) {
        state = 'running';
      } else if (cs.state?.terminated) {
        state = cs.state.terminated.reason || 'terminated';
      } else if (cs.state?.waiting) {
        state = cs.state.waiting.reason || 'waiting';
      }
      if (cs.name && !containers.find((c) => c.name === cs.name)) {
        containers.push({
          name: cs.isInit ? `[init] ${cs.name}` : cs.name,
          state: state.toLowerCase(),
        });
      }
    });

    if (containers.length === 0 && latestPod.spec) {
      const specContainers = [
        ...(latestPod.spec.initContainers || []).map((c) => ({ name: `[init] ${c.name}`, isInit: true })),
        ...(latestPod.spec.containers || []).map((c) => ({ name: c.name, isInit: false })),
      ];

      specContainers.forEach((c) => {
        if (!containers.find((existing) => existing.name === c.name)) {
          containers.push({
            name: c.name,
            state: 'pending',
          });
        }
      });
    }

    const result: K8sPodInfo = {
      podName: podName,
      namespace: namespace,
      status: podStatus,
      containers: containers,
    };

    if (podStatus === 'Failed' && job.status?.conditions) {
      const failedCondition = job.status.conditions.find((c) => c.type === 'Failed' && c.status === 'True');
      if (failedCondition?.message) {
        result.message = failedCondition.message;
      }
    }

    return result;
  } catch (error: any) {
    if (error instanceof HttpError && error.response?.statusCode === 404) {
      getLogger().warn(`LogStreaming: job not found jobName=${jobName} namespace=${namespace} error=${error.message}`);
      return {
        podName: null,
        namespace,
        status: 'NotFound',
        containers: [],
        message: 'Job no longer exists. Logs have been cleaned up after 24 hours.',
      };
    }
    getLogger().error(
      `LogStreaming: error getting job/pod status jobName=${jobName} namespace=${namespace} error=${error.message}`
    );
    return null;
  }
}

/**
 * Gets container information for a specific Kubernetes pod by name.
 * @param podName The name of the Kubernetes pod.
 * @param namespace The namespace where the pod resides (defaults to 'default').
 * @returns A promise resolving to K8sPodInfo containing pod status and container info.
 */
export async function getK8sPodContainers(podName: string, namespace: string = 'lifecycle-app'): Promise<K8sPodInfo> {
  getLogger().debug(`LogStreaming: fetching container info podName=${podName} namespace=${namespace}`);
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

  try {
    const { body: pod } = await coreV1Api.readNamespacedPod(podName, namespace);

    let podStatus: K8sPodInfo['status'] = 'Unknown';
    const phase = pod.status?.phase;
    if (phase === 'Pending') podStatus = 'Pending';
    else if (phase === 'Running') podStatus = 'Running';
    else if (phase === 'Succeeded') podStatus = 'Succeeded';
    else if (phase === 'Failed') podStatus = 'Failed';

    const containers: K8sContainerInfo[] = [];
    const allStatuses = [
      ...(pod.status?.initContainerStatuses || []).map((cs) => ({ ...cs, isInit: true })),
      ...(pod.status?.containerStatuses || []).map((cs) => ({ ...cs, isInit: false })),
    ];

    allStatuses.forEach((cs: V1ContainerStatus & { isInit: boolean }) => {
      let state = 'waiting';
      if (cs.state?.running) {
        state = 'running';
      } else if (cs.state?.terminated) {
        state = cs.state.terminated.reason || 'terminated';
      } else if (cs.state?.waiting) {
        state = cs.state.waiting.reason || 'waiting';
      }
      if (cs.name && !containers.find((c) => c.name === cs.name)) {
        containers.push({
          name: cs.isInit ? `[init] ${cs.name}` : cs.name,
          state: state.toLowerCase(),
        });
      }
    });

    if (containers.length === 0 && pod.spec) {
      const specContainers = [
        ...(pod.spec.initContainers || []).map((c) => ({ name: `[init] ${c.name}`, isInit: true })),
        ...(pod.spec.containers || []).map((c) => ({ name: c.name, isInit: false })),
      ];

      specContainers.forEach((c) => {
        if (!containers.find((existing) => existing.name === c.name)) {
          containers.push({
            name: c.name,
            state: 'unknown',
          });
        }
      });
    }

    if (containers.length === 0) {
      containers.push({
        name: 'main',
        state: 'unknown',
      });
    }

    return {
      podName,
      namespace,
      status: podStatus,
      containers,
    };
  } catch (error: any) {
    if (error instanceof HttpError && error.response?.statusCode === 404) {
      getLogger().warn(`LogStreaming: pod not found podName=${podName} namespace=${namespace} error=${error.message}`);
      return {
        podName: null,
        namespace,
        status: 'NotFound',
        containers: [],
        message: `Pod '${podName}' not found in namespace '${namespace}'`,
      };
    }

    getLogger().error(
      `LogStreaming: error getting container info podName=${podName} namespace=${namespace} error=${error.message}`
    );
    throw error;
  }
}
