import { Deploy } from '../../models';
import { shellPromise } from '../shell';
import logger from '../logger';
import GlobalConfigService from '../../services/globalConfig';
import {
  waitForJobAndGetLogs,
  DEFAULT_BUILD_RESOURCES,
  getGitHubToken,
  createRepoSpecificGitCloneContainer,
} from './utils';
import { createBuildJob } from '../kubernetes/jobFactory';
import * as yaml from 'js-yaml';

export interface NativeBuildOptions {
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
  deployUuid: string;
  serviceAccount?: string;
  jobTimeout?: number;
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
}

interface BuildEngine {
  name: 'buildkit' | 'kaniko';
  image: string;
  command: string[];
  // eslint-disable-next-line no-unused-vars
  createArgs: (options: BuildArgOptions) => string[];
  envVars?: Record<string, string>;
  // eslint-disable-next-line no-unused-vars
  getCacheRef: (ecrDomain: string, shortRepoName: string) => string;
}

interface BuildArgOptions {
  contextPath: string;
  dockerfilePath: string;
  destination: string;
  cacheRef: string;
  buildArgs: Record<string, string>;
}

const ENGINES: Record<string, BuildEngine> = {
  buildkit: {
    name: 'buildkit',
    image: 'moby/buildkit:v0.12.0',
    command: ['/usr/bin/buildctl'],
    createArgs: ({ contextPath, dockerfilePath, destination, cacheRef, buildArgs }) => {
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

      return args;
    },
    getCacheRef: (ecrDomain, shortRepoName) => `${ecrDomain}/${shortRepoName}:cache`,
  },
  kaniko: {
    name: 'kaniko',
    image: 'gcr.io/kaniko-project/executor:v1.9.2',
    command: ['/kaniko/executor'],
    createArgs: ({ contextPath, dockerfilePath, destination, cacheRef, buildArgs }) => {
      const args = [
        `--context=${contextPath}`,
        `--dockerfile=${contextPath}/${dockerfilePath}`,
        `--destination=${destination}`,
        '--cache=true',
        `--cache-repo=${cacheRef}`,
        '--insecure-registry',
        '--push-retry=3',
        '--snapshot-mode=time',
      ];

      Object.entries(buildArgs).forEach(([key, value]) => {
        args.push(`--build-arg=${key}=${value}`);
      });

      return args;
    },
    getCacheRef: (ecrDomain, shortRepoName) => `${ecrDomain}/${shortRepoName}/cache`,
  },
};

function createBuildContainer(
  name: string,
  engine: BuildEngine,
  dockerfilePath: string,
  destination: string,
  cacheRef: string,
  contextPath: string,
  envVars: Record<string, string>,
  resources: any,
  buildArgs: Record<string, string>
): any {
  const args = engine.createArgs({
    contextPath,
    dockerfilePath,
    destination,
    cacheRef,
    buildArgs,
  });

  const containerEnvVars = engine.name === 'buildkit' ? envVars : buildArgs;

  return {
    name,
    image: engine.image,
    command: engine.command,
    args,
    env: Object.entries(containerEnvVars).map(([envName, value]) => ({ name: envName, value })),
    volumeMounts: [
      {
        name: 'workspace',
        mountPath: '/workspace',
      },
    ],
    resources,
  };
}

export async function buildWithEngine(
  deploy: Deploy,
  options: NativeBuildOptions,
  engineName: 'buildkit' | 'kaniko'
): Promise<{ success: boolean; logs: string; jobName: string }> {
  const engine = ENGINES[engineName];
  const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
  const buildDefaults = globalConfig.buildDefaults || {};

  const serviceAccount = options.serviceAccount || buildDefaults.serviceAccount || 'native-build-sa';
  const jobTimeout = options.jobTimeout || buildDefaults.jobTimeout || 2100;
  const resources = options.resources || buildDefaults.resources?.[engineName] || DEFAULT_BUILD_RESOURCES[engineName];

  const serviceName = deploy.deployable!.name;
  const shortRepoName = options.repo.split('/')[1] || options.repo;
  const jobId = Math.random().toString(36).substring(2, 7);
  const shortSha = options.revision.substring(0, 7);
  const jobName = `${options.deployUuid}-build-${jobId}-${shortSha}`.substring(0, 63);
  const contextPath = `/workspace/repo-${shortRepoName}`;

  logger.info(
    `[${engine.name}] Building image(s) for ${options.deployUuid}: dockerfilePath=${
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

  let envVars: Record<string, string> = { ...options.envVars };

  if (engineName === 'buildkit') {
    const buildkitConfig = buildDefaults.buildkit || {};
    const buildkitEndpoint = buildkitConfig.endpoint || 'tcp://buildkit.lifecycle-app.svc.cluster.local:1234';
    envVars = {
      ...envVars,
      BUILDKIT_HOST: buildkitEndpoint,
      DOCKER_BUILDKIT: '1',
      BUILDCTL_CONNECT_RETRIES_MAX: '10',
    };
  }

  const containers = [];
  const cacheRef = engine.getCacheRef(options.ecrDomain, shortRepoName);

  const mainDestination = `${options.ecrDomain}/${options.ecrRepo}:${options.tag}`;
  containers.push(
    createBuildContainer(
      `${engineName}-main`,
      engine,
      options.dockerfilePath || 'Dockerfile',
      mainDestination,
      cacheRef,
      contextPath,
      envVars,
      resources,
      options.envVars
    )
  );

  if (options.initDockerfilePath && options.initTag) {
    const initDestination = `${options.ecrDomain}/${options.ecrRepo}:${options.initTag}`;
    containers.push(
      createBuildContainer(
        `${engineName}-init`,
        engine,
        options.initDockerfilePath,
        initDestination,
        cacheRef,
        contextPath,
        envVars,
        resources,
        options.envVars
      )
    );
    logger.info(`[${engine.name}] Job ${jobName} will build both main and init images in parallel`);
  }

  await deploy.$fetchGraph('build');
  const isStatic = deploy.build?.isStatic || false;

  const job = createBuildJob({
    jobName,
    namespace: options.namespace,
    serviceAccount,
    serviceName,
    deployUuid: options.deployUuid,
    buildId: options.buildId,
    shortSha,
    branch: options.branch,
    engine: engineName,
    dockerfilePath: options.dockerfilePath || 'Dockerfile',
    ecrRepo: options.ecrRepo,
    jobTimeout,
    isStatic,
    gitCloneContainer,
    containers,
    volumes: [
      {
        name: 'workspace',
        emptyDir: {},
      },
    ],
  });

  const jobYaml = yaml.dump(job, { quotingType: '"', forceQuotes: true });
  const applyResult = await shellPromise(`cat <<'EOF' | kubectl apply -f -
${jobYaml}
EOF`);
  logger.info(`Created ${engineName} job ${jobName} in namespace ${options.namespace}`, { applyResult });

  try {
    const { logs, success } = await waitForJobAndGetLogs(jobName, options.namespace, jobTimeout);
    return { success, logs, jobName };
  } catch (error) {
    logger.error(`Error getting logs for ${engineName} job ${jobName}`, { error });

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

export async function buildkitBuild(
  deploy: Deploy,
  options: NativeBuildOptions
): Promise<{ success: boolean; logs: string; jobName: string }> {
  return buildWithEngine(deploy, options, 'buildkit');
}

export async function kanikoBuild(
  deploy: Deploy,
  options: NativeBuildOptions
): Promise<{ success: boolean; logs: string; jobName: string }> {
  return buildWithEngine(deploy, options, 'kaniko');
}
