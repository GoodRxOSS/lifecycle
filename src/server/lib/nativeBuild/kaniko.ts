import { Deploy } from '../../models';
import { shellPromise } from '../shell';
import logger from '../logger';
import GlobalConfigService from '../../services/globalConfig';
import {
  waitForJobAndGetLogs,
  DEFAULT_BUILD_RESOURCES,
  getGitHubToken,
  createBuildJobManifest,
  createRepoSpecificGitCloneContainer,
} from './utils';
import * as yaml from 'js-yaml';

export interface KanikoBuildOptions {
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

function createKanikoContainer(
  name: string,
  dockerfilePath: string,
  destination: string,
  cacheRepo: string,
  contextPath: string,
  resources: any,
  buildArgs: Record<string, string>
): any {
  const command = ['/kaniko/executor'];
  const args = [
    `--context=${contextPath}`,
    `--dockerfile=${contextPath}/${dockerfilePath}`,
    `--destination=${destination}`,
    '--cache=true',
    `--cache-repo=${cacheRepo}`,
    '--insecure-registry',
    '--push-retry=3',
    '--snapshot-mode=time',
  ];

  Object.entries(buildArgs).forEach(([key, value]) => {
    args.push(`--build-arg=${key}=${value}`);
  });

  return {
    name,
    image: 'gcr.io/kaniko-project/executor:v1.9.2',
    command,
    args,
    env: Object.entries(buildArgs).map(([envName, value]) => ({ name: envName, value })),
    volumeMounts: [
      {
        name: 'workspace',
        mountPath: '/workspace',
      },
    ],
    resources,
  };
}

export async function kanikoBuild(
  deploy: Deploy,
  options: KanikoBuildOptions
): Promise<{ success: boolean; logs: string; jobName: string }> {
  const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
  const buildDefaults = globalConfig.buildDefaults || {};

  const serviceAccount = options.serviceAccount || buildDefaults.serviceAccount || 'native-build-sa';
  const jobTimeout = options.jobTimeout || buildDefaults.jobTimeout || 2100;
  const resources = options.resources || buildDefaults.resources?.kaniko || DEFAULT_BUILD_RESOURCES.kaniko;

  const serviceName = deploy.deployable!.name;
  const shortRepoName = options.repo.split('/')[1] || options.repo;
  const jobId = Math.random().toString(36).substring(2, 7);
  const shortSha = options.revision.substring(0, 7);
  const jobName = `${options.deployUuid}-kaniko-${jobId}-${shortSha}`.substring(0, 63);
  const contextPath = `/workspace/repo-${shortRepoName}`;

  logger.info(
    `[Kaniko] Building image(s) for ${options.deployUuid}: dockerfilePath=${
      options.dockerfilePath
    }, initDockerfilePath=${options.initDockerfilePath || 'none'}, repo=${options.repo}`
  );

  const githubToken = await getGitHubToken();
  const gitUsername = 'x-access-token';

  const gitCloneContainer = createRepoSpecificGitCloneContainer(
    options.repo,
    options.revision,
    contextPath,
    gitUsername,
    githubToken
  );

  const containers = [];

  const mainDestination = `${options.ecrDomain}/${options.ecrRepo}:${options.tag}`;
  const cacheRepo = `${options.ecrDomain}/${shortRepoName}/cache`;

  containers.push(
    createKanikoContainer(
      'kaniko-main',
      options.dockerfilePath || 'Dockerfile',
      mainDestination,
      cacheRepo,
      contextPath,
      resources,
      options.envVars
    )
  );

  if (options.initDockerfilePath && options.initTag) {
    const initDestination = `${options.ecrDomain}/${options.ecrRepo}:${options.initTag}`;

    containers.push(
      createKanikoContainer(
        'kaniko-init',
        options.initDockerfilePath,
        initDestination,
        cacheRepo, // Share cache with main build
        contextPath,
        resources,
        options.envVars
      )
    );

    logger.info(`[Kaniko] Job ${jobName} will build both main and init images in parallel`);
  }

  const job = createBuildJobManifest({
    jobName,
    namespace: options.namespace,
    serviceAccount,
    serviceName,
    deployUuid: options.deployUuid,
    buildId: options.buildId,
    shortSha,
    branch: options.branch,
    engine: 'kaniko',
    dockerfilePath: options.dockerfilePath || 'Dockerfile',
    ecrRepo: options.ecrRepo,
    jobTimeout,
    gitCloneContainer,
    buildContainer: containers[0], // For backward compatibility with manifest function
    volumes: [
      {
        name: 'workspace',
        emptyDir: {},
      },
    ],
  });

  job.spec.template.spec.containers = containers;

  const jobYaml = yaml.dump(job, { quotingType: '"', forceQuotes: true });
  const applyResult = await shellPromise(`cat <<'EOF' | kubectl apply -f -
${jobYaml}
EOF`);
  logger.info(`Created kaniko job ${jobName} in namespace ${options.namespace}`, { applyResult });

  try {
    const { logs, success } = await waitForJobAndGetLogs(jobName, options.namespace, jobTimeout);

    return { success, logs, jobName };
  } catch (error) {
    logger.error(`Error getting logs for kaniko job ${jobName}`, { error });

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
