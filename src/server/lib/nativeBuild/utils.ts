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

import { V1Job } from '@kubernetes/client-node';
import { shellPromise } from '../shell';
import logger from '../logger';
import * as k8s from '@kubernetes/client-node';
import GlobalConfigService from '../../services/globalConfig';
import { createBuildJob } from '../kubernetes/jobFactory';
import { setupBuildServiceAccountInNamespace as setupServiceAccountWithRBAC } from '../kubernetes/rbac';
import { JobMonitor } from '../kubernetes/JobMonitor';

export async function ensureNamespaceExists(namespace: string): Promise<void> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

  try {
    await coreV1Api.readNamespace(namespace);
    logger.info(`Namespace ${namespace} already exists`);
  } catch (error) {
    if (error?.response?.statusCode === 404) {
      logger.info(`Creating namespace ${namespace}`);
      await coreV1Api.createNamespace({
        metadata: {
          name: namespace,
          labels: {
            'app.kubernetes.io/managed-by': 'lifecycle',
            'lifecycle.io/type': 'ephemeral',
          },
        },
      });

      await waitForNamespaceReady(namespace);
    } else {
      throw error;
    }
  }
}

async function waitForNamespaceReady(namespace: string, timeout: number = 30000): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const result = await shellPromise(`kubectl get namespace ${namespace} -o jsonpath='{.status.phase}'`);
      if (result.trim() === 'Active') {
        return;
      }
    } catch (error) {
      // Namespace not ready yet, will retry
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Namespace ${namespace} did not become ready within ${timeout}ms`);
}

export async function setupBuildServiceAccountInNamespace(
  namespace: string,
  serviceAccountName: string = 'native-build-sa',
  awsRoleArn?: string
): Promise<void> {
  return setupServiceAccountWithRBAC(namespace, serviceAccountName, awsRoleArn);
}

export function createJob(
  name: string,
  namespace: string,
  serviceAccount: string,
  image: string,
  command: string[],
  args: string[],
  envVars: Record<string, string>,
  labels: Record<string, string>,
  annotations: Record<string, string>,
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  },
  ttlSecondsAfterFinished?: number
): V1Job {
  const env = Object.entries(envVars).map(([name, value]) => ({ name, value }));

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace,
      labels: {
        'app.kubernetes.io/name': 'native-build',
        'app.kubernetes.io/component': 'build',
        ...labels,
      },
      annotations,
    },
    spec: {
      ttlSecondsAfterFinished,
      backoffLimit: 0, // No automatic retries
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'native-build',
            'app.kubernetes.io/component': 'build',
            ...labels,
          },
          annotations,
        },
        spec: {
          serviceAccountName: serviceAccount,
          restartPolicy: 'Never',
          containers: [
            {
              name: 'build',
              image,
              command,
              args,
              env,
              resources: resources || {
                requests: {
                  cpu: '500m',
                  memory: '1Gi',
                },
                limits: {
                  cpu: '2',
                  memory: '4Gi',
                },
              },
            },
          ],
        },
      },
    },
  };
}

export async function waitForJobAndGetLogs(
  jobName: string,
  namespace: string,
  logPrefix?: string | number
): Promise<{ logs: string; success: boolean; status?: string }> {
  return JobMonitor.waitForJobAndGetLogs(jobName, namespace, logPrefix);
}

export const DEFAULT_BUILD_RESOURCES = {
  buildkit: {
    requests: {
      cpu: '500m',
      memory: '1Gi',
    },
    limits: {
      cpu: '2',
      memory: '4Gi',
    },
  },
  kaniko: {
    requests: {
      cpu: '300m',
      memory: '750Mi',
    },
    limits: {
      cpu: '1',
      memory: '2Gi',
    },
  },
};

export function getBuildLabels(
  serviceName: string,
  uuid: string,
  buildId: string,
  sha: string,
  branch: string,
  engine: string
): Record<string, string> {
  return {
    'lc-service': serviceName,
    'lc-uuid': uuid,
    'lc-build-id': String(buildId), // Ensure it's a string
    'git-sha': sha,
    'git-branch': branch,
    'builder-engine': engine,
    'build-method': 'native',
  };
}

export function getBuildAnnotations(dockerfilePath: string, ecrRepo: string): Record<string, string> {
  return {
    'lifecycle.io/dockerfile': dockerfilePath,
    'lifecycle.io/ecr-repo': ecrRepo,
    'lifecycle.io/triggered-at': new Date().toISOString(),
  };
}

export async function getGitHubToken(): Promise<string> {
  return await GlobalConfigService.getInstance().getGithubClientToken();
}

export const GIT_USERNAME = 'x-access-token';
export const MANIFEST_PATH = '/tmp/manifests';

export function createCloneScript(repo: string, branch: string, sha?: string): string {
  const cloneCmd = `git clone -b ${branch} https://\${GIT_USERNAME}:\${GIT_PASSWORD}@github.com/${repo}.git /workspace`;
  const checkoutCmd = sha ? ` && cd /workspace && git checkout ${sha}` : '';
  return `${cloneCmd}${checkoutCmd}`;
}

export function createGitCloneContainer(repo: string, revision: string, gitUsername: string, gitToken: string): any {
  return {
    name: 'git-clone',
    image: 'alpine/git:latest',
    command: ['sh', '-c'],
    args: [
      `git config --global --add safe.directory /workspace && \
       git clone https://\${GIT_USERNAME}:\${GIT_PASSWORD}@github.com/${repo}.git /workspace && \
       cd /workspace && \
       git checkout ${revision}`,
    ],
    env: [
      {
        name: 'GIT_USERNAME',
        value: gitUsername,
      },
      {
        name: 'GIT_PASSWORD',
        value: gitToken,
      },
    ],
    volumeMounts: [
      {
        name: 'workspace',
        mountPath: '/workspace',
      },
    ],
  };
}

export function createRepoSpecificGitCloneContainer(
  repo: string,
  revision: string,
  targetDir: string,
  gitUsername: string,
  gitToken: string
): any {
  return {
    name: 'git-clone',
    image: 'alpine/git:latest',
    command: ['sh', '-c'],
    args: [
      `git config --global --add safe.directory ${targetDir} && \
       git clone https://\${GIT_USERNAME}:\${GIT_PASSWORD}@github.com/${repo}.git ${targetDir} && \
       cd ${targetDir} && \
       git checkout ${revision}`,
    ],
    env: [
      {
        name: 'GIT_USERNAME',
        value: gitUsername,
      },
      {
        name: 'GIT_PASSWORD',
        value: gitToken,
      },
    ],
    volumeMounts: [
      {
        name: 'workspace',
        mountPath: '/workspace',
      },
    ],
  };
}

export interface BuildJobManifestOptions {
  jobName: string;
  namespace: string;
  serviceAccount: string;
  serviceName: string;
  deployUuid: string;
  buildId: string;
  shortSha: string;
  branch: string;
  engine: 'buildkit' | 'kaniko';
  dockerfilePath: string;
  ecrRepo: string;
  jobTimeout: number;
  ttlSecondsAfterFinished?: number;
  isStatic?: boolean;
  gitCloneContainer: any;
  buildContainer: any;
  volumes: any[];
}

export function createBuildJobManifest(options: BuildJobManifestOptions): any {
  const { buildContainer, ...config } = options;

  return createBuildJob({
    ...config,
    containers: [buildContainer],
  });
}
