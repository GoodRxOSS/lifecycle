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
import { HttpError } from '@kubernetes/client-node';
import { Deploy } from 'server/models';
import { getLogger } from 'server/lib/logger/index';
import GlobalConfigService from 'server/services/globalConfig';

export interface KubernetesApplyJobConfig {
  deploy: Deploy;
  namespace: string;
  jobId: string;
}

export async function createKubernetesApplyJob({
  deploy,
  namespace,
  jobId,
}: KubernetesApplyJobConfig): Promise<k8s.V1Job> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const batchApi = kc.makeApiClient(k8s.BatchV1Api);
  const shortSha = deploy.sha?.substring(0, 7) || 'unknown';
  const jobName = `${deploy.uuid}-deploy-${jobId}-${shortSha}`.substring(0, 63);
  const serviceName = deploy.deployable?.name || deploy.service?.name || '';

  getLogger().info(`Creating Kubernetes apply job: jobName=${jobName} service=${serviceName}`);

  const configMapName = `${jobName}-manifest`;
  await createManifestConfigMap(deploy, configMapName, namespace);

  const job: k8s.V1Job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels: {
        lc_uuid: deploy.build.uuid,
        deploy_uuid: deploy.uuid,
        app: 'lifecycle-deploy',
        type: 'kubernetes-apply',
        ...(serviceName ? { service: serviceName } : {}),
      },
      annotations: {
        'lifecycle/deploy-id': deploy.id.toString(),
        'lifecycle/job-type': 'kubernetes-apply',
        'lifecycle/service-name': deploy.deployable?.name || deploy.service?.name || '',
      },
    },
    spec: {
      ttlSecondsAfterFinished: 86400,
      backoffLimit: 3,
      template: {
        metadata: {
          labels: {
            lc_uuid: deploy.build.uuid,
            deploy_uuid: deploy.uuid,
            'job-name': jobName,
            ...(serviceName ? { service: serviceName } : {}),
          },
        },
        spec: {
          restartPolicy: 'OnFailure',
          serviceAccountName: await getServiceAccountName(),
          containers: [
            {
              name: 'kubectl-apply',
              image: 'bitnamilegacy/kubectl:1.30',
              command: ['/bin/bash', '-c'],
              args: [
                `
              set -e
              echo "Applying manifest for ${deploy.uuid}..."
              kubectl apply -f /manifests/manifest.yaml
              
              if kubectl get deployment ${deploy.uuid} -n ${namespace} &>/dev/null; then
                kubectl rollout status deployment/${deploy.uuid} -n ${namespace} --timeout=300s
              fi
            `,
              ],
              volumeMounts: [
                {
                  name: 'manifest',
                  mountPath: '/manifests',
                  readOnly: true,
                },
              ],
              resources: {
                requests: {
                  memory: '128Mi',
                  cpu: '100m',
                },
                limits: {
                  memory: '256Mi',
                  cpu: '200m',
                },
              },
            },
          ],
          volumes: [
            {
              name: 'manifest',
              configMap: {
                name: configMapName,
                items: [
                  {
                    key: 'manifest.yaml',
                    path: 'manifest.yaml',
                  },
                ],
              },
            },
          ],
        },
      },
    },
  };

  const createdJob = await batchApi.createNamespacedJob(namespace, job);
  getLogger().info(`Created Kubernetes apply job: jobName=${jobName} jobId=${jobId}`);

  return createdJob.body;
}

async function createManifestConfigMap(deploy: Deploy, configMapName: string, namespace: string): Promise<void> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  if (!deploy.manifest) {
    throw new Error(`Deploy ${deploy.uuid} has no manifest`);
  }

  const configMap: k8s.V1ConfigMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configMapName,
      namespace,
      labels: {
        lc_uuid: deploy.build.uuid,
        deploy_uuid: deploy.uuid,
        app: 'lifecycle-deploy',
      },
    },
    data: {
      'manifest.yaml': deploy.manifest,
    },
  };

  try {
    await coreApi.createNamespacedConfigMap(namespace, configMap);
  } catch (error) {
    if (error instanceof HttpError) {
      getLogger({ error }).error(
        `Failed to create ConfigMap: configMapName=${configMapName} statusCode=${error.statusCode}`
      );
    }
    throw error;
  }
}

async function getServiceAccountName(): Promise<string> {
  const { serviceAccount } = await GlobalConfigService.getInstance().getAllConfigs();
  return serviceAccount?.name || 'default';
}

export async function monitorKubernetesJob(
  jobName: string,
  namespace: string,
  maxAttempts = 120
): Promise<{ success: boolean; message: string }> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const batchApi = kc.makeApiClient(k8s.BatchV1Api);

  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const job = await batchApi.readNamespacedJob(jobName, namespace);

      if (job.body.status?.succeeded) {
        return {
          success: true,
          message: 'Kubernetes resources applied successfully',
        };
      }

      if (job.body.status?.failed) {
        const conditions = job.body.status.conditions || [];
        const failureReason =
          conditions
            .filter((c) => c.type === 'Failed')
            .map((c) => c.message)
            .join('; ') || 'Unknown failure reason';

        return {
          success: false,
          message: `Kubernetes apply job failed: ${failureReason}`,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
      attempts++;
    } catch (error) {
      getLogger().error({ error }, `Error monitoring job: jobName=${jobName}`);
      throw error;
    }
  }

  return {
    success: false,
    message: 'Kubernetes apply job timed out after 10 minutes',
  };
}
