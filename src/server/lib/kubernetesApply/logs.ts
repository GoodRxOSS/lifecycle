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
import { Deploy } from 'server/models';
import rootLogger from 'server/lib/logger';

const logger = rootLogger.child({ filename: 'lib/kubernetesApply/logs.ts' });

/**
 * Fetches logs from a Kubernetes apply job for a deploy
 * @param deploy The deploy to fetch logs for
 * @param tail Optional number of lines to tail
 * @returns The logs as a string
 */
export async function getKubernetesApplyLogs(deploy: Deploy, tail?: number): Promise<string> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();

  const namespace = deploy.build?.namespace;
  if (!namespace) {
    return 'No namespace found for deploy';
  }

  try {
    // Find the job for this deploy using labels
    const batchApi = kc.makeApiClient(k8s.BatchV1Api);
    const jobLabelSelector = `app=lifecycle-deploy,type=kubernetes-apply,deploy_uuid=${deploy.uuid}`;
    const jobs = await batchApi.listNamespacedJob(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      jobLabelSelector
    );

    if (jobs.body.items.length === 0) {
      return 'No deployment job found';
    }

    // Get the most recent job
    const job = jobs.body.items.sort((a, b) => {
      const aTime = new Date(a.metadata?.creationTimestamp || 0).getTime();
      const bTime = new Date(b.metadata?.creationTimestamp || 0).getTime();
      return bTime - aTime;
    })[0];

    const jobName = job.metadata?.name;
    if (!jobName) {
      return 'Job found but has no name';
    }

    // Get pods for the job
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `job-name=${jobName}`
    );

    if (pods.body.items.length === 0) {
      return 'No pods found for deployment job';
    }

    // Get logs from all pods (usually just one)
    const allLogs: string[] = [];

    for (const pod of pods.body.items) {
      const podName = pod.metadata?.name;
      if (!podName) continue;

      try {
        const podLogs = await coreApi.readNamespacedPodLog(
          podName,
          namespace,
          'kubectl-apply', // container name
          undefined, // follow
          undefined, // insecureSkipTLSVerifyBackend
          undefined, // limitBytes
          undefined, // pretty
          undefined, // previous
          undefined, // sinceSeconds
          tail, // tailLines
          undefined // timestamps
        );

        if (podLogs.body) {
          allLogs.push(`=== Logs from pod ${podName} ===\n${podLogs.body}`);
        }
      } catch (podError) {
        logger.error(`Failed to fetch logs from pod ${podName}: ${podError}`);
        allLogs.push(`=== Error fetching logs from pod ${podName} ===\n${(podError as Error).message || podError}`);
      }
    }

    return allLogs.join('\n\n') || 'No logs available';
  } catch (error) {
    logger.error(`Failed to fetch logs for deploy ${deploy.uuid}: ${error}`);
    return `Failed to fetch logs: ${(error as Error).message || error}`;
  }
}

/**
 * Streams logs from a Kubernetes apply job in real-time
 * @param deploy The deploy to stream logs for
 * @param onData Callback for each log line
 * @param onError Callback for errors
 * @param onClose Callback when stream closes
 * @returns A function to stop the stream
 */
export async function streamKubernetesApplyLogs(
  deploy: Deploy,
  // eslint-disable-next-line no-unused-vars
  onData: (data: string) => void,
  // eslint-disable-next-line no-unused-vars
  onError: (error: Error) => void,
  onClose: () => void
): Promise<() => void> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();

  const namespace = deploy.build?.namespace;

  if (!namespace) {
    onError(new Error('No namespace found'));
    onClose();
    return () => {};
  }

  try {
    // Find the job for this deploy using labels
    const batchApi = kc.makeApiClient(k8s.BatchV1Api);
    const jobLabelSelector = `app=lifecycle-deploy,type=kubernetes-apply,deploy_uuid=${deploy.uuid}`;
    const jobs = await batchApi.listNamespacedJob(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      jobLabelSelector
    );

    if (jobs.body.items.length === 0) {
      onError(new Error('No deployment job found'));
      onClose();
      return () => {};
    }

    // Get the most recent job
    const job = jobs.body.items.sort((a, b) => {
      const aTime = new Date(a.metadata?.creationTimestamp || 0).getTime();
      const bTime = new Date(b.metadata?.creationTimestamp || 0).getTime();
      return bTime - aTime;
    })[0];

    const jobName = job.metadata?.name;
    if (!jobName) {
      onError(new Error('Job found but has no name'));
      onClose();
      return () => {};
    }

    // Get the pod for the job
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const podLabelSelector = `job-name=${jobName}`;
    const pods = await coreApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      podLabelSelector
    );

    if (pods.body.items.length === 0) {
      onError(new Error('No pods found for deployment job'));
      onClose();
      return () => {};
    }

    const podName = pods.body.items[0].metadata?.name;
    if (!podName) {
      onError(new Error('Pod has no name'));
      onClose();
      return () => {};
    }

    // For now, use polling instead of streaming due to Kubernetes client library limitations
    let isActive = true;
    let lastLogsSeen = '';

    const pollInterval = setInterval(async () => {
      if (!isActive) {
        clearInterval(pollInterval);
        return;
      }

      try {
        const logs = await coreApi.readNamespacedPodLog(
          podName,
          namespace,
          'kubectl-apply',
          undefined, // follow
          undefined, // insecureSkipTLSVerifyBackend
          undefined, // limitBytes
          undefined, // pretty
          undefined, // previous
          undefined, // sinceSeconds
          100, // tailLines
          true // timestamps
        );

        if (logs.body && logs.body !== lastLogsSeen) {
          // Only send new logs
          const newLogs = logs.body.substring(lastLogsSeen.length);
          if (newLogs) {
            onData(newLogs);
          }
          lastLogsSeen = logs.body;
        }

        // Check if pod is completed
        const podStatus = await coreApi.readNamespacedPod(podName, namespace);
        const phase = podStatus.body.status?.phase;
        if (phase === 'Succeeded' || phase === 'Failed') {
          isActive = false;
          clearInterval(pollInterval);
          onClose();
        }
      } catch (error) {
        logger.error(`Error polling logs for deploy ${deploy.uuid}: ${error}`);
        if ((error as any).response?.statusCode === 404) {
          // Pod was deleted, stop polling
          isActive = false;
          clearInterval(pollInterval);
          onClose();
        } else {
          onError(error as Error);
        }
      }
    }, 2000); // Poll every 2 seconds

    // Return a function to stop polling
    return () => {
      isActive = false;
      clearInterval(pollInterval);
    };
  } catch (error) {
    logger.error(`Failed to start log stream for deploy ${deploy.uuid}: ${error}`);
    onError(error as Error);
    onClose();
    return () => {};
  }
}
