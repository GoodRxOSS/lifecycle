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
import { validateAuth } from 'server/lib/auth/validate';

const logger = rootLogger.child({
  filename: __filename,
});

interface DeploymentJobInfo {
  jobName: string;
  deployUuid: string;
  sha: string;
  status: 'Active' | 'Complete' | 'Failed';
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  error?: string;
  podName?: string;
  deploymentType: 'helm' | 'github';
}

interface DeployLogsListResponse {
  deployments: DeploymentJobInfo[];
}

async function getDeploymentJobs(serviceName: string, namespace: string): Promise<DeploymentJobInfo[]> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const batchV1Api = kc.makeApiClient(k8s.BatchV1Api);
  const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

  try {
    const helmLabelSelector = `app.kubernetes.io/name=native-helm,service=${serviceName}`;
    const k8sApplyLabelSelector = `app=lifecycle-deploy,type=kubernetes-apply`;

    const [helmJobsResponse, k8sJobsResponse] = await Promise.all([
      batchV1Api.listNamespacedJob(namespace, undefined, undefined, undefined, undefined, helmLabelSelector),
      batchV1Api.listNamespacedJob(namespace, undefined, undefined, undefined, undefined, k8sApplyLabelSelector),
    ]);

    const helmJobs = helmJobsResponse.body.items || [];
    const k8sJobs = k8sJobsResponse.body.items || [];

    const relevantK8sJobs = k8sJobs.filter((job) => {
      const annotations = job.metadata?.annotations || {};
      if (annotations['lifecycle/service-name'] === serviceName) {
        return true;
      }

      const labels = job.metadata?.labels || {};
      return labels['service'] === serviceName;
    });

    const allJobs = [...helmJobs, ...relevantK8sJobs];
    const deploymentJobs: DeploymentJobInfo[] = [];

    for (const job of allJobs) {
      const jobName = job.metadata?.name || '';
      const labels = job.metadata?.labels || {};

      const nameParts = jobName.split('-');
      const deployUuid = nameParts.slice(0, -3).join('-');
      const sha = nameParts[nameParts.length - 1];

      const deploymentType: 'helm' | 'github' = labels['app.kubernetes.io/name'] === 'native-helm' ? 'helm' : 'github';

      let status: DeploymentJobInfo['status'] = 'Pending';
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

      deploymentJobs.push({
        jobName,
        deployUuid,
        sha,
        status,
        startedAt: startedAt ? new Date(startedAt).toISOString() : undefined,
        completedAt: completedAt ? new Date(completedAt).toISOString() : undefined,
        duration,
        error,
        podName,
        deploymentType,
      });
    }

    deploymentJobs.sort((a, b) => {
      const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return bTime - aTime;
    });

    return deploymentJobs;
  } catch (error) {
    logger.error(`Error listing deployment jobs for service ${serviceName}:`, error);
    throw error;
  }
}

/**
 * @openapi
 * /api/v1/builds/{uuid}/services/{name}/deployLogs:
 *   get:
 *     summary: List deployment jobs for a service
 *     description: |
 *       Returns a list of all deployment jobs for a specific service within a build.
 *       This includes both Helm deployment jobs and GitHub-type deployment jobs.
 *     tags:
 *       - Deployments
 *     security:
 *       - ApiKeyAuth: []
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
 *         description: List of deployment jobs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deployments:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       jobName:
 *                         type: string
 *                         description: Kubernetes job name
 *                         example: deploy-uuid-helm-123-abc123
 *                       deployUuid:
 *                         type: string
 *                         description: Deploy UUID
 *                         example: deploy-uuid
 *                       sha:
 *                         type: string
 *                         description: Git commit SHA
 *                         example: abc123
 *                       status:
 *                         type: string
 *                         enum: [Active, Complete, Failed]
 *                         description: Current status of the deployment job
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
 *                         description: Deployment duration in seconds
 *                       error:
 *                         type: string
 *                         description: Error message if job failed
 *                       podName:
 *                         type: string
 *                         description: Name of the pod running the job
 *                       deploymentType:
 *                         type: string
 *                         enum: [helm, github]
 *                         description: Type of deployment (helm or github)
 *       '400':
 *         description: Invalid parameters
 *       '404':
 *         description: Environment or service not found
 *       '405':
 *         description: Method not allowed
 *       '502':
 *         description: Failed to communicate with Kubernetes
 *       '500':
 *         description: Internal server error
 */
const deployLogsHandler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    logger.warn({ method: req.method }, 'Method not allowed');
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  const { valid } = await validateAuth(req, res);
  if (!valid) return;

  const { uuid, name } = req.query;

  if (typeof uuid !== 'string' || typeof name !== 'string') {
    logger.warn({ uuid, name }, 'Missing or invalid query parameters');
    return res.status(400).json({ error: 'Missing or invalid uuid or name parameters' });
  }

  try {
    const namespace = `env-${uuid}`;

    const deployments = await getDeploymentJobs(name, namespace);

    const response: DeployLogsListResponse = {
      deployments,
    };

    return res.status(200).json(response);
  } catch (error) {
    logger.error({ err: error }, `Error getting deploy logs for service ${name} in environment ${uuid}.`);

    if (error instanceof HttpError) {
      if (error.response?.statusCode === 404) {
        return res.status(404).json({ error: 'Environment or service not found.' });
      }
      return res.status(502).json({ error: 'Failed to communicate with Kubernetes.' });
    }

    return res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

export default deployLogsHandler;
