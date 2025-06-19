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

import rootLogger from 'server/lib/logger';
import * as k8s from '@kubernetes/client-node';
import { StreamingInfo, LogSourceStatus, K8sPodInfo, K8sContainerInfo } from 'shared/types';
import { HttpError, V1ContainerStatus } from '@kubernetes/client-node';

const logger = rootLogger.child({
  filename: __filename,
});

/**
 * Reusable logic to get log streaming info for a specific Kubernetes job name,
 * using the provided namespace.
 */
export async function getLogStreamingInfoForJob(
  jobName: string | null | undefined,
  namespace: string
): Promise<StreamingInfo | LogSourceStatus> {
  if (!jobName) {
    logger.warn(`Job name not provided. Cannot get logs.`);
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
    logger.error({ k8sError }, `Error calling getK8sJobStatusAndPod for ${jobName}.`);
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
  const logCtx = { jobName, namespace };

  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
  const batchV1Api = kc.makeApiClient(k8s.BatchV1Api);

  try {
    logger.debug(logCtx, `Reading Job details for namespace: ${namespace} and jobName: ${jobName}`);
    const jobResponse = await batchV1Api.readNamespacedJob(jobName, namespace);
    const job = jobResponse.body;

    if (!job?.spec?.selector?.matchLabels) {
      if (job?.status?.succeeded) {
        logger.warn(logCtx, 'Job succeeded but selector missing.');
        return { podName: null, namespace, status: 'Succeeded', containers: [] };
      }
      if (job?.status?.failed) {
        logger.warn(logCtx, 'Job failed but selector missing.');
        return { podName: null, namespace, status: 'Failed', containers: [] };
      }
      logger.error(logCtx, 'Job found, but missing spec.selector.matchLabels. Cannot find associated pods.');
      return { podName: null, namespace, status: 'Unknown', containers: [] };
    }

    const labelSelector = Object.entries(job.spec.selector.matchLabels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');

    logger.debug({ ...logCtx, labelSelector }, 'Listing Pods with label selector');

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
      logger.warn(logCtx, 'No pods found matching the job selector.');
      const jobStatus = job.status;
      if (jobStatus?.succeeded && jobStatus.succeeded > 0) {
        return { podName: null, namespace, status: 'Succeeded', containers: [] };
      }
      if (jobStatus?.failed && jobStatus.failed > 0) {
        const failureReason =
          jobStatus.conditions?.find((c) => c.type === 'Failed' && c.status === 'True')?.reason || 'Failed';
        logger.warn({ ...logCtx, failureReason }, 'Job indicates failure, but no pods found.');
        return { podName: null, namespace, status: 'Failed', containers: [] };
      }
      return { podName: null, namespace, status: 'NotFound', containers: [] };
    }

    pods.sort(
      (a, b) => (b.metadata?.creationTimestamp?.getTime() || 0) - (a.metadata?.creationTimestamp?.getTime() || 0)
    );
    const latestPod = pods[0];

    if (!latestPod?.metadata?.name || !latestPod?.status) {
      logger.error(logCtx, 'Found pod(s), but latest pod is missing metadata or status.');
      return null;
    }
    const podName = latestPod.metadata.name;
    logger.debug({ ...logCtx, podName }, 'Found latest pod');

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

    const result: K8sPodInfo = {
      podName: podName,
      namespace: namespace,
      status: podStatus,
      containers: containers,
    };
    return result;
  } catch (error: any) {
    if (error instanceof HttpError && error.response?.statusCode === 404) {
      logger.warn(logCtx, `Job or associated resource not found (404) ${error.message}`);
      return { podName: null, namespace, status: 'NotFound', containers: [] };
    }
    logger.error({ ...logCtx, err: error }, 'Error getting K8s job/pod status');
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
  const logCtx = { podName, namespace };

  logger.debug(logCtx, 'Fetching container information for pod');
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

    // Extract all container info - both init containers and regular containers
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

    // If no container statuses found, try to get container names from the pod spec
    if (containers.length === 0 && pod.spec) {
      // Extract from pod.spec
      const specContainers = [
        ...(pod.spec.initContainers || []).map((c) => ({ name: `[init] ${c.name}`, isInit: true })),
        ...(pod.spec.containers || []).map((c) => ({ name: c.name, isInit: false })),
      ];

      specContainers.forEach((c) => {
        if (!containers.find((existing) => existing.name === c.name)) {
          containers.push({
            name: c.name,
            state: 'unknown', // We don't have status info
          });
        }
      });
    }

    // If still no containers found, at least provide one default
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
    // Handle 404 - Pod not found
    if (error instanceof HttpError && error.response?.statusCode === 404) {
      logger.warn(logCtx, `Pod not found (404): ${error.message}`);
      return {
        podName: null,
        namespace,
        status: 'NotFound',
        containers: [],
        message: `Pod '${podName}' not found in namespace '${namespace}'`,
      };
    }

    // Handle other errors
    logger.error({ ...logCtx, err: error }, 'Error getting container information');
    throw error;
  }
}
