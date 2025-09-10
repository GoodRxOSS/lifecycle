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
  cacheRegistry?: string;
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
  getCacheRef: (cacheRegistry: string, ecrRepo: string) => string;
}

interface BuildArgOptions {
  contextPath: string;
  dockerfilePath: string;
  destination: string;
  cacheRef: string;
  buildArgs: Record<string, string>;
  ecrDomain: string;
}

const ENGINES: Record<string, BuildEngine> = {
  buildkit: {
    name: 'buildkit',
    image: 'moby/buildkit:v0.12.0',
    command: ['/bin/sh', '-c'],
    createArgs: ({ contextPath, dockerfilePath, destination, cacheRef, buildArgs, ecrDomain }) => {
      const buildctlArgs = [
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
        `type=registry,ref=${cacheRef},mode=min,compression=zstd,insecure=true`,
        '--import-cache',
        `type=registry,ref=${cacheRef},insecure=true`,
      ];

      Object.entries(buildArgs).forEach(([key, value]) => {
        buildctlArgs.push('--opt', `build-arg:${key}=${value}`);
      });

      const script = `
set -e

# Detect registry type and perform appropriate login
REGISTRY_DOMAIN="${ecrDomain}"

# AWS ECR Detection (format: <account-id>.dkr.ecr.<region>.amazonaws.com)
if echo "\${REGISTRY_DOMAIN}" | grep -qE "^[0-9]+\\.dkr\\.ecr\\.([a-z0-9-]+)\\.amazonaws\\.com$"; then
  echo "Detected AWS ECR registry"
  
  # Extract region from domain
  AWS_REGION=$(echo "\${REGISTRY_DOMAIN}" | sed -n 's/^[0-9]*\\.dkr\\.ecr\\.\\([^.]*\\)\\.amazonaws\\.com$/\\1/p')
  echo "ECR Region: \${AWS_REGION}"
  
  echo "Installing AWS CLI and Docker CLI..."
  apk add --no-cache aws-cli docker-cli
  
  echo "Testing AWS credentials..."
  if aws sts get-caller-identity; then
    echo "Getting ECR login token..."
    ECR_PASSWORD=$(aws ecr get-login-password --region \${AWS_REGION})
    echo "Got ECR password (length: \${#ECR_PASSWORD})"
    
    echo "Logging into ECR..."
    echo "$ECR_PASSWORD" | docker login --username AWS --password-stdin \${REGISTRY_DOMAIN}
  else
    echo "ERROR: AWS credentials not configured"
    exit 1
  fi

# In-cluster or custom registry (no authentication required)
else
  echo "Using in-cluster registry: \${REGISTRY_DOMAIN}"
  echo "Installing Docker CLI..."
  apk add --no-cache docker-cli
fi

echo "Setting DOCKER_CONFIG..."
export DOCKER_CONFIG=~/.docker

echo "Running buildctl..."
buildctl ${buildctlArgs.join(' \\\n  ')}
`;

      return [script.trim()];
    },
    getCacheRef: (cacheRegistry, ecrRepo) => `${cacheRegistry}/${ecrRepo}:cache`,
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
    getCacheRef: (cacheRegistry, ecrRepo) => `${cacheRegistry}/${ecrRepo}/cache`,
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
  buildArgs: Record<string, string>,
  ecrDomain: string
): any {
  const args = engine.createArgs({
    contextPath,
    dockerfilePath,
    destination,
    cacheRef,
    buildArgs,
    ecrDomain,
  });

  const containerEnvVars = engine.name === 'buildkit' ? envVars : buildArgs;

  const volumeMounts = [
    {
      name: 'workspace',
      mountPath: '/workspace',
    },
  ];

  if (engine.name === 'kaniko') {
    volumeMounts.push({
      name: 'workspace',
      mountPath: '/kaniko/.docker',
      subPath: '.docker',
    } as any);
    containerEnvVars['DOCKER_CONFIG'] = '/kaniko/.docker';
  }

  return {
    name,
    image: engine.image,
    command: engine.command,
    args,
    env: Object.entries(containerEnvVars).map(([envName, value]) => ({ name: envName, value })),
    volumeMounts,
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

  let cacheRegistry = options.cacheRegistry || buildDefaults.cacheRegistry;
  if (engineName === 'buildkit' && buildDefaults.buildkit?.endpoint) {
    cacheRegistry = options.ecrDomain;
  }

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

  let registryLoginScript = '';
  const registryDomain = options.ecrDomain;

  const ecrRegex = /^[0-9]+\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/;
  const ecrMatch = registryDomain.match(ecrRegex);
  if (ecrMatch) {
    const region = ecrMatch[1] || 'us-west-2';
    registryLoginScript =
      `aws ecr get-login-password --region ${region} | ` +
      `{ read PASSWORD; mkdir -p /workspace/.docker && ` +
      `echo '{"auths":{"${registryDomain}":{"auth":"'$(echo -n "AWS:$PASSWORD" | base64)'"}}}' > /workspace/.docker/config.json; }`;
  } else {
    registryLoginScript =
      `echo "Using in-cluster registry: ${registryDomain}"; ` +
      `mkdir -p /workspace/.docker && echo '{}' > /workspace/.docker/config.json`;
  }

  const registryLoginContainer = {
    name: 'registry-login',
    image: registryDomain.includes('.dkr.ecr.') ? 'amazon/aws-cli:2.13.0' : 'alpine:3.18',
    command: ['/bin/sh', '-c'],
    args: [registryLoginScript],
    env: [{ name: 'AWS_REGION', value: process.env.AWS_REGION || 'us-west-2' }],
    volumeMounts: [
      {
        name: 'workspace',
        mountPath: '/workspace',
      },
    ],
  };

  let envVars: Record<string, string> = {
    ...options.envVars,
    AWS_REGION: process.env.AWS_REGION || 'us-west-2',
  };

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
  const cacheRef = engine.getCacheRef(cacheRegistry, options.ecrRepo);

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
      options.envVars,
      options.ecrDomain
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
        options.envVars,
        options.ecrDomain
      )
    );
    logger.info(`[${engine.name}] Job ${jobName} will build both main and init images in parallel`);
  }

  await deploy.$fetchGraph('build');
  const isStatic = deploy.build?.isStatic || false;

  // For buildkit, only git clone is needed. For kaniko, we need registry login too.
  const initContainers = engineName === 'buildkit' ? [gitCloneContainer] : [gitCloneContainer, registryLoginContainer];

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
    initContainers,
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
