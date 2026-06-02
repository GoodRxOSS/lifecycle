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
import { getLogger } from '../logger';
import GlobalConfigService from '../../services/globalConfig';
import {
  waitForJobAndGetLogs,
  DEFAULT_BUILD_RESOURCES,
  getGitHubToken,
  createRepoSpecificGitCloneContainer,
} from './utils';
import { createBuildJob } from '../kubernetes/jobFactory';
import { buildNativeBuildJobName } from '../kubernetes/jobNames';
import * as yaml from 'js-yaml';
import { getLogArchivalService } from '../../services/logArchival';
import {
  buildNativeBuildRegistryAuthSecretName,
  createKanikoRegistryAuthMergeInitContainer,
  createNativeBuildRegistryAuthSecret,
  createRegistryAuthCopyInitContainer,
  createRegistryAuthVolumes,
  deleteNativeBuildRegistryAuthSecret,
  DOCKER_CONFIG_MOUNT_PATH,
  DOCKER_CONFIG_VOLUME_NAME,
  GarRegistryAuth,
  getKanikoInsecureRegistries,
  isConfiguredGarRegistry,
  KANIKO_DOCKER_CONFIG_MOUNT_PATH,
  normalizeNativeBuildRegistryAuth,
} from './registryAuth';

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
  buildUuid?: string;
  serviceAccount?: string;
  jobTimeout?: number;
  cacheRegistry?: string;
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
  secretRefs?: string[];
  secretEnvKeys?: string[];
  podAnnotations?: Record<string, string>;
}

interface BuildEngine {
  name: 'buildkit' | 'kaniko';
  image: string;
  command: string[];
  // eslint-disable-next-line no-unused-vars
  createArgs: (options: BuildArgOptions) => string[];
  envVars?: Record<string, string>;
  // eslint-disable-next-line no-unused-vars
  getCacheRef: (cacheRegistry: string | undefined, ecrRepo: string) => string;
}

interface BuildArgOptions {
  contextPath: string;
  dockerfilePath: string;
  destination: string;
  cacheRef: string;
  buildArgs: Record<string, string>;
  ecrDomain: string;
  registryAuth?: GarRegistryAuth[];
  secretEnvKeys?: string[];
}

export function generateSecretArgsScript(secretEnvKeys?: string[]): string {
  if (!secretEnvKeys || secretEnvKeys.length === 0) {
    return '# No secret env keys';
  }

  const lines = secretEnvKeys.map(
    (key) => `[ -n "$${key}" ] && SECRET_BUILD_ARGS="$SECRET_BUILD_ARGS --opt build-arg:${key}=$${key}"`
  );

  return lines.join('\n');
}

