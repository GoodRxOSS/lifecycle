/**
 * Copyright 2026 GoodRx, Inc.
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

import { DeployTypes, FeatureFlags, NO_DEFAULT_ENV_UUID } from 'shared/constants';

const mockGetAllConfigs = jest.fn();
const mockIsFeatureEnabled = jest.fn();

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args),
      isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
    })),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
    warn: jest.fn(),
  })),
}));

import * as YamlService from '../YamlService';

describe('YamlService behavior helpers', () => {
  const github = {
    name: 'github-app',
    appShort: 'github-short',
    github: {
      repository: 'org/github-app',
      branchName: 'main',
      envLens: false,
      docker: {
        defaultTag: 'github-tag',
        pipelineId: 'github-build-pipeline',
        builder: { engine: 'ci', resources: { requests: { cpu: '1' } } },
        app: {
          dockerfilePath: 'Dockerfile',
          env: { APP_ENV: 'github' },
          ports: [3000, 3001],
          afterBuildPipelineConfig: {
            afterBuildPipelineId: 'github-after-build',
            detatchAfterBuildPipeline: true,
          },
        },
        init: { dockerfilePath: 'Dockerfile.init', env: { INIT_ENV: 'github' } },
      },
      deployment: { public: true },
    },
  } as any;
  const codefresh = {
    name: 'codefresh-app',
    codefresh: {
      repository: 'org/codefresh-app',
      branchName: 'release',
      env: { APP_ENV: 'codefresh' },
      deploy: { pipelineId: 'deploy-pipeline', trigger: 'deploy-trigger' },
      destroy: { pipelineId: 'destroy-pipeline', trigger: 'destroy-trigger' },
      deployment: { capacityType: 'spot' },
    },
  } as any;
  const docker = {
    name: 'docker-app',
    docker: {
      dockerImage: 'postgres',
      defaultTag: '16',
      env: { APP_ENV: 'docker' },
      ports: [5432],
      deployment: { public: false },
      envLens: undefined,
    },
  } as any;
  const helm = {
    name: 'helm-app',
    helm: {
      repository: 'org/helm-app',
      branchName: 'helm-main',
      grpc: true,
      disableIngressHost: true,
      envLens: true,
      chart: { name: 'app-chart' },
      docker: {
        defaultTag: 'helm-tag',
        pipelineId: 'helm-build-pipeline',
        ecr: 'registry.example/helm-app',
        builder: { resources: { limits: { memory: '2Gi' } } },
        app: {
          dockerfilePath: 'helm/Dockerfile',
          env: { APP_ENV: 'helm' },
          ports: [8080],
          afterBuildPipelineConfig: {
            afterBuildPipelineId: 'helm-after-build',
            detatchAfterBuildPipeline: true,
          },
        },
        init: { dockerfilePath: 'helm/Dockerfile.init', env: { INIT_ENV: 'helm' } },
      },
    },
  } as any;
  const aurora = { name: 'database', auroraRestore: { command: 'restore', arguments: '--latest' } } as any;
  const unknown = { name: 'unknown' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllConfigs.mockResolvedValue({
      lifecycleDefaults: { defaultUUID: 'dev-0', ecrRegistry: 'registry.example' },
      domainDefaults: { http: 'http.example.com', grpc: 'grpc.example.com' },
      serviceDefaults: { defaultTag: 'global-tag' },
    });
    mockIsFeatureEnabled.mockResolvedValue(false);
  });

  it('identifies service and Docker configuration shapes without treating null as configured', () => {
    expect(YamlService.isGithubServiceDockerConfig(null)).toBe(false);
    expect(YamlService.isGithubServiceDockerConfig({ dockerfilePath: 'Dockerfile' })).toBe(true);
    expect(YamlService.isGithubServiceDockerConfig({})).toBe(false);
    expect(YamlService.isDockerServiceConfig(null)).toBe(false);
    expect(YamlService.isDockerServiceConfig({ dockerImage: 'postgres' })).toBe(true);
    expect(YamlService.isDockerServiceConfig({})).toBe(false);
    expect(YamlService.isHelmService(helm)).toBe(true);
    expect(YamlService.isHelmService(github)).toBe(false);
    expect(YamlService.getDeployType(helm)).toBe(DeployTypes.HELM);
    expect(YamlService.getDeployType(unknown)).toBeUndefined();
  });

  it('applies a default native builder only to Lifecycle-managed images without an explicit engine', () => {
    const helmWithoutEngine = {
      ...helm,
      helm: {
        ...helm.helm,
        docker: { ...helm.helm.docker, builder: { resources: { limits: { memory: '2Gi' } } } },
      },
    };
    expect(YamlService.getEffectiveBuilder(helmWithoutEngine, 'buildkit')).toEqual({
      resources: { limits: { memory: '2Gi' } },
      engine: 'buildkit',
    });
    expect(YamlService.getEffectiveBuilder(github, 'buildkit')).toEqual(github.github.docker.builder);
    expect(YamlService.getEffectiveBuilder(docker, 'buildkit')).toEqual({});
    expect(YamlService.getEffectiveBuilder(helmWithoutEngine)).toEqual({ resources: { limits: { memory: '2Gi' } } });
  });

  it('reads source-specific repository, image, environment, pipeline, and deployment fields', async () => {
    expect(YamlService.getEnvironmentVariables(helm)).toEqual({ APP_ENV: 'helm' });
    expect(YamlService.getInitEnvironmentVariables(helm)).toEqual({ INIT_ENV: 'helm' });
    expect(YamlService.getAfterBuildPipelineId(helm)).toBe('helm-after-build');
    expect(YamlService.getDetatchAfterBuildPipeline(helm)).toBe(true);
    expect(YamlService.getAfterBuildPipelineId(unknown)).toBeUndefined();
    expect(YamlService.getDetatchAfterBuildPipeline(unknown)).toBe(false);
    expect(YamlService.getDockerImage(docker)).toBe('postgres');
    expect(YamlService.getDockerImage(unknown)).toBeUndefined();

    expect(YamlService.getRepositoryName(github)).toBe('org/github-app');
    expect(YamlService.getRepositoryName(codefresh)).toBe('org/codefresh-app');
    expect(YamlService.getRepositoryName(helm)).toBe('org/helm-app');
    expect(YamlService.getRepositoryName(unknown)).toBeUndefined();
    expect(YamlService.getBranchName(github)).toBe('main');
    expect(YamlService.getBranchName(codefresh)).toBe('release');
    expect(YamlService.getBranchName(helm)).toBe('helm-main');
    expect(YamlService.getBranchName(unknown)).toBeUndefined();

    await expect(YamlService.getDefaultTag(github)).resolves.toBe('github-tag');
    await expect(YamlService.getDefaultTag(docker)).resolves.toBe('16');
    await expect(YamlService.getDefaultTag(helm)).resolves.toBe('helm-tag');
    await expect(YamlService.getDefaultTag(unknown)).resolves.toBe('global-tag');

    expect(YamlService.getAppDockerConfig(github)).toBe(github.github.docker.app);
    expect(YamlService.getAppDockerConfig(docker)).toBe(docker.docker);
    expect(YamlService.getAppDockerConfig(aurora)).toBe(aurora.auroraRestore);
    expect(YamlService.getAppDockerConfig(helm)).toBe(helm.helm.docker.app);
    expect(YamlService.getAppDockerConfig(unknown)).toBeUndefined();
    expect(YamlService.getInitDockerConfig(github)).toBe(github.github.docker.init);
    expect(YamlService.getInitDockerConfig(helm)).toBe(helm.helm.docker.init);
    expect(YamlService.getInitDockerConfig(unknown)).toBeUndefined();

    expect(YamlService.getPort(github)).toBe('3000,3001');
    expect(YamlService.getPort(docker)).toBe('5432');
    expect(YamlService.getPort(helm)).toBe('8080');
    expect(YamlService.getPort(unknown)).toBeUndefined();
    expect(YamlService.getDeploymentConfig(github)).toEqual({ public: true });
    expect(YamlService.getDeploymentConfig(docker)).toEqual({ public: false });
    expect(YamlService.getDeploymentConfig(codefresh)).toEqual({ capacityType: 'spot' });
    expect(YamlService.getDeploymentConfig(helm)).toBeUndefined();
    expect(YamlService.getDeployPipelineConfig(codefresh)).toEqual(codefresh.codefresh.deploy);
    expect(YamlService.getDestroyPipelineConfig(codefresh)).toEqual(codefresh.codefresh.destroy);
    expect(YamlService.getDeployPipelineConfig(github)).toBeUndefined();
    expect(YamlService.getDestroyPipelineConfig(github)).toBeUndefined();
  });

  it('reads the legacy GitHub environment block when the app Docker block has no environment', () => {
    const legacyGithub = {
      name: 'legacy-github-app',
      github: {
        repository: 'org/legacy-app',
        env: { LEGACY_CONFIG: 'preserved' },
        docker: { app: { dockerfilePath: 'Dockerfile' } },
      },
    } as any;

    expect(YamlService.getEnvironmentVariables(legacyGithub)).toEqual({ LEGACY_CONFIG: 'preserved' });
  });

  it('uses the documented default port when a managed service omits its port list', () => {
    const githubWithoutPorts = {
      ...github,
      github: {
        ...github.github,
        docker: { ...github.github.docker, app: { ...github.github.docker.app, ports: undefined } },
      },
    };
    const dockerWithoutPorts = { ...docker, docker: { ...docker.docker, ports: undefined } };
    const helmWithoutPorts = {
      ...helm,
      helm: {
        ...helm.helm,
        docker: { ...helm.helm.docker, app: { ...helm.helm.docker.app, ports: undefined } },
      },
    };
    expect(YamlService.getPort(githubWithoutPorts)).toBe('8080');
    expect(YamlService.getPort(dockerWithoutPorts)).toBe('8080');
    expect(YamlService.getPort(helmWithoutPorts)).toBe('8080');
  });

  it('merges Helm defaults, chart configuration, and service overrides in priority order', async () => {
    mockGetAllConfigs.mockResolvedValueOnce({
      helmDefaults: {
        version: 'default-version',
        args: '--default',
        chart: { repoUrl: 'https://default.example', values: ['default=true'] },
      },
      'app-chart': {
        version: 'chart-version',
        chart: { repoUrl: 'https://chart.example', values: ['chart=true'] },
      },
      publicChart: { block: false },
    });
    const service = {
      name: 'helm-app',
      helm: {
        version: 'service-version',
        chart: { name: 'app-chart', valueFiles: ['values.yaml'], values: ['service=true'] },
      },
    } as any;

    await expect(YamlService.getHelmConfigFromYaml(service)).resolves.toEqual(
      expect.objectContaining({
        version: 'service-version',
        args: '--default',
        chart: {
          name: 'app-chart',
          repoUrl: 'https://chart.example',
          valueFiles: ['values.yaml'],
          values: ['service=true'],
        },
      })
    );
  });

  it('warns through unsupported public charts unless the global block is enabled', async () => {
    const unsupported = { name: 'helm-app', helm: { chart: { name: 'unlisted' } } } as any;
    mockGetAllConfigs.mockResolvedValueOnce({ helmDefaults: {}, publicChart: { block: false } });
    await expect(YamlService.getHelmConfigFromYaml(unsupported)).resolves.toMatchObject({
      chart: { name: 'unlisted' },
    });

    mockGetAllConfigs.mockResolvedValueOnce({ helmDefaults: {}, publicChart: { block: true } });
    await expect(YamlService.getHelmConfigFromYaml(unsupported)).rejects.toThrow(
      'Unspported Chart: helmChart with name: unlisted is not currently supported'
    );

    mockGetAllConfigs.mockResolvedValueOnce({});
    await expect(YamlService.getHelmConfigFromYaml(github)).resolves.toBeUndefined();
  });

  it('rethrows repository lookup failures instead of silently hiding malformed service objects', () => {
    const failure = new Error('malformed service');
    const malformed = new Proxy({ name: 'broken' } as any, {
      get(target, property) {
        if (property === 'github') throw failure;
        return Reflect.get(target, property);
      },
    });
    expect(() => YamlService.getRepositoryName(malformed)).toThrow(failure);
  });

  it('resolves readiness probes without treating HTTP and TCP probes as interchangeable', async () => {
    await expect(
      YamlService.getTcpSocketPort({ readiness: { disabled: true, tcpSocketPort: 3000 } })
    ).resolves.toBeNull();
    await expect(YamlService.getTcpSocketPort({ readiness: { tcpSocketPort: 3000 } })).resolves.toBe(3000);
    await expect(
      YamlService.getTcpSocketPort({ readiness: { httpGet: { port: 8080, path: '/ready' } } })
    ).resolves.toBeNull();
    await expect(YamlService.getTcpSocketPort({})).resolves.toBeNull();

    await expect(
      YamlService.getHttpGetPortAndHost({ readiness: { disabled: true, httpGet: { port: 8080, path: '/ready' } } })
    ).resolves.toBeNull();
    await expect(YamlService.getHttpGetPortAndHost({ readiness: { tcpSocketPort: 3000 } })).resolves.toEqual({
      port: null,
      path: null,
    });
    await expect(YamlService.getHttpGetPortAndHost({})).resolves.toBeNull();
    await expect(
      YamlService.getHttpGetPortAndHost({ readiness: { httpGet: { port: 8080, path: '/ready' } } })
    ).resolves.toEqual({ port: 8080, path: '/ready' });

    await expect(YamlService.getHttpGetPortAndHost({ readiness: { httpGet: { port: 8080 } as any } })).resolves.toEqual(
      { port: 8080, path: undefined }
    );
    await expect(
      YamlService.getHttpGetPortAndHost({ readiness: { httpGet: { path: '/ready' } as any } })
    ).resolves.toEqual({ port: undefined, path: '/ready' });
  });

  it('selects HTTP and gRPC domains from Helm ingress behavior and UUID precedence', async () => {
    await expect(YamlService.getPublicUrl(helm, { enabledFeatures: [], uuid: 'preview' } as any)).resolves.toBe(
      'helm-app-dev-0.grpc.example.com'
    );
    expect(YamlService.getHost({ service: helm, domain: { http: 'http.example.com', grpc: 'grpc.example.com' } })).toBe(
      'grpc.example.com'
    );
    expect(
      YamlService.getHost({
        service: { ...helm, helm: { ...helm.helm, disableIngressHost: false } },
        domain: { http: 'http.example.com', grpc: 'grpc.example.com' },
      })
    ).toBe('http.example.com');
    expect(
      YamlService.getHost({ service: github, domain: { http: 'http.example.com', grpc: 'grpc.example.com' } })
    ).toBe('http.example.com');

    await expect(YamlService.getUUID(github, null as any)).resolves.toBe('dev-0');
    await expect(
      YamlService.getUUID({ ...github, defaultUUID: 'service-default' }, {
        enabledFeatures: [FeatureFlags.NO_DEFAULT_ENV_RESOLVE],
      } as any)
    ).resolves.toBe(NO_DEFAULT_ENV_UUID);
    await expect(
      YamlService.getUUID({ ...github, defaultUUID: 'service-default' }, { enabledFeatures: [] } as any)
    ).resolves.toBe('service-default');
    await expect(YamlService.getUUID(github, { enabledFeatures: [] } as any)).resolves.toBe('dev-0');
  });

  it('returns builder, feature, build-pipeline, app-short, and ECR values without exposing unrelated service shapes', async () => {
    expect(YamlService.getBuilder(github)).toBe(github.github.docker.builder);
    expect(YamlService.getBuilder(helm)).toBe(helm.helm.docker.builder);
    expect(YamlService.getBuilder(docker)).toEqual({});
    expect(YamlService.getAppShort(github)).toBe('github-short');
    expect(YamlService.getDockerBuildPipelineId(github)).toBe('github-build-pipeline');
    expect(YamlService.getDockerBuildPipelineId(helm)).toBe('helm-build-pipeline');
    expect(YamlService.getDockerBuildPipelineId(unknown)).toBeUndefined();

    mockIsFeatureEnabled.mockResolvedValue(true);
    await expect(YamlService.getEnvLens(github)).resolves.toBe(false);
    await expect(YamlService.getEnvLens(docker)).resolves.toBe(true);
    await expect(YamlService.getEnvLens(helm)).resolves.toBe(true);
    await expect(YamlService.getEnvLens(unknown)).resolves.toBe(true);
    expect(mockIsFeatureEnabled).toHaveBeenCalledWith('envLens');

    await expect(YamlService.getEcr(helm)).resolves.toBe('registry.example/helm-app');
    await expect(YamlService.getEcr({ name: 'no-app-short', helm: { docker: {} } } as any)).resolves.toBe(
      'registry.example/lifecycle-deployments'
    );
  });
});
