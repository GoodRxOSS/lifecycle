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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';

mockRedisClient();

const mockDeployQuery = jest.fn();
const mockShellPromise = jest.fn();
const mockKubeContextStep = jest.fn();
const mockGenerateCheckoutStep = jest.fn();
const mockDeletePendingHelmReleaseStep = jest.fn();
const mockWaitForInProgressDeploys = jest.fn();
const mockNativeDeployHelm = jest.fn();
const mockMkdir = jest.fn();
const mockWriteFile = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerDebug = jest.fn();
const mockGetLogger = jest.fn((_context?: unknown) => ({
  error: mockLoggerError,
  debug: mockLoggerDebug,
  warn: jest.fn(),
}));
const mockRenderTemplate = jest.fn(async (_build, values) => values || []);
const mockRandomAlphanumeric = jest.fn((_length?: number) => 'ABCD');

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: {
    ...jest.requireActual('fs').promises,
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  },
}));
jest.mock('server/lib/envVariables', () => ({
  EnvironmentVariables: class {},
}));
jest.mock('server/services/globalConfig');
jest.mock('server/models/Deploy', () => ({
  __esModule: true,
  default: {
    query: () => mockDeployQuery(),
  },
}));
jest.mock('server/lib/shell', () => ({
  shellPromise: (...args: unknown[]) => mockShellPromise(...args),
}));
jest.mock('server/lib/codefresh', () => ({
  kubeContextStep: (...args: unknown[]) => mockKubeContextStep(...args),
}));
jest.mock('server/lib/codefresh/utils', () => ({
  generateCheckoutStep: (...args: unknown[]) => mockGenerateCheckoutStep(...args),
}));
jest.mock('server/lib/codefresh/utils/generateCodefreshCmd', () => ({
  deletePendingHelmReleaseStep: (...args: unknown[]) => mockDeletePendingHelmReleaseStep(...args),
  waitForInProgressDeploys: (...args: unknown[]) => mockWaitForInProgressDeploys(...args),
}));
jest.mock('server/lib/nativeHelm/helm', () => ({
  deployHelm: (...args: unknown[]) => mockNativeDeployHelm(...args),
}));
jest.mock('server/lib/logger', () => ({
  getLogger: (context?: unknown) => mockGetLogger(context),
}));
jest.mock('server/lib/random', () => ({
  randomAlphanumeric: (length?: number) => mockRandomAlphanumeric(length),
}));
jest.mock('server/lib/helm/utils', () => {
  const originalModule = jest.requireActual('server/lib/helm/utils');
  return {
    ...originalModule,
    renderTemplate: (build: unknown, values?: unknown[]) => mockRenderTemplate(build, values),
  };
});

import yaml from 'js-yaml';
import {
  constructHelmDeploysBuildMetaData,
  constructImageVersion,
  deployHelm,
  generateCodefreshRunCommand,
  generateHelmCodefreshYamlNoCheckout,
  generateHelmCodefreshYamlWithCheckout,
  helmDeployStep,
  helmOrgAppDeployStep,
  helmPublicDeployStep,
  uninstallHelmReleases,
} from 'server/lib/helm';
import GlobalConfigService from 'server/services/globalConfig';

function makeConfigs() {
  return {
    lifecycleDefaults: {
      deployCluster: 'test-cluster',
      cfStepType: 'helm/codefresh:1.0.0',
      helmDeployPipeline: 'goodrx/helm-deploy',
    },
    app_setup: {
      org: 'goodrx',
    },
    'public-chart': {
      chart: {
        values: ['replicas=1', 'global.enabled=true'],
      },
      label: 'preview.goodrx.com',
      tolerations: 'pod.tolerations',
      nodeSelector: 'pod.nodeSelector',
    },
    'lifecycle-app': {
      chart: {
        values: ['deployment.defaultValue=true'],
      },
    },
    serviceDefaults: {
      defaultIPWhiteList: '[10.0.0.0/8, 192.168.0.0/16]',
    },
    domainDefaults: {
      http: 'preview.example.com',
      altHttp: ['preview-alt.example.com'],
      grpc: 'grpc.example.com',
      altGrpc: ['grpc-alt.example.com'],
    },
    deletePendingHelmReleaseStep: {
      delete: true,
      static_delete: true,
    },
  };
}

