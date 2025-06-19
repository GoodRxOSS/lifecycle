import { Deploy } from '../../models';
import { shellPromise } from '../shell';
import logger from '../logger';
import GlobalConfigService from '../../services/globalConfig';
import {
  waitForJobAndGetLogs,
  DEFAULT_BUILD_RESOURCES,
  getGitHubToken,
  getBuildLabels,
  getBuildAnnotations,
  createRepoSpecificGitCloneContainer,
} from './utils';
import * as yaml from 'js-yaml';

export interface BuildkitBuildOptions {
  ecrRepo: string;
  ecrDomain: string;
  envVars: Record<string, string>;
  dockerfilePath: string;
  tag: string;
  revision: string;
  repo: string;
  branch: string;
  initDockerfilePath?: string;
  initTag?: string;
  namespace: string;
  buildId: string;
  deployUuid: string; // The full deploy UUID (serviceName-buildUuid)
  serviceAccount?: string;
  jobTimeout?: number;
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
}

function createBuildkitContainer(
  name: string,
  dockerfilePath: string,
  destination: string,
  cacheRef: string,
  contextPath: string,
  envVars: Record<string, string>,
  resources: any,
  buildArgs: Record<string, string>
): any {
  const command = ['/usr/bin/buildctl'];
  const args = [
    'build',
    '--frontend',
    'dockerfile.v0',
    '--local',
    `context=${contextPath}`,
    '--local',
    `dockerfile=${contextPath}`,
    '--opt',
    `filename=${dockerfilePath}`,
    '--output',
    `type=image,name=${destination},push=true,registry.insecure=true,oci-mediatypes=false`,
    '--export-cache',
    `type=registry,ref=${cacheRef},mode=max,registry.insecure=true`,
    '--import-cache',
    `type=registry,ref=${cacheRef},registry.insecure=true`,
  ];

  Object.entries(buildArgs).forEach(([key, value]) => {
    args.push('--opt', `build-arg:${key}=${value}`);
  });

  return {
    name,
    image: 'moby/buildkit:v0.12.0',
    command,
    args,
    env: Object.entries(envVars).map(([envName, value]) => ({ name: envName, value })),
    volumeMounts: [
      {
        name: 'workspace',
        mountPath: '/workspace',
      },
    ],
    resources,
  };
}

export async function buildkitBuild(
  deploy: Deploy,
  options: BuildkitBuildOptions
): Promise<{ success: boolean; logs: string; jobName: string }> {
  const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
  const buildDefaults = globalConfig.buildDefaults || {};
  const buildkitConfig = buildDefaults.buildkit || {};

  const buildkitEndpoint = buildkitConfig.endpoint || 'tcp://buildkit.lifecycle-app.svc.cluster.local:1234';
  const serviceAccount = options.serviceAccount || buildDefaults.serviceAccount || 'native-build-sa';
  const jobTimeout = options.jobTimeout || buildDefaults.jobTimeout || 2100;
  const resources = options.resources || buildDefaults.resources?.buildkit || DEFAULT_BUILD_RESOURCES.buildkit;

  const serviceName = deploy.deployable!.name;
  const shortRepoName = options.repo.split('/')[1] || options.repo;
  const jobId = Math.random().toString(36).substring(2, 7);
  const shortSha = options.revision.substring(0, 7);
  const jobName = `${options.deployUuid}-buildkit-${jobId}-${shortSha}`.substring(0, 63);

  logger.info(
    `[Buildkit] Building image(s) for ${options.deployUuid}: dockerfilePath=${
      options.dockerfilePath
    }, initDockerfilePath=${options.initDockerfilePath || 'none'}, repo=${options.repo}`
  );

  const githubToken = await getGitHubToken();
  const gitUsername = 'x-access-token';
  const contextPath = `/workspace/repo-${shortRepoName}`;

  // For security, we'll use a git clone init container instead of embedding credentials in the URL
  // This prevents token exposure in logs
  const gitCloneContainer = createRepoSpecificGitCloneContainer(
    options.repo,
    options.revision,
    contextPath,
    gitUsername,
    githubToken
  );

  const envVars: Record<string, string> = {
    ...options.envVars,
    BUILDKIT_HOST: buildkitEndpoint,
    DOCKER_BUILDKIT: '1',
    BUILDCTL_CONNECT_RETRIES_MAX: '10',
  };

  const containers = [];

  const mainDestination = `${options.ecrDomain}/${options.ecrRepo}:${options.tag}`;
  const mainCacheRef = `${options.ecrDomain}/${shortRepoName}:cache`;

  containers.push(
    createBuildkitContainer(
      'buildkit-main',
      options.dockerfilePath || 'Dockerfile',
      mainDestination,
      mainCacheRef,
      contextPath,
      envVars,
      resources,
      options.envVars
    )
  );

  if (options.initDockerfilePath && options.initTag) {
    const initDestination = `${options.ecrDomain}/${options.ecrRepo}:${options.initTag}`;

    containers.push(
      createBuildkitContainer(
        'buildkit-init',
        options.initDockerfilePath,
        initDestination,
        mainCacheRef, // Share cache with main build
        contextPath,
        envVars,
        resources,
        options.envVars
      )
    );

    logger.info(`[Buildkit] Job ${jobName} will build both main and init images in parallel`);
  }

  const labels = getBuildLabels(serviceName, options.deployUuid, options.buildId, shortSha, options.branch, 'buildkit');
  const annotations = getBuildAnnotations(options.dockerfilePath || 'Dockerfile', options.ecrRepo);

  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: options.namespace,
      labels: {
        'app.kubernetes.io/name': 'native-build',
        'app.kubernetes.io/component': 'build',
        'app.kubernetes.io/managed-by': 'lifecycle',
        ...labels,
      },
      annotations,
    },
    spec: {
      ttlSecondsAfterFinished: 86400, // 24 hours
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
          containers, // Multiple containers will run in parallel
          volumes: [
            {
              name: 'workspace',
              emptyDir: {},
            },
          ],
        },
      },
    },
  };

  const jobYaml = yaml.dump(job, { quotingType: '"', forceQuotes: true });
  const applyResult = await shellPromise(`cat <<'EOF' | kubectl apply -f -
${jobYaml}
EOF`);
  logger.info(`Created buildkit job ${jobName} in namespace ${options.namespace}`, { applyResult });

  try {
    const { logs, success } = await waitForJobAndGetLogs(jobName, options.namespace, jobTimeout);

    return { success, logs, jobName };
  } catch (error) {
    logger.error(`Error getting logs for buildkit job ${jobName}`, { error });

    try {
      const jobStatus = await shellPromise(
        `kubectl get job ${jobName} -n ${options.namespace} -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}'`
      );
      const jobSucceeded = jobStatus.trim() === 'True';

      if (jobSucceeded) {
        logger.info(`Job ${jobName} completed successfully despite log retrieval error`);
        return { success: true, logs: 'Log retrieval failed but job completed successfully', jobName };
      }
    } catch (statusError) {
      logger.error(`Failed to check job status for ${jobName}`, { statusError });
    }

    return { success: false, logs: `Build failed: ${error.message}`, jobName };
  }
}