const ENGINES: Record<string, BuildEngine> = {
  buildkit: {
    name: 'buildkit',
    image: 'moby/buildkit:v0.29.0',
    command: ['/bin/sh', '-c'],
    createArgs: ({
      contextPath,
      dockerfilePath,
      destination,
      cacheRef,
      buildArgs,
      ecrDomain,
      registryAuth = [],
      secretEnvKeys,
    }) => {
      const outputInsecureOption = isConfiguredGarRegistry(destination, registryAuth) ? '' : ',registry.insecure=true';
      const cacheInsecureOption = isConfiguredGarRegistry(cacheRef, registryAuth) ? '' : ',insecure=true';
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
        `type=image,name=${destination},push=true${outputInsecureOption},oci-mediatypes=false`,
        '--export-cache',
        `type=registry,ref=${cacheRef},mode=max,compression=zstd,oci-mediatypes=true${cacheInsecureOption}`,
        '--import-cache',
        `type=registry,ref=${cacheRef}${cacheInsecureOption}`,
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

  export AWS_MAX_ATTEMPTS=5
  export AWS_RETRY_MODE=adaptive
  
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

# Build secret env vars as build args
SECRET_BUILD_ARGS=""
${generateSecretArgsScript(secretEnvKeys)}

echo "Running buildctl..."
buildctl ${buildctlArgs.join(' \\\n  ')} $SECRET_BUILD_ARGS
`;

      return [script.trim()];
    },
    getCacheRef: (cacheRegistry, ecrRepo) => `${cacheRegistry}/${ecrRepo}:cache`,
  },
  kaniko: {
    name: 'kaniko',
    image: 'gcr.io/kaniko-project/executor:v1.9.2',
    command: ['/kaniko/executor'],
    createArgs: ({ contextPath, dockerfilePath, destination, cacheRef, buildArgs, registryAuth = [] }) => {
      const insecureRegistryArgs =
        registryAuth.length === 0
          ? ['--insecure-registry']
          : getKanikoInsecureRegistries([destination, cacheRef], registryAuth).map(
              (registry) => `--insecure-registry=${registry}`
            );
      const args = [
        `--context=${contextPath}`,
        `--dockerfile=${contextPath}/${dockerfilePath}`,
        `--destination=${destination}`,
        '--cache=true',
        `--cache-repo=${cacheRef}`,
        ...insecureRegistryArgs,
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

function appendCacheRefSegments(cacheRef: string, serviceName: string, buildUuid?: string): string {
  const suffix = cacheRef.includes(':cache') ? ':cache' : '/cache';
  const segments = [serviceName, buildUuid].filter(Boolean).join('/');
  return cacheRef.replace(suffix, `/${segments}${suffix}`);
}

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
  ecrDomain: string,
  secretRefs?: string[],
  secretEnvKeys?: string[],
  registryAuth: GarRegistryAuth[] = []
): any {
  const args = engine.createArgs({
    contextPath,
    dockerfilePath,
    destination,
    cacheRef,
    buildArgs,
    ecrDomain,
    registryAuth,
    secretEnvKeys,
  });

  const containerEnvVars = engine.name === 'buildkit' ? envVars : buildArgs;

  const volumeMounts = [
    {
      name: 'workspace',
      mountPath: '/workspace',
    },
  ];

  if (engine.name === 'kaniko' && registryAuth.length === 0) {
    volumeMounts.push({
      name: 'workspace',
      mountPath: KANIKO_DOCKER_CONFIG_MOUNT_PATH,
      subPath: '.docker',
    } as any);
    containerEnvVars['DOCKER_CONFIG'] = KANIKO_DOCKER_CONFIG_MOUNT_PATH;
  } else if (registryAuth.length > 0) {
    volumeMounts.push({
      name: DOCKER_CONFIG_VOLUME_NAME,
      mountPath: engine.name === 'kaniko' ? KANIKO_DOCKER_CONFIG_MOUNT_PATH : '/root/.docker',
    } as any);

    if (engine.name === 'kaniko') {
      containerEnvVars['DOCKER_CONFIG'] = KANIKO_DOCKER_CONFIG_MOUNT_PATH;
    }
  }

  const container: any = {
    name,
    image: engine.image,
    command: engine.command,
    args,
    env: Object.entries(containerEnvVars).map(([envName, value]) => ({ name: envName, value: String(value) })),
    volumeMounts,
    resources,
  };

  if (secretRefs && secretRefs.length > 0) {
    container.envFrom = secretRefs.map((secretName) => ({
      secretRef: {
        name: secretName,
        optional: false,
      },
    }));
  }

  return container;
}

export async function buildWithEngine(
  deploy: Deploy,
  options: NativeBuildOptions,
  engineName: 'buildkit' | 'kaniko'
): Promise<{ success: boolean; logs: string; jobName: string }> {
  const engine = ENGINES[engineName];
  const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
  const buildDefaults = globalConfig.buildDefaults || {};
  const registryAuth = normalizeNativeBuildRegistryAuth(buildDefaults.registryAuth);

  const serviceAccount = options.serviceAccount || buildDefaults.serviceAccount || 'native-build-sa';
  const jobTimeout = options.jobTimeout || buildDefaults.jobTimeout || 2100;
  const resources = options.resources || buildDefaults.resources?.[engineName] || DEFAULT_BUILD_RESOURCES[engineName];
  const podAnnotations = {
    ...buildDefaults.podAnnotations,
    ...options.podAnnotations,
    'cluster-autoscaler.kubernetes.io/safe-to-evict': 'false',
  };

  const cacheRegistry = options.cacheRegistry || buildDefaults.cacheRegistry;

  const serviceName = deploy.deployable!.name;
  const shortRepoName = options.repo.split('/')[1] || options.repo;
  const jobId = Math.random().toString(36).substring(2, 7);
  const shortSha = options.revision.substring(0, 7);
  const jobName = buildNativeBuildJobName({
    deployUuid: options.deployUuid,
    jobId,
    shortSha,
  });
  const registryAuthSecretName =
    registryAuth.length > 0
      ? buildNativeBuildRegistryAuthSecretName({
          deployUuid: options.deployUuid,
          jobId,
          shortSha,
        })
      : undefined;
  const contextPath = `/workspace/repo-${shortRepoName}`;

  getLogger().debug(`Build: preparing ${engine.name} job dockerfile=${options.dockerfilePath}`);

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
    const dockerConfigDirectory = registryAuth.length > 0 ? DOCKER_CONFIG_MOUNT_PATH : '/workspace/.docker';
    const dockerConfigPath =
      registryAuth.length > 0 ? `${DOCKER_CONFIG_MOUNT_PATH}/ecr-config.json` : '/workspace/.docker/config.json';
    registryLoginScript = [
      'set -e',
      'export AWS_MAX_ATTEMPTS=5',
      'export AWS_RETRY_MODE=adaptive',
      `aws ecr get-login-password --region ${region} | { read PASSWORD; mkdir -p ${dockerConfigDirectory} && ` +
        `echo '{"auths":{"${registryDomain}":{"auth":"'$(echo -n "AWS:$PASSWORD" | base64)'"}}}' > ${dockerConfigPath}; }`,
    ].join('\n');
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
        name: registryAuth.length > 0 ? DOCKER_CONFIG_VOLUME_NAME : 'workspace',
        mountPath: registryAuth.length > 0 ? DOCKER_CONFIG_MOUNT_PATH : '/workspace',
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

  const containers: any[] = [];
  let cacheRef = engine.getCacheRef(cacheRegistry, options.ecrRepo);

  // Scope cache per service + build-uuid to prevent concurrent PR builds from corrupting shared cache entries
  if (cacheRegistry && !cacheRegistry.includes('ecr') && !cacheRef.includes(`/${serviceName}`)) {
    cacheRef = appendCacheRefSegments(cacheRef, serviceName, options.buildUuid);
  }

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
      options.ecrDomain,
      options.secretRefs,
      options.secretEnvKeys,
      registryAuth
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
        options.ecrDomain,
        options.secretRefs,
        options.secretEnvKeys,
        registryAuth
      )
    );
    getLogger().debug('Build: including init image');
  }

  await deploy.$fetchGraph('build');
  const isStatic = deploy.build?.isStatic || false;

  const registryAuthInitContainers = registryAuthSecretName ? [createRegistryAuthCopyInitContainer()] : [];
  let initContainers;

  if (engineName === 'buildkit') {
    initContainers = [gitCloneContainer, ...registryAuthInitContainers];
  } else if (registryAuth.length === 0) {
    initContainers = [gitCloneContainer, registryLoginContainer];
  } else if (ecrMatch) {
    initContainers = [
      gitCloneContainer,
      ...registryAuthInitContainers,
      registryLoginContainer,
      createKanikoRegistryAuthMergeInitContainer(),
    ];
  } else {
    initContainers = [gitCloneContainer, ...registryAuthInitContainers];
  }

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
      ...(registryAuthSecretName ? createRegistryAuthVolumes(registryAuthSecretName) : []),
    ],
    podAnnotations,
  });

  const jobYaml = yaml.dump(job, { quotingType: '"', forceQuotes: true });
  const logArchivalEnabled = globalConfig.logArchival?.enabled;
  let registryAuthSecretCreated = false;

  try {
    if (registryAuthSecretName) {
      await createNativeBuildRegistryAuthSecret({
        namespace: options.namespace,
        secretName: registryAuthSecretName,
        registryAuth,
        buildUuid: options.buildUuid,
        deployUuid: options.deployUuid,
      });
      registryAuthSecretCreated = true;
    }

    await shellPromise(`cat <<'EOF' | kubectl apply -f -
${jobYaml}
EOF`);
    getLogger().debug(`Job: created ${jobName}`);

    try {
      const { logs, success, startedAt, completedAt, duration } = await waitForJobAndGetLogs(
        jobName,
        options.namespace,
        jobTimeout
      );

      if (logArchivalEnabled) {
        try {
          const archivalService = getLogArchivalService();
          await archivalService.archiveLogs(
            {
              jobName,
              jobType: 'build',
              serviceName,
              namespace: options.namespace,
              status: success ? 'Complete' : 'Failed',
              sha: options.revision,
              deployUuid: options.deployUuid,
              buildUuid: options.buildId,
              engine: engineName,
              startedAt,
              completedAt,
              duration,
              archivedAt: new Date().toISOString(),
            },
            logs
          );
        } catch (archiveError) {
          getLogger().warn({ error: archiveError }, `LogArchival: failed to archive build logs jobName=${jobName}`);
        }
      }

      return { success, logs, jobName };
    } catch (error) {
      getLogger({ error }).error(`Job: log retrieval failed name=${jobName}`);

      try {
        const jobStatus = await shellPromise(
          `kubectl get job ${jobName} -n ${options.namespace} -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}'`
        );
        const jobSucceeded = jobStatus.trim() === 'True';

        if (jobSucceeded) {
          getLogger().debug(`Job: completed (logs unavailable) job=${jobName}`);
          return { success: true, logs: 'Log retrieval failed but job completed successfully', jobName };
        }
      } catch (statusError) {
        getLogger({ error: statusError }).error(`Job: status check failed name=${jobName}`);
      }

      if (logArchivalEnabled) {
        try {
          const archivalService = getLogArchivalService();
          await archivalService.archiveLogs(
            {
              jobName,
              jobType: 'build',
              serviceName,
              namespace: options.namespace,
              status: 'Failed',
              sha: options.revision,
              deployUuid: options.deployUuid,
              buildUuid: options.buildId,
              engine: engineName,
              archivedAt: new Date().toISOString(),
            },
            `Build failed: ${error.message}`
          );
        } catch (archiveError) {
          getLogger().warn(
            { error: archiveError },
            `LogArchival: failed to archive build error logs jobName=${jobName}`
          );
        }
      }

      return { success: false, logs: `Build failed: ${error.message}`, jobName };
    }
  } finally {
    if (registryAuthSecretCreated && registryAuthSecretName) {
      await deleteNativeBuildRegistryAuthSecret(options.namespace, registryAuthSecretName);
    }
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
