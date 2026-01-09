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

export interface BuildJobInfo {
  jobName: string;
  buildUuid: string;
  sha: string;
  status: 'Active' | 'Complete' | 'Failed' | 'Pending';
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  engine: 'buildkit' | 'kaniko' | 'unknown';
  error?: string;
  podName?: string;
}

const logger = rootLogger.child({
  filename: __filename,
});

export async function getNativeBuildJobs(serviceName: string, namespace: string): Promise<BuildJobInfo[]> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const batchV1Api = kc.makeApiClient(k8s.BatchV1Api);
  const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

  try {
    const labelSelector = `lc-service=${serviceName},app.kubernetes.io/component=build`;
    const jobListResponse = await batchV1Api.listNamespacedJob(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    const jobs = jobListResponse.body.items || [];

    const buildJobs: BuildJobInfo[] = [];

    for (const job of jobs) {
      const jobName = job.metadata?.name || '';
      const labels = job.metadata?.labels || {};

      const buildUuid = labels['lc-deploy-uuid'] || '';
      const sha = labels['git-sha'] || '';
      const engine = (labels['builder-engine'] || 'unknown') as BuildJobInfo['engine'];

      let status: BuildJobInfo['status'] = 'Pending';
      let error: string | undefined;

      if (job.status?.succeeded && job.status.succeeded > 0) {
        status = 'Complete';
      } else if (job.status?.failed && job.status.failed > 0) {
        status = 'Failed';
        const failedCondition = job.status.conditions?.find((c) => c.type === 'Failed' && c.status === 'True');
        error = failedCondition?.message || 'Job failed';
      } else if (job.status?.active && job.status.active > 0) {
        status = 'Active';
      }

      const startedAt = job.status?.startTime;
      const completedAt = job.status?.completionTime;
      let duration: number | undefined;

      if (startedAt) {
        const startTime = new Date(startedAt).getTime();

        if (completedAt) {
          const endTime = new Date(completedAt).getTime();
          duration = Math.floor((endTime - startTime) / 1000);
        } else if (status === 'Active') {
          duration = Math.floor((Date.now() - startTime) / 1000);
        }
      }

      let podName: string | undefined;
      if (job.spec?.selector?.matchLabels) {
        const podLabelSelector = Object.entries(job.spec.selector.matchLabels)
          .map(([key, value]) => `${key}=${value}`)
          .join(',');

        try {
          const podListResponse = await coreV1Api.listNamespacedPod(
            namespace,
            undefined,
            undefined,
            undefined,
            undefined,
            podLabelSelector
          );
          const pods = podListResponse.body.items || [];
          if (pods.length > 0) {
            podName = pods[0].metadata?.name;

            if (status === 'Active' && pods[0].status?.phase === 'Pending') {
              status = 'Pending';
            }
          }
        } catch (podError) {
          logger.warn(`Failed to get pods for job ${jobName}:`, podError);
        }
      }

      buildJobs.push({
        jobName,
        buildUuid,
        sha,
        status,
        startedAt: startedAt ? new Date(startedAt).toISOString() : undefined,
        completedAt: completedAt ? new Date(completedAt).toISOString() : undefined,
        duration,
        engine,
        error,
        podName,
      });
    }

    buildJobs.sort((a, b) => {
      const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return bTime - aTime;
    });

    return buildJobs;
  } catch (error) {
    logger.error(`Error listing native build jobs for service ${serviceName}:`, error);
    throw error;
  }
}
