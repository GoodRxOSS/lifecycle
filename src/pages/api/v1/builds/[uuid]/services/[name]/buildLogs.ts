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

import type { NextApiRequest, NextApiResponse } from 'next';
import rootLogger from 'server/lib/logger';
import * as k8s from '@kubernetes/client-node';
import { HttpError } from '@kubernetes/client-node';

const logger = rootLogger.child({
  filename: __filename,
});

interface BuildJobInfo {
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

interface BuildLogsListResponse {
  builds: BuildJobInfo[];
}

async function getNativeBuildJobs(serviceName: string, namespace: string): Promise<BuildJobInfo[]> {
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
        const endTime = completedAt ? new Date(completedAt).getTime() : Date.now();
        duration = Math.floor((endTime - startTime) / 1000);
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

/**
 * @openapi
 * /api/v1/builds/{uuid}/services/{name}/buildLogs:
 *   get:
 *     summary: List build jobs for a service
 *     description: |
 *       Returns a list of all build jobs for a specific service within a build.
 *       This includes both active and completed build jobs with their status,
 *       timing information, and the build engine used.
 *     tags:
 *       - Builds
 *       - Native Build
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the service
 *     responses:
 *       '200':
 *         description: List of build jobs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 builds:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       jobName:
 *                         type: string
 *                         description: Kubernetes job name
 *                         example: build-api-abc123-1234567890
 *                       buildUuid:
 *                         type: string
 *                         description: Deploy UUID
 *                         example: api-abc123
 *                       sha:
 *                         type: string
 *                         description: Git commit SHA
 *                         example: a1b2c3d4e5f6
 *                       status:
 *                         type: string
 *                         enum: [Active, Complete, Failed, Pending]
 *                         description: Current status of the build job
 *                       startedAt:
 *                         type: string
 *                         format: date-time
 *                         description: When the job started
 *                       completedAt:
 *                         type: string
 *                         format: date-time
 *                         description: When the job completed
 *                       duration:
 *                         type: number
 *                         description: Build duration in seconds
 *                       engine:
 *                         type: string
 *                         enum: [buildkit, kaniko, unknown]
 *                         description: Build engine used
 *       '400':
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       '404':
 *         description: Environment or service not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       '405':
 *         description: Method not allowed (only GET is supported)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: POST is not allowed
 *       '502':
 *         description: Failed to communicate with Kubernetes
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       '500':
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Internal server error occurred.
 */
// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    logger.warn({ method: req.method }, 'Method not allowed');
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  const { uuid, name } = req.query;

  if (typeof uuid !== 'string' || typeof name !== 'string') {
    logger.warn({ uuid, name }, 'Missing or invalid query parameters');
    return res.status(400).json({ error: 'Missing or invalid uuid or name parameters' });
  }

  try {
    const namespace = `env-${uuid}`;

    const buildJobs = await getNativeBuildJobs(name, namespace);

    const response: BuildLogsListResponse = {
      builds: buildJobs,
    };

    return res.status(200).json(response);
  } catch (error) {
    logger.error({ err: error }, `Error getting build logs for service ${name} in environment ${uuid}.`);

    if (error instanceof HttpError) {
      if (error.response?.statusCode === 404) {
        return res.status(404).json({ error: 'Environment or service not found.' });
      }
      return res.status(502).json({ error: 'Failed to communicate with Kubernetes.' });
    }

    return res.status(500).json({ error: 'Internal server error occurred.' });
  }
};