function installConfigs(configs: Record<string, unknown> = makeConfigs()) {
  const getAllConfigs = jest.fn().mockResolvedValue(configs);
  const getOrgChartName = jest.fn().mockResolvedValue('lifecycle-app');
  (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({ getAllConfigs, getOrgChartName });
  return { getAllConfigs, getOrgChartName };
}

function makePublicDeploy() {
  return {
    uuid: 'Preview-ABC',
    branchName: 'feature/helm-preview',
    sha: 'commit-123',
    dockerImage: 'registry.example.com/service:lfc-main-v1',
    deployable: {
      buildUUID: 'build-123',
      port: 8080,
      helm: {
        chart: {
          name: 'public-chart',
          repoUrl: 'https://charts.example.com',
          version: '2.3.4',
          values: ['replicas=2', 'feature.enabled=true'],
          valueFiles: [],
        },
        version: '3.14.0',
        args: '--wait --timeout 5m',
        action: 'upgrade',
      },
    },
    build: {
      namespace: 'env-build-123',
      isStatic: false,
      commentRuntimeEnv: {},
    },
    repository: {
      fullName: 'goodrx/service',
    },
    $fetchGraph: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function makeOrgDeploy() {
  return {
    uuid: 'org-app-abc',
    dockerImage: 'registry.example.com/service:lfc-main-v1',
    env: {
      APP_MODE: 'preview',
    },
    deployable: {
      name: 'service',
      buildUUID: 'build-123',
      port: 8080,
      helm: {
        chart: {
          name: 'lifecycle-app',
          repoUrl: 'https://charts.example.com',
          version: '4.5.6',
          values: ['deployment.replicaCount=2'],
          valueFiles: [],
        },
        docker: {
          app: {},
        },
        version: '3.14.0',
        args: '--atomic',
        action: 'upgrade',
        disableIngressHost: false,
      },
    },
    build: {
      namespace: 'env-build-123',
      isStatic: false,
      commentRuntimeEnv: {},
    },
    $fetchGraph: jest.fn().mockResolvedValue(undefined),
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockRenderTemplate.mockImplementation(async (_build, values) => values || []);
  mockKubeContextStep.mockImplementation(async ({ context, cluster }) => ({
    title: 'Set kube context',
    stage: 'Original',
    arguments: { context, cluster },
  }));
  mockGenerateCheckoutStep.mockImplementation((revision, repositoryName, gitOrg) => ({
    title: 'Checkout',
    stage: 'Checkout',
    revision,
    repo: repositoryName,
    git: gitOrg,
  }));
  mockDeletePendingHelmReleaseStep.mockReturnValue({ title: 'Delete pending release', stage: 'Cleanup' });
  mockWaitForInProgressDeploys.mockReturnValue({ title: 'Wait for pending deploys', stage: 'Wait' });
  installConfigs();
});

describe('public chart deployment step', () => {
  test('merges configured and rendered values while preserving the public chart contract', async () => {
    const deploy = makePublicDeploy();

    const result = await helmPublicDeployStep(deploy);

    expect(deploy.$fetchGraph).toHaveBeenCalledWith('build');
    expect(mockRenderTemplate).toHaveBeenCalledWith(deploy.build, deploy.deployable.helm.chart.values);
    expect(result).toEqual({
      stage: 'Deploy',
      type: 'helm/codefresh:1.0.0',
      working_directory: '${{Checkout}}',
      arguments: {
        chart_name: 'public-chart',
        chart_repo_url: 'https://charts.example.com',
        chart_version: '2.3.4',
        release_name: 'preview-abc',
        helm_version: '3.14.0',
        kube_context: 'Preview-ABC-test-cluster',
        namespace: 'env-build-123',
        cmd_ps: '--wait --timeout 5m',
        action: 'upgrade',
        custom_values: [
          'fullnameOverride=Preview-ABC',
          'commonLabels.name=build-123',
          'commonLabels.lc__uuid=build-123',
          'preview.goodrx.com.name=build-123',
          'preview.goodrx.com.lc__uuid=build-123',
          'replicas=2',
          'global.enabled=true',
          'feature.enabled=true',
        ],
        custom_value_files: [],
      },
    });
  });

  test('adds configured static scheduling values and honors a chart-specific step type', async () => {
    const configs = makeConfigs();
    const { label: _label, ...publicChartWithoutLabel } = configs['public-chart'];
    installConfigs({ ...configs, 'public-chart': publicChartWithoutLabel });
    const deploy = makePublicDeploy();
    deploy.build.isStatic = true;
    deploy.deployable.helm.cfStepType = 'org/custom-helm:2.0.0';
    deploy.deployable.helm.chart.valueFiles = ['helm/static-values.yaml'];

    const result = await helmPublicDeployStep(deploy);
    const args = result.arguments;
    if (
      !args ||
      typeof args !== 'object' ||
      !('custom_values' in args) ||
      !Array.isArray(args.custom_values) ||
      !('custom_value_files' in args) ||
      !Array.isArray(args.custom_value_files)
    ) {
      throw new Error('Expected Helm step arguments with custom value arrays');
    }
    const customValues = args.custom_values;

    expect(result.type).toBe('org/custom-helm:2.0.0');
    expect(args.custom_value_files).toEqual(['helm/static-values.yaml']);
    expect(customValues).toEqual(
      expect.arrayContaining([
        'pod.tolerations[0].key=static_env',
        'pod.tolerations[0].operator=Equal',
        'pod.tolerations[0].value=yes',
        'pod.tolerations[0].effect=NoSchedule',
        'pod.nodeSelector.app-long=lifecycle-static-env',
      ])
    );
    expect(customValues.some((value) => value.startsWith('preview.goodrx.com.'))).toBe(false);
  });

  test('rejects secret references before returning a Codefresh public-chart step', async () => {
    const deploy = makePublicDeploy();
    deploy.deployable.helm.chart.values = ['password={{aws:service/database:PASSWORD}}'];

    await expect(helmPublicDeployStep(deploy)).rejects.toThrow(
      'Codefresh Helm deploy path does not support helm.chart.values secret refs'
    );
  });

  test('keeps a static public chart usable when no optional chart policy is configured', async () => {
    const configs = makeConfigs();
    const { 'public-chart': _publicChart, ...configsWithoutPublicChart } = configs;
    installConfigs(configsWithoutPublicChart);
    const deploy = makePublicDeploy();
    deploy.build.isStatic = true;
    delete deploy.deployable.helm.chart.valueFiles;

    const result = await helmPublicDeployStep(deploy);
    const args = result.arguments;
    if (
      !args ||
      typeof args !== 'object' ||
      !('custom_values' in args) ||
      !Array.isArray(args.custom_values) ||
      !('custom_value_files' in args) ||
      !Array.isArray(args.custom_value_files)
    ) {
      throw new Error('Expected Helm step arguments with custom value arrays');
    }

    expect(args.custom_values).toEqual([
      'fullnameOverride=Preview-ABC',
      'commonLabels.name=build-123',
      'commonLabels.lc__uuid=build-123',
      'replicas=2',
      'feature.enabled=true',
    ]);
    expect(args.custom_value_files).toEqual([]);
  });
});

describe('organization chart deployment step', () => {
  test('treats a nullable build environment override as empty for app and init environments', async () => {
    const deploy = makeOrgDeploy();
    deploy.build.commentRuntimeEnv = null;

    const result = await helmOrgAppDeployStep(deploy);
    const customValues = result.arguments.custom_values as string[];

    expect(customValues.filter((value) => value.startsWith('deployment.env.'))).toEqual([
      'deployment.env.APP__MODE="preview"',
    ]);
    expect(customValues.filter((value) => value.startsWith('deployment.initEnv.'))).toEqual([]);
  });

  test('uses deploy-local chart values when the org chart has no configured default values', async () => {
    const { 'lifecycle-app': _orgChart, ...configsWithoutOrgChartDefaults } = makeConfigs();
    installConfigs({ ...configsWithoutOrgChartDefaults, 'lifecycle-app': {} });
    const deploy = makeOrgDeploy();

    const result = await helmOrgAppDeployStep(deploy);
    const customValues = result.arguments.custom_values as string[];

    expect(customValues.filter((value) => value.includes('replicaCount') || value.includes('defaultValue'))).toEqual([
      'deployment.replicaCount=2',
    ]);
    expect(mockRenderTemplate).toHaveBeenCalledWith(deploy.build, deploy.deployable.helm.chart.values);
  });

  test('adds static scheduling, gRPC mappings, alternate HTTP hosts, and the default allowlist', async () => {
    const deploy = makeOrgDeploy();
    deploy.build.isStatic = true;
    deploy.deployable.helm.grpc = true;

    const result = await helmOrgAppDeployStep(deploy);
    const customValues = result.arguments.custom_values as string[];

    expect(customValues).toEqual(
      expect.arrayContaining([
        'deployment.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key=eks.amazonaws.com/capacityType',
        'deployment.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator=In',
        'deployment.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values[0]=ON_DEMAND',
        'deployment.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[1].key=app-long',
        'deployment.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[1].operator=In',
        'deployment.customNodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[1].values[0]=lifecycle-static-env',
        'deployment.tolerations[0].key=static_env',
        'deployment.tolerations[0].effect=NoSchedule',
        'deployment.disableInit=true',
        'ambassadorMappings[0].host=org-app-abc.grpc.example.com:443',
        'ambassadorMappings[1].host=org-app-abc.grpc-alt.example.com:443',
        'ingress.host=org-app-abc.preview.example.com',
        'ingress.altHosts[0]=org-app-abc.preview-alt.example.com',
        'ingress.ipAllowlist[0]=10.0.0.0/8',
        'ingress.ipAllowlist[1]=192.168.0.0/16',
      ])
    );
  });

  test('omits the default allowlist when the deployable explicitly overrides it', async () => {
    const deploy = makeOrgDeploy();
    deploy.deployable.helm.overrideDefaultIpWhitelist = true;

    const result = await helmOrgAppDeployStep(deploy);
    const customValues = result.arguments.custom_values as string[];

    expect(customValues).toContain('ingress.host=org-app-abc.preview.example.com');
    expect(customValues).toContain('ingress.altHosts[0]=org-app-abc.preview-alt.example.com');
    expect(customValues.some((value) => value.startsWith('ingress.ipAllowlist['))).toBe(false);
  });

  test('uses the configured resource type and does not attach deployment ingress to a job', async () => {
    const deploy = makeOrgDeploy();
    deploy.deployable.helm.type = 'Job';

    const result = await helmOrgAppDeployStep(deploy);
    const customValues = result.arguments.custom_values as string[];

    expect(customValues).toContain('job.appImage=registry.example.com/service:lfc-main-v1');
    expect(customValues).toContain('job.disableInit=true');
    expect(customValues).toContain('job.env.APP__MODE="preview"');
    expect(customValues.some((value) => value.startsWith('ingress.'))).toBe(false);
  });
});

describe('Helm deployment routing', () => {
  test('routes only org charts with docker configuration through the org-chart contract', async () => {
    const publicDeploy = makePublicDeploy();
    const orgDeploy = makeOrgDeploy();

    const publicStep = await helmDeployStep(publicDeploy);
    const orgStep = await helmDeployStep(orgDeploy);

    expect(publicStep.arguments.custom_values).toContain('commonLabels.name=build-123');
    expect(publicStep.arguments.custom_values).not.toContain('env=lifecycle-build-123');
    expect(orgStep.arguments.custom_values).toContain('env=lifecycle-build-123');
    expect(orgStep.arguments.custom_values).not.toContain('commonLabels.name=build-123');
  });

  test('delegates native Helm deployment with both default and caller-supplied options', async () => {
    const deploys = [makePublicDeploy()];
    const defaultResult = { releaseNames: ['preview-abc'] };
    const gatedResult = { releaseNames: ['preview-def'] };
    const secretMutationGate = jest.fn();
    mockNativeDeployHelm.mockResolvedValueOnce(defaultResult).mockResolvedValueOnce(gatedResult);

    await expect(deployHelm(deploys)).resolves.toBe(defaultResult);
    await expect(deployHelm(deploys, { secretMutationGate } as any)).resolves.toBe(gatedResult);

    expect(mockNativeDeployHelm).toHaveBeenNthCalledWith(1, deploys, {});
    expect(mockNativeDeployHelm).toHaveBeenNthCalledWith(2, deploys, { secretMutationGate });
  });
});

describe('Codefresh Helm YAML generation', () => {
  test('generates a no-checkout pipeline with wait, context, annotations, and pending-release cleanup', async () => {
    const deploy = makePublicDeploy();

    const result = (await generateHelmCodefreshYamlNoCheckout(deploy)) as any;

    expect(mockKubeContextStep).toHaveBeenCalledWith({ context: 'Preview-ABC', cluster: 'test-cluster' });
    expect(mockWaitForInProgressDeploys).toHaveBeenCalledWith({
      deployUUID: 'Preview-ABC',
      pipelineId: 'goodrx/helm-deploy',
    });
    expect(mockDeletePendingHelmReleaseStep).toHaveBeenCalledWith({
      deploy,
      namespace: 'env-build-123',
    });
    expect(result.hooks.on_elected.annotations.set).toEqual([
      {
        annotations: [{ uuid: 'build-123' }, { deployUUID: 'Preview-ABC' }, { eksCluster: 'test-cluster' }],
        display: 'deployUUID',
      },
    ]);
    expect(result.steps.kubeContext.stage).toBe('Checkout');
    expect(result.steps.uninstall).toEqual({ title: 'Delete pending release', stage: 'Cleanup' });
    expect(result.steps.deploy).not.toHaveProperty('working_directory');
  });

  test('uses the static cleanup switch and omits cleanup when that switch is disabled', async () => {
    const configs = makeConfigs();
    configs.deletePendingHelmReleaseStep.static_delete = false;
    installConfigs(configs);
    const deploy = makePublicDeploy();
    deploy.build.isStatic = true;

    const result = (await generateHelmCodefreshYamlNoCheckout(deploy)) as any;

    expect(result.steps).not.toHaveProperty('uninstall');
    expect(mockDeletePendingHelmReleaseStep).not.toHaveBeenCalled();
  });

  test('generates checkout and kube-context steps in parallel and strips checkout stage nesting', async () => {
    const configs = makeConfigs();
    configs.app_setup.org = '   ';
    installConfigs(configs);
    const deploy = makePublicDeploy();
    deploy.build.isStatic = true;
    deploy.deployable.helm.chart.valueFiles = ['helm/preview.yaml'];

    const result = (await generateHelmCodefreshYamlWithCheckout(deploy)) as any;

    expect(deploy.$fetchGraph).toHaveBeenNthCalledWith(1, 'repository');
    expect(mockGenerateCheckoutStep).toHaveBeenCalledWith('commit-123', 'goodrx/service', 'REPLACE_ME_ORG');
    expect(result.steps.clone).toMatchObject({
      type: 'parallel',
      stage: 'Checkout',
      steps: {
        Checkout: {
          title: 'Checkout',
          revision: 'commit-123',
          repo: 'goodrx/service',
          git: 'REPLACE_ME_ORG',
        },
        kubeContext: {
          title: 'Set kube context',
        },
      },
    });
    expect(result.steps.clone.steps.Checkout).not.toHaveProperty('stage');
    expect(result.steps.uninstall).toEqual({ title: 'Delete pending release', stage: 'Cleanup' });
  });

  test('omits checkout-pipeline cleanup when the non-static cleanup switch is disabled', async () => {
    const configs = makeConfigs();
    configs.deletePendingHelmReleaseStep.delete = false;
    installConfigs(configs);
    const deploy = makePublicDeploy();
    deploy.deployable.helm.chart.valueFiles = ['helm/preview.yaml'];

    const result = (await generateHelmCodefreshYamlWithCheckout(deploy)) as any;

    expect(result.steps).not.toHaveProperty('uninstall');
    expect(mockDeletePendingHelmReleaseStep).not.toHaveBeenCalled();
  });

  test.each([
    { pipeline: 'no-checkout', isStatic: false },
    { pipeline: 'no-checkout', isStatic: true },
    { pipeline: 'checkout', isStatic: false },
    { pipeline: 'checkout', isStatic: true },
  ])('omits $pipeline cleanup for isStatic=$isStatic when cleanup policy is absent', async ({ pipeline, isStatic }) => {
    const { deletePendingHelmReleaseStep: _cleanupPolicy, ...configsWithoutCleanupPolicy } = makeConfigs();
    installConfigs(configsWithoutCleanupPolicy);
    const deploy = makePublicDeploy();
    deploy.build.isStatic = isStatic;
    if (pipeline === 'checkout') {
      deploy.deployable.helm.chart.valueFiles = ['helm/preview.yaml'];
    }

    const result =
      pipeline === 'checkout'
        ? ((await generateHelmCodefreshYamlWithCheckout(deploy)) as any)
        : ((await generateHelmCodefreshYamlNoCheckout(deploy)) as any);

    expect(result.steps).not.toHaveProperty('uninstall');
    expect(mockDeletePendingHelmReleaseStep).not.toHaveBeenCalled();
  });

  test.each([{ pipeline: 'no-checkout' }, { pipeline: 'checkout' }])(
    'uses an unknown cluster annotation for a $pipeline pipeline when the configured cluster is blank',
    async ({ pipeline }) => {
      const configs = makeConfigs();
      configs.lifecycleDefaults.deployCluster = '';
      installConfigs(configs);
      const deploy = makePublicDeploy();
      if (pipeline === 'checkout') {
        deploy.deployable.helm.chart.valueFiles = ['helm/preview.yaml'];
      }

      const result =
        pipeline === 'checkout'
          ? ((await generateHelmCodefreshYamlWithCheckout(deploy)) as any)
          : ((await generateHelmCodefreshYamlNoCheckout(deploy)) as any);

      expect(result.hooks.on_elected.annotations.set).toEqual([
        {
          annotations: [{ uuid: 'build-123' }, { deployUUID: 'Preview-ABC' }, { eksCluster: 'unknown' }],
          display: 'deployUUID',
        },
      ]);
      expect(mockKubeContextStep).toHaveBeenCalledWith({ context: 'Preview-ABC', cluster: '' });
    }
  );

  test('uses the checkout organization fallback when app setup configuration is absent', async () => {
    const { app_setup: _appSetup, ...configsWithoutAppSetup } = makeConfigs();
    installConfigs(configsWithoutAppSetup);
    const deploy = makePublicDeploy();
    deploy.deployable.helm.chart.valueFiles = ['helm/preview.yaml'];

    const result = (await generateHelmCodefreshYamlWithCheckout(deploy)) as any;

    expect(mockGenerateCheckoutStep).toHaveBeenCalledWith('commit-123', 'goodrx/service', 'REPLACE_ME_ORG');
    expect(result.steps.clone.steps.Checkout.git).toBe('REPLACE_ME_ORG');
  });

  test('writes checkout YAML before returning the quoted Codefresh command', async () => {
    const deploy = makePublicDeploy();
    deploy.deployable.helm.chart.valueFiles = ['helm/preview.yaml'];

    const command = await generateCodefreshRunCommand(deploy);

    expect(deploy.$fetchGraph).toHaveBeenCalledWith('build');
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/lifecycle/codefresh', { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/tmp/lifecycle/codefresh/helm-deploy-Preview-ABC.yaml',
      expect.any(String),
      'utf8'
    );
    const writtenYaml = yaml.load(mockWriteFile.mock.calls[0][1] as string) as any;
    expect(writtenYaml.steps.clone.type).toBe('parallel');
    expect(writtenYaml.steps.deploy.arguments.custom_value_files).toEqual(['helm/preview.yaml']);
    expect(command).toBe(
      'codefresh run goodrx/helm-deploy -b "feature/helm-preview" -y /tmp/lifecycle/codefresh/helm-deploy-Preview-ABC.yaml -v ENV=lfc -d'
    );
  });

  test('logs and preserves a YAML write failure without constructing a command', async () => {
    const failure = new Error('temporary volume is read-only');
    mockWriteFile.mockRejectedValueOnce(failure);
    const deploy = makePublicDeploy();

    await expect(generateCodefreshRunCommand(deploy)).rejects.toBe(failure);

    expect(mockMkdir).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalled();
    expect(mockGetLogger).toHaveBeenCalledWith({ error: failure });
    expect(mockLoggerError).toHaveBeenCalledWith('Codefresh: config write failed');
  });
});

describe('image metadata and teardown', () => {
  test('constructs stable image versions and preserves images without tags', () => {
    expect(constructImageVersion()).toBe('');
    expect(constructImageVersion('registry.example.com/service')).toBe('registry.example.com/service');
    expect(constructImageVersion('registry.example.com/service:lfc-main-v1')).toBe('abcd-v1');
    expect(mockRandomAlphanumeric).toHaveBeenCalledWith(4);
  });

  test('uninstalls only active, non-queued Helm releases and records successful cleanup', async () => {
    const successfulPatch = jest.fn().mockResolvedValue(undefined);
    const skippedPatch = jest.fn().mockResolvedValue(undefined);
    const activeDeploy = {
      uuid: 'active-release',
      active: true,
      status: 'deployed',
      deployable: { helm: { chart: { name: 'public-chart' } } },
      $query: jest.fn(() => ({ patch: successfulPatch })),
    };
    const inactiveDeploy = {
      uuid: 'inactive-release',
      active: false,
      status: 'deployed',
      deployable: { helm: { chart: { name: 'public-chart' } } },
      $query: jest.fn(() => ({ patch: skippedPatch })),
    };
    const queuedDeploy = {
      uuid: 'queued-release',
      active: true,
      status: 'queued',
      deployable: { helm: { chart: { name: 'public-chart' } } },
      $query: jest.fn(() => ({ patch: skippedPatch })),
    };
    const nonHelmDeploy = {
      uuid: 'not-a-helm-release',
      active: true,
      status: 'deployed',
      deployable: { helm: {} },
      $query: jest.fn(() => ({ patch: skippedPatch })),
    };
    const withGraphFetched = jest.fn().mockResolvedValue([activeDeploy, inactiveDeploy, queuedDeploy, nonHelmDeploy]);
    mockDeployQuery.mockReturnValue({ where: jest.fn(() => ({ withGraphFetched })) });
    mockShellPromise.mockResolvedValue('release "active-release" uninstalled');

    await uninstallHelmReleases({ id: 42, namespace: 'env-build-123' } as any);

    expect(mockShellPromise).toHaveBeenCalledTimes(1);
    expect(mockShellPromise).toHaveBeenCalledWith('helm uninstall active-release --namespace env-build-123');
    expect(successfulPatch).toHaveBeenCalledWith({ statusMessage: 'Uninstalled via Helm' });
    expect(skippedPatch).not.toHaveBeenCalled();
    expect(mockLoggerDebug).toHaveBeenCalledWith('Helm: releases uninstalled');
  });

  test('preserves shellPromise string failures in the status and rejection contract', async () => {
    const shellFailure = 'shellPromise command failed: cluster credentials expired';
    const patch = jest.fn().mockResolvedValue(undefined);
    const deploy = {
      uuid: 'active-release',
      active: true,
      status: 'deployed',
      deployable: { helm: { chart: { name: 'public-chart' } } },
      $query: jest.fn(() => ({ patch })),
    };
    const withGraphFetched = jest.fn().mockResolvedValue([deploy]);
    mockDeployQuery.mockReturnValue({ where: jest.fn(() => ({ withGraphFetched })) });
    mockShellPromise.mockRejectedValueOnce(shellFailure);

    await expect(uninstallHelmReleases({ id: 42, namespace: 'env-build-123' } as any)).rejects.toBe(shellFailure);

    expect(patch).toHaveBeenCalledWith({ statusMessage: `Failed to uninstall via Helm\n${shellFailure}` });
    expect(mockGetLogger).toHaveBeenCalledWith({ error: shellFailure });
  });

  test('returns the documented metadata error when a nullable build source has neither PR nor branch', async () => {
    const deploy = {
      build: {
        uuid: 'orphaned-build',
        pullRequest: null,
        pullRequestId: null,
        branchName: null,
        githubRepositoryId: null,
        configSha: null,
      },
      $fetchGraph: jest.fn(),
    };

    await expect(constructHelmDeploysBuildMetaData([deploy] as any)).resolves.toEqual({
      uuid: '',
      branchName: '',
      fullName: '',
      sha: '',
      error: 'no_related_build_found',
    });
    expect(deploy.$fetchGraph).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'Helm: metadata construction failed'
    );
  });

  test('returns the documented metadata error when a Helm query has no deploy records', async () => {
    await expect(constructHelmDeploysBuildMetaData([])).resolves.toEqual({
      uuid: '',
      branchName: '',
      fullName: '',
      sha: '',
      error: 'no_related_build_found',
    });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'Helm: metadata construction failed'
    );
  });

  test('normalizes non-Error metadata failures into the documented fallback error', async () => {
    const deploy = {
      build: undefined,
      $fetchGraph: jest.fn().mockRejectedValue('database unavailable'),
    };

    await expect(constructHelmDeploysBuildMetaData([deploy] as any)).resolves.toEqual({
      uuid: '',
      branchName: '',
      fullName: '',
      sha: '',
      error: 'unknown_related_build_error',
    });
    expect(mockLoggerError).toHaveBeenCalledWith(
      { error: 'database unavailable' },
      'Helm: metadata construction failed'
    );
  });
});
