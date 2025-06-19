import { V1Job, V1ServiceAccount, V1Role, V1RoleBinding } from '@kubernetes/client-node';
import { shellPromise } from '../shell';
import logger from '../logger';
import * as k8s from '@kubernetes/client-node';
import GlobalConfigService from '../../services/globalConfig';

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
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
  const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);

  const serviceAccount: V1ServiceAccount = {
    metadata: {
      name: serviceAccountName,
      namespace,
      annotations: awsRoleArn
        ? {
            'eks.amazonaws.com/role-arn': awsRoleArn,
          }
        : {},
    },
  };

  try {
    await coreV1Api.createNamespacedServiceAccount(namespace, serviceAccount);
  } catch (error) {
    if (error?.response?.statusCode === 409) {
      await coreV1Api.patchNamespacedServiceAccount(
        serviceAccountName,
        namespace,
        serviceAccount,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );
    } else {
      throw error;
    }
  }

  const role: V1Role = {
    metadata: {
      name: `${serviceAccountName}-role`,
      namespace,
    },
    rules: [
      {
        apiGroups: ['batch'],
        resources: ['jobs'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      {
        apiGroups: [''],
        resources: ['pods', 'pods/log'],
        verbs: ['get', 'list', 'watch'],
      },
    ],
  };

  try {
    await rbacApi.createNamespacedRole(namespace, role);
  } catch (error) {
    if (error?.response?.statusCode === 409) {
      await rbacApi.patchNamespacedRole(
        role.metadata.name,
        namespace,
        role,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );
    } else {
      throw error;
    }
  }

  const roleBinding: V1RoleBinding = {
    metadata: {
      name: `${serviceAccountName}-binding`,
      namespace,
    },
    subjects: [
      {
        kind: 'ServiceAccount',
        name: serviceAccountName,
        namespace,
      },
    ],
    roleRef: {
      kind: 'Role',
      name: role.metadata.name,
      apiGroup: 'rbac.authorization.k8s.io',
    },
  };

  try {
    await rbacApi.createNamespacedRoleBinding(namespace, roleBinding);
  } catch (error) {
    if (error?.response?.statusCode === 409) {
      // Role binding already exists, ignore
    } else {
      throw error;
    }
  }
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
  const timeoutSeconds = typeof logPrefix === 'number' ? logPrefix : 1800;
  const startTime = Date.now();
  let logs = '';
  let podName: string | null = null;

  while (!podName && Date.now() - startTime < timeoutSeconds * 1000) {
    try {
      const pods = await shellPromise(
        `kubectl get pods -n ${namespace} -l job-name=${jobName} -o jsonpath='{.items[0].metadata.name}'`
      );
      if (pods.trim()) {
        podName = pods.trim();
        break;
      }
    } catch (error) {
      // Pod not ready yet, will retry
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  if (!podName) {
    throw new Error(`Pod for job ${jobName} was not created within timeout`);
  }

  let initContainersReady = false;
  while (!initContainersReady && Date.now() - startTime < timeoutSeconds * 1000) {
    try {
      const initContainerStatuses = await shellPromise(
        `kubectl get pod ${podName} -n ${namespace} -o jsonpath='{.status.initContainerStatuses}'`
      );

      if (initContainerStatuses && initContainerStatuses !== '[]') {
        const statuses = JSON.parse(initContainerStatuses);
        initContainersReady = statuses.every((status: any) => status.ready || status.state.terminated);
      } else {
        initContainersReady = true;
      }
    } catch (error) {
      // Init container status check failed, will retry
    }

    if (!initContainersReady) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  try {
    const initContainerNames = await shellPromise(
      `kubectl get pod ${podName} -n ${namespace} -o jsonpath='{.spec.initContainers[*].name}'`
    );

    if (initContainerNames && initContainerNames.trim()) {
      const initNames = initContainerNames.split(' ').filter((name) => name);
      for (const initName of initNames) {
        try {
          const initLogs = await shellPromise(
            `kubectl logs -n ${namespace} ${podName} -c ${initName} --timestamps=true`
          );
          logs += `\n=== Init Container Logs (${initName}) ===\n${initLogs}\n`;
        } catch (err: any) {
          logger.debug(`Could not get logs for init container ${initName}: ${err.message || 'Unknown error'}`);
        }
      }
    }
  } catch (error: any) {
    logger.debug(`No init containers found for pod ${podName}: ${error.message || 'Unknown error'}`);
  }

  let containerLogs = '';

  let allContainersReady = false;
  let retries = 0;

  while (!allContainersReady && retries < 30 && Date.now() - startTime < timeoutSeconds * 1000) {
    try {
      const containerStatuses = await shellPromise(
        `kubectl get pod ${podName} -n ${namespace} -o jsonpath='{.status.containerStatuses}'`
      ).catch(() => '[]');

      if (containerStatuses && containerStatuses !== '[]') {
        const statuses = JSON.parse(containerStatuses);
        allContainersReady = statuses.every((status: any) => status.state.terminated || status.state.running);

        if (!allContainersReady) {
          const waiting = statuses.find((s: any) => s.state.waiting);
          if (waiting && waiting.state.waiting.reason) {
            logger.info(
              `Container ${waiting.name} is waiting: ${waiting.state.waiting.reason} - ${
                waiting.state.waiting.message || 'no message'
              }`
            );
          }
        }
      }
    } catch (e) {
      // Container status check failed, will retry
    }

    if (!allContainersReady) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      retries++;
    }
  }

  let containerNames: string[] = [];
  try {
    const containersJson = await shellPromise(
      `kubectl get pod ${podName} -n ${namespace} -o jsonpath='{.spec.containers[*].name}'`
    );
    containerNames = containersJson.split(' ').filter((name) => name);
  } catch (error) {
    logger.warn(`Could not get container names: ${error}`);
  }

  for (const containerName of containerNames) {
    try {
      const containerLog = await shellPromise(
        `kubectl logs -n ${namespace} ${podName} -c ${containerName} --timestamps=true`,
        { timeout: timeoutSeconds * 1000 }
      );

      if (containerLog && containerLog.trim()) {
        containerLogs += `\n=== Container Logs (${containerName}) ===\n${containerLog}\n`;
      }
    } catch (error: any) {
      logger.warn(`Error getting logs from container ${containerName}: ${error.message}`);
      containerLogs += `\n=== Container Logs (${containerName}) ===\nError retrieving logs: ${error.message}\n`;
    }
  }

  logs += containerLogs;

  // Wait for job to complete (either succeed or fail)
  // We wait indefinitely because the job's activeDeadlineSeconds will ensure it times out
  // This way Kubernetes is the single source of truth for job completion
  let jobCompleted = false;

  while (!jobCompleted) {
    try {
      const jobConditions = await shellPromise(
        `kubectl get job ${jobName} -n ${namespace} -o jsonpath='{.status.conditions}'`
      );

      if (jobConditions && jobConditions !== '[]') {
        const conditions = JSON.parse(jobConditions);
        jobCompleted = conditions.some(
          (condition: any) =>
            (condition.type === 'Complete' || condition.type === 'Failed') && condition.status === 'True'
        );
      }

      if (!jobCompleted) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (error: any) {
      logger.debug(`Job status check failed for ${jobName}, will retry: ${error.message || 'Unknown error'}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // Check job status - this is the source of truth
  let success = false;
  let status = 'failed';
  try {
    const jobStatus = await shellPromise(
      `kubectl get job ${jobName} -n ${namespace} -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}'`
    );
    success = jobStatus.trim() === 'True';

    if (!success) {
      const failedStatus = await shellPromise(
        `kubectl get job ${jobName} -n ${namespace} -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}'`
      );

      if (failedStatus.trim() === 'True') {
        logger.error(`Job ${jobName} failed`);

        try {
          const annotations = await shellPromise(
            `kubectl get job ${jobName} -n ${namespace} ` +
              `-o jsonpath='{.metadata.annotations.lifecycle\\.goodrx\\.com/termination-reason}'`
          );

          if (annotations === 'superseded-by-retry') {
            logger.info(`${logPrefix || ''} Job ${jobName} superseded by newer deployment`);
            success = true;
            status = 'superseded';
            logs = (logs || '') + '\n\n=== Job was superseded by a newer deployment attempt ===';
          }
        } catch (annotationError: any) {
          logger.debug(
            `Could not check supersession annotation for job ${jobName}: ${annotationError.message || 'Unknown error'}`
          );
        }
      }
    } else {
      status = 'succeeded';
    }
  } catch (error) {
    logger.error(`Failed to check job status for ${jobName}:`, error);
    // If we can't determine status, assume failure
    success = false;
  }

  return { logs, success, status };
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
  gitCloneContainer: any;
  buildContainer: any;
  volumes: any[];
}

export function createBuildJobManifest(options: BuildJobManifestOptions): any {
  const {
    jobName,
    namespace,
    serviceAccount,
    serviceName,
    deployUuid,
    buildId,
    shortSha,
    branch,
    engine,
    dockerfilePath,
    ecrRepo,
    jobTimeout,
    ttlSecondsAfterFinished = 86400, // Default 24 hours
    gitCloneContainer,
    buildContainer,
    volumes,
  } = options;

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels: {
        'app.kubernetes.io/name': 'native-build',
        'app.kubernetes.io/component': 'build',
        'lc-service': serviceName,
        'lc-deploy-uuid': deployUuid,
        'lc-build-id': String(buildId),
        'git-sha': shortSha,
        'git-branch': branch,
        'builder-engine': engine,
        'build-method': 'native',
      },
      annotations: {
        'lifecycle.io/dockerfile': dockerfilePath,
        'lifecycle.io/ecr-repo': ecrRepo,
        'lifecycle.io/triggered-at': new Date().toISOString(),
      },
    },
    spec: {
      ttlSecondsAfterFinished,
      backoffLimit: 0,
      activeDeadlineSeconds: jobTimeout,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'native-build',
            'app.kubernetes.io/component': 'build',
            'lc-service': serviceName,
          },
        },
        spec: {
          serviceAccountName: serviceAccount,
          restartPolicy: 'Never',
          initContainers: [gitCloneContainer],
          containers: [buildContainer],
          volumes,
        },
      },
    },
  };
}
