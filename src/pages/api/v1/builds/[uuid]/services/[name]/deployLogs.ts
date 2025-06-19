import type { NextApiRequest, NextApiResponse } from 'next';
import rootLogger from 'server/lib/logger';
import * as k8s from '@kubernetes/client-node';
import { HttpError } from '@kubernetes/client-node';

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
}

interface DeployLogsListResponse {
  deployments: DeploymentJobInfo[];
}

async function getHelmDeploymentJobs(serviceName: string, namespace: string): Promise<DeploymentJobInfo[]> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const batchV1Api = kc.makeApiClient(k8s.BatchV1Api);
  const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

  try {
    const labelSelector = `service=${serviceName}`;
    const jobListResponse = await batchV1Api.listNamespacedJob(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    const jobs = jobListResponse.body.items || [];
    const deploymentJobs: DeploymentJobInfo[] = [];

    for (const job of jobs) {
      const jobName = job.metadata?.name || '';

      const nameParts = jobName.split('-');
      const deployUuid = nameParts.slice(0, -3).join('-');
      const sha = nameParts[nameParts.length - 1];

      let status: DeploymentJobInfo['status'] = 'Active';
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
      });
    }

    deploymentJobs.sort((a, b) => {
      const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return bTime - aTime;
    });

    return deploymentJobs;
  } catch (error) {
    logger.error(`Error listing helm deployment jobs for service ${serviceName}:`, error);
    throw error;
  }
}

const deployLogsHandler = async (req: NextApiRequest, res: NextApiResponse) => {
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

    const deployments = await getHelmDeploymentJobs(name, namespace);

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
