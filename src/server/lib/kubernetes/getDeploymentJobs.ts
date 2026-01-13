import * as k8s from '@kubernetes/client-node';
import rootLogger from 'server/lib/logger';

export interface DeploymentJobInfo {
  jobName: string;
  deployUuid: string;
  sha: string;
  status: 'Active' | 'Complete' | 'Failed' | 'Pending';
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  error?: string;
  podName?: string;
  deploymentType: 'helm' | 'github';
}

const logger = rootLogger.child({
  filename: __filename,
});

export async function getDeploymentJobs(serviceName: string, namespace: string): Promise<DeploymentJobInfo[]> {
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
