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

import type Deploy from 'server/models/Deploy';

const mockInfo = jest.fn();
const mockDebug = jest.fn();
const mockWarn = jest.fn();
const mockWithSpan = jest.fn();
const mockWithLogContext = jest.fn();
const mockMkdir = jest.fn();
const mockWriteFile = jest.fn();
const mockShellPromise = jest.fn();
const mockNanoid = jest.fn();
const mockMetricsConstructor = jest.fn();
const mockMetricIncrement = jest.fn();
const mockMetricEvent = jest.fn();
const mockPatchIngress = jest.fn();
const mockIngressBannerSnippet = jest.fn();
const mockConstructBuildMetadata = jest.fn();
const mockGenerateCodefreshRunCommand = jest.fn();
const mockGetPipelineId = jest.fn();
const mockCheckPipelineStatus = jest.fn();
const mockWaitForPipeline = jest.fn();
const mockGetAllConfigs = jest.fn();
const mockPatchActivity = jest.fn();
const mockRecordFailure = jest.fn();
const mockDeployServiceConstructor = jest.fn();
const mockGenerateInstallScript = jest.fn();
const mockDetermineChartType = jest.fn();
const mockGetHelmConfiguration = jest.fn();
const mockMergeHelmConfig = jest.fn();
const mockValidateHelmConfiguration = jest.fn();
const mockDetectRegistryAuth = jest.fn();
const mockRandomAlphanumeric = jest.fn();
const mockBuildJobName = jest.fn();
const mockGetGitHubToken = jest.fn();
const mockCreateCloneScript = jest.fn();
const mockWaitForJob = jest.fn();
const mockCreateHelmJob = jest.fn();
const mockEnsureServiceAccount = jest.fn();
const mockArchiveLogs = jest.fn();
const mockGetLogArchivalService = jest.fn();
const mockParseSecretRefs = jest.fn();
const mockProcessSecretRefs = jest.fn();
const mockWaitForSecretSync = jest.fn();
const mockSecretProcessorConstructor = jest.fn();
const mockBuildSecretVolumes = jest.fn();
const mockBuildSecretVolumeMounts = jest.fn();

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: mockInfo, debug: mockDebug, warn: mockWarn }),
  withSpan: (...args: unknown[]) => mockWithSpan(...args),
  withLogContext: (...args: unknown[]) => mockWithLogContext(...args),
}));

jest.mock('fs', () => ({
  __esModule: true,
  default: {
    promises: {
      mkdir: (...args: unknown[]) => mockMkdir(...args),
      writeFile: (...args: unknown[]) => mockWriteFile(...args),
    },
  },
}));

jest.mock('server/lib/shell', () => ({
  shellPromise: (...args: unknown[]) => mockShellPromise(...args),
}));

jest.mock('nanoid', () => ({ nanoid: () => mockNanoid() }));

jest.mock('server/lib/metrics', () => ({
  Metrics: function (...args: unknown[]) {
    return mockMetricsConstructor(...args);
  },
}));

jest.mock('server/lib/kubernetes', () => ({
  patchIngress: (...args: unknown[]) => mockPatchIngress(...args),
}));

jest.mock('server/lib/helm/utils', () => ({
  ingressBannerSnippet: (...args: unknown[]) => mockIngressBannerSnippet(...args),
}));

jest.mock('server/lib/helm/helm', () => ({
  constructHelmDeploysBuildMetaData: (...args: unknown[]) => mockConstructBuildMetadata(...args),
  generateCodefreshRunCommand: (...args: unknown[]) => mockGenerateCodefreshRunCommand(...args),
}));

jest.mock('server/lib/codefresh/utils', () => ({
  getCodefreshPipelineIdFromOutput: (...args: unknown[]) => mockGetPipelineId(...args),
}));

jest.mock('server/lib/codefresh', () => ({
  checkPipelineStatus: (...args: unknown[]) => mockCheckPipelineStatus(...args),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({ getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args) }),
  },
}));

jest.mock('server/services/deploy', () => ({
  __esModule: true,
  default: function (...args: unknown[]) {
    return mockDeployServiceConstructor(...args);
  },
}));

jest.mock('../utils', () => {
  const actual = jest.requireActual('../utils');
  return {
    ...actual,
    generateHelmInstallScript: (...args: unknown[]) => mockGenerateInstallScript(...args),
    determineChartType: (...args: unknown[]) => mockDetermineChartType(...args),
    getHelmConfiguration: (...args: unknown[]) => mockGetHelmConfiguration(...args),
    mergeHelmConfigWithGlobal: (...args: unknown[]) => mockMergeHelmConfig(...args),
    validateHelmConfiguration: (...args: unknown[]) => mockValidateHelmConfiguration(...args),
  };
});

jest.mock('../registryAuth', () => ({
  detectRegistryAuth: (...args: unknown[]) => mockDetectRegistryAuth(...args),
}));

jest.mock('server/lib/random', () => ({
  randomAlphanumeric: (...args: unknown[]) => mockRandomAlphanumeric(...args),
}));

jest.mock('server/lib/kubernetes/jobNames', () => ({
  buildDeployJobName: (...args: unknown[]) => mockBuildJobName(...args),
}));

jest.mock('server/lib/nativeBuild/utils', () => ({
  createCloneScript: (...args: unknown[]) => mockCreateCloneScript(...args),
  waitForJobAndGetLogs: (...args: unknown[]) => mockWaitForJob(...args),
  getGitHubToken: (...args: unknown[]) => mockGetGitHubToken(...args),
  GIT_USERNAME: 'git-user',
  MANIFEST_PATH: '/tmp/lifecycle-manifests',
}));

jest.mock('server/lib/kubernetes/jobFactory', () => ({
  createHelmJob: (...args: unknown[]) => mockCreateHelmJob(...args),
}));

jest.mock('server/lib/kubernetes/common/serviceAccount', () => ({
  ensureServiceAccountForJob: (...args: unknown[]) => mockEnsureServiceAccount(...args),
}));

jest.mock('server/services/logArchival', () => ({
  getLogArchivalService: (...args: unknown[]) => mockGetLogArchivalService(...args),
}));

jest.mock('server/lib/secretRefs', () => ({
  parseSecretRefsFromEnv: (...args: unknown[]) => mockParseSecretRefs(...args),
}));

jest.mock('server/services/secretProcessor', () => ({
  SecretProcessor: function (...args: unknown[]) {
    return mockSecretProcessorConstructor(...args);
  },
}));

jest.mock('server/lib/helm/secretValueRefs', () => ({
  buildHelmSecretVolumes: (...args: unknown[]) => mockBuildSecretVolumes(...args),
  buildHelmSecretVolumeMounts: (...args: unknown[]) => mockBuildSecretVolumeMounts(...args),
}));

import { DeploymentSupersededError } from 'server/lib/deploymentReconciliation/errors';
import { DeployStatus } from 'shared/constants';
import { ChartType } from '../utils';
import {
  createWaitForPriorDeploysInitContainer,
  deployHelm,
  deployNativeHelm,
  generateHelmManifest,
  nativeHelmDeploy,
  shouldUseNativeHelm,
  trackHelmDeploymentMetrics,
} from '../helm';

type DeployFixture = {
  deploy: Deploy;
  patch: jest.Mock;
  where: jest.Mock;
};

function createDeploy(overrides: Record<string, unknown> = {}): DeployFixture {
  const where = jest.fn().mockResolvedValue(1);
  const outputPatch = Object.assign(Promise.resolve(1), { where });
  const patch = jest.fn(() => outputPatch);
  const deploy = {
    uuid: 'deploy-uuid',
    sha: 'abcdef1234567890',
    branchName: 'main',
    id: 42,
    runUUID: 'run-1',
    deployableId: 9,
    env: {},
    initEnv: {},
    deployable: {
      name: 'sample-service',
      helm: { deploymentMethod: 'native' },
      repository: { fullName: 'example/repository' },
    },
    build: {
      uuid: 'build-uuid',
      namespace: 'preview-ns',
      isStatic: false,
      pullRequest: { repository: { fullName: 'example/repository' } },
    },
    $fetchGraph: jest.fn().mockResolvedValue(undefined),
    $query: jest.fn(() => ({ patch })),
    ...overrides,
  } as unknown as Deploy;
  return { deploy, patch, where };
}

const BASE_HELM_CONFIG = {
  chartType: ChartType.PUBLIC,
  chartPath: 'charts/sample',
  releaseName: 'sample-release',
  helmVersion: '3.15.0',
  customValues: [],
  valuesFiles: [],
  helmSecretRefs: [],
  secretSetFiles: [],
};

describe('native Helm orchestration behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWithSpan.mockImplementation(async (_name: string, action: () => Promise<unknown>) => action());
    mockWithLogContext.mockImplementation(async (_context: unknown, action: () => Promise<unknown>) => action());
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockShellPromise.mockResolvedValue('');
    mockNanoid.mockReturnValue('generated-run');
    mockMetricsConstructor.mockReturnValue({ increment: mockMetricIncrement, event: mockMetricEvent });
    mockPatchIngress.mockResolvedValue(undefined);
    mockIngressBannerSnippet.mockReturnValue('banner-snippet');
    mockConstructBuildMetadata.mockResolvedValue({
      uuid: 'build-uuid',
      fullName: 'example/repository',
      branchName: 'main',
    });
    mockGenerateCodefreshRunCommand.mockResolvedValue('codefresh run pipeline');
    mockGetPipelineId.mockReturnValue('pipeline-1');
    mockCheckPipelineStatus.mockReturnValue(mockWaitForPipeline);
    mockWaitForPipeline.mockResolvedValue(undefined);
    mockGetAllConfigs.mockResolvedValue({});
    mockPatchActivity.mockResolvedValue(undefined);
    mockRecordFailure.mockResolvedValue(false);
    mockDeployServiceConstructor.mockReturnValue({
      patchAndUpdateActivityFeed: mockPatchActivity,
      recordDeployFailure: mockRecordFailure,
    });
    mockGenerateInstallScript.mockReturnValue('helm upgrade --install');
    mockDetermineChartType.mockResolvedValue(ChartType.PUBLIC);
    mockGetHelmConfiguration.mockResolvedValue({ ...BASE_HELM_CONFIG });
    mockMergeHelmConfig.mockResolvedValue({ chart: {}, nativeHelm: {} });
    mockValidateHelmConfiguration.mockResolvedValue([]);
    mockDetectRegistryAuth.mockReturnValue(undefined);
    mockRandomAlphanumeric.mockReturnValue('ABCD');
    mockBuildJobName.mockReturnValue('helm-job');
    mockGetGitHubToken.mockResolvedValue('github-token');
    mockCreateCloneScript.mockReturnValue('git clone command');
    mockWaitForJob.mockResolvedValue({
      logs: 'helm logs',
      success: true,
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      duration: 60,
    });
    mockCreateHelmJob.mockImplementation((config) => ({ kind: 'Job', config }));
    mockEnsureServiceAccount.mockResolvedValue('deploy-sa');
    mockArchiveLogs.mockResolvedValue(undefined);
    mockGetLogArchivalService.mockReturnValue({ archiveLogs: mockArchiveLogs });
    mockParseSecretRefs.mockReturnValue([]);
    mockProcessSecretRefs.mockResolvedValue({
      expectedKeysPerSecret: {},
      syncTokensPerSecret: {},
    });
    mockWaitForSecretSync.mockResolvedValue(undefined);
    mockSecretProcessorConstructor.mockReturnValue({
      processSecretRefs: mockProcessSecretRefs,
      waitForSecretSync: mockWaitForSecretSync,
    });
    mockBuildSecretVolumes.mockReturnValue([]);
    mockBuildSecretVolumeMounts.mockReturnValue([]);
    jest.spyOn(global, 'setTimeout').mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') callback();
      return 0 as never;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds the prior-deploy wait container with ordering and timeout safeguards', () => {
    const container = createWaitForPriorDeploysInitContainer('preview-ns', 'sample-service', 'helm-job');

    expect(container).toMatchObject({
      name: 'wait-for-prior-deploys',
      command: ['/bin/bash', '-c'],
      resources: {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '512Mi' },
      },
    });
    expect(container.args[0]).toContain('kubectl get job helm-job -n preview-ns');
    expect(container.args[0]).toContain('service=sample-service,app.kubernetes.io/name=native-helm');
    expect(container.args[0]).toContain('Timed out after ${WAIT_TIMEOUT}s');
  });

  it('returns false without a deployable and rejects manifest generation before external calls', async () => {
    const { deploy } = createDeploy({ deployable: undefined });

    await expect(shouldUseNativeHelm(deploy)).resolves.toBe(false);
    await expect(shouldUseNativeHelm(createDeploy({ deployable: { name: 'sample-service' } }).deploy)).resolves.toBe(
      false
    );
    await expect(generateHelmManifest(deploy, 'helm-job', { namespace: 'preview-ns' })).rejects.toThrow(
      'Deployable missing for deploy deploy-uuid'
    );
    expect(mockEnsureServiceAccount).not.toHaveBeenCalled();
  });

  it('generates a public-chart manifest without cloning when no repository source is needed', async () => {
    const { deploy } = createDeploy({
      sha: undefined,
      branchName: undefined,
      id: undefined,
      deployable: { name: 'sample-service', helm: {}, repository: undefined },
    });
    mockGetHelmConfiguration.mockResolvedValueOnce({ ...BASE_HELM_CONFIG, secretSetFiles: undefined });
    mockMergeHelmConfig.mockResolvedValueOnce({});

    const manifest = await generateHelmManifest(deploy, 'helm-job', { namespace: 'preview-ns' });

    expect(manifest).toContain('kind: Job');
    expect(mockGetGitHubToken).not.toHaveBeenCalled();
    expect(mockCreateCloneScript).not.toHaveBeenCalled();
    expect(mockGenerateInstallScript).toHaveBeenCalledWith(
      'no-repo',
      expect.any(String),
      expect.any(String),
      'preview-ns',
      expect.any(Array),
      expect.any(Array),
      ChartType.PUBLIC,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      []
    );
    expect(mockCreateHelmJob).toHaveBeenCalledWith(
      expect.objectContaining({
        includeGitClone: false,
        gitToken: '',
        cloneScript: '',
        deployMetadata: { sha: '', branch: '', deployId: undefined, deployableId: '9' },
      })
    );
  });

  it('includes repository cloning for a public chart with repository value files', async () => {
    const { deploy } = createDeploy();
    mockGetHelmConfiguration.mockResolvedValueOnce({ ...BASE_HELM_CONFIG, valuesFiles: ['values/preview.yaml'] });
    mockMergeHelmConfig.mockResolvedValueOnce({
      chart: { repoUrl: 'oci://registry.example/charts', version: '2.0.0' },
      args: '--atomic',
      nativeHelm: { defaultArgs: '--wait', image: 'custom/helm:1', postRenderer: { command: '/render' } },
    });

    await generateHelmManifest(deploy, 'helm-job', { namespace: 'preview-ns' });

    expect(mockGetGitHubToken).toHaveBeenCalledTimes(1);
    expect(mockCreateCloneScript).toHaveBeenCalledWith('example/repository', 'main', 'abcdef1234567890');
    expect(mockCreateHelmJob).toHaveBeenCalledWith(
      expect.objectContaining({ includeGitClone: true, gitToken: 'github-token', cloneScript: 'git clone command' })
    );
    expect(mockGenerateInstallScript).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(Array),
      ['values/preview.yaml'],
      ChartType.PUBLIC,
      '--atomic',
      'oci://registry.example/charts',
      '--wait',
      '2.0.0',
      undefined,
      { command: '/render' },
      []
    );
  });

  it('deploys without secret processing and returns the failed-job fallback status', async () => {
    const { deploy, where } = createDeploy({ sha: undefined, id: null, runUUID: null });
    mockWaitForJob.mockResolvedValueOnce({ logs: 'helm failed', success: false, status: '' });

    await expect(nativeHelmDeploy(deploy, { namespace: 'preview-ns' })).resolves.toEqual({
      completed: false,
      logs: 'helm failed',
      status: 'failed',
    });

    expect(mockSecretProcessorConstructor).not.toHaveBeenCalled();
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/lifecycle-manifests/helm/', { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/tmp/lifecycle-manifests/helm/deploy-uuid-helm-no-sha',
      expect.stringContaining('kind: Job'),
      'utf8'
    );
    expect(mockShellPromise).toHaveBeenCalledWith(
      'kubectl apply -f /tmp/lifecycle-manifests/helm/deploy-uuid-helm-no-sha',
      { timeout: 90_000 }
    );
    expect(where).not.toHaveBeenCalled();
    expect(mockArchiveLogs).not.toHaveBeenCalled();
  });

  it('processes all secret sources without a gate and uses the longest provider timeout', async () => {
    const envRef = { provider: 'aws', path: 'app', key: 'env', envKey: 'ENV_SECRET' };
    const initRef = { provider: 'vault', path: 'app', key: 'init', envKey: 'INIT_SECRET' };
    const helmRef = { provider: 'aws', path: 'app', key: 'helm', envKey: 'HELM_SECRET' };
    const { deploy } = createDeploy({ env: { TOKEN: 'secret-ref' }, initEnv: { INIT: 'secret-ref' } });
    mockGetHelmConfiguration.mockResolvedValueOnce({ ...BASE_HELM_CONFIG, helmSecretRefs: [helmRef] });
    mockParseSecretRefs.mockReturnValueOnce([envRef]).mockReturnValueOnce([initRef]);
    mockGetAllConfigs.mockResolvedValue({
      secretProviders: {
        aws: { secretSyncTimeout: undefined },
        vault: { secretSyncTimeout: 12 },
      },
    });
    mockProcessSecretRefs.mockResolvedValueOnce({
      expectedKeysPerSecret: { 'runtime-secret': ['ENV_SECRET', 'INIT_SECRET', 'HELM_SECRET'] },
      syncTokensPerSecret: { 'runtime-secret': 'sync-token' },
    });

    await nativeHelmDeploy(deploy, { namespace: 'preview-ns' });

    expect(mockProcessSecretRefs).toHaveBeenCalledWith({
      secretRefs: [envRef, initRef, helmRef],
      serviceName: 'sample-service',
      namespace: 'preview-ns',
      buildUuid: 'deploy-uuid',
      strict: true,
    });
    expect(mockWaitForSecretSync).toHaveBeenCalledWith(
      { 'runtime-secret': ['ENV_SECRET', 'INIT_SECRET', 'HELM_SECRET'] },
      'preview-ns',
      12_000,
      { 'runtime-secret': 'sync-token' }
    );
  });

  it('continues without waiting when secret processing yields no Kubernetes secret keys', async () => {
    const helmRef = { provider: 'aws', path: 'app', key: 'helm', envKey: 'HELM_SECRET' };
    const { deploy } = createDeploy();
    mockGetHelmConfiguration.mockResolvedValueOnce({ ...BASE_HELM_CONFIG, helmSecretRefs: [helmRef] });

    await nativeHelmDeploy(deploy, { namespace: 'preview-ns' });

    expect(mockProcessSecretRefs).toHaveBeenCalledTimes(1);
    expect(mockWaitForSecretSync).not.toHaveBeenCalled();
    expect(mockShellPromise).toHaveBeenCalledWith(expect.stringContaining('kubectl apply -f '), { timeout: 90_000 });
  });

  it('does not write or apply a manifest when a secret mutation gate supersedes the deploy', async () => {
    const helmRef = { provider: 'aws', path: 'app', key: 'helm', envKey: 'HELM_SECRET' };
    const { deploy } = createDeploy();
    mockGetHelmConfiguration.mockResolvedValueOnce({ ...BASE_HELM_CONFIG, helmSecretRefs: [helmRef] });
    const secretMutationGate = jest.fn().mockResolvedValue({ admitted: false });

    await expect(nativeHelmDeploy(deploy, { namespace: 'preview-ns', secretMutationGate })).rejects.toBeInstanceOf(
      DeploymentSupersededError
    );

    expect(secretMutationGate).toHaveBeenCalledWith(deploy, expect.any(Function));
    expect(mockProcessSecretRefs).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockShellPromise).not.toHaveBeenCalled();
  });

  it('preserves deploy success when log archival fails and reports the warning', async () => {
    const archiveError = new Error('archive unavailable');
    const { deploy } = createDeploy({ sha: undefined });
    mockGetAllConfigs.mockResolvedValueOnce({}).mockResolvedValueOnce({ logArchival: { enabled: true } });
    mockArchiveLogs.mockRejectedValueOnce(archiveError);
    mockWaitForJob.mockResolvedValueOnce({
      logs: 'successful helm logs',
      success: true,
      status: undefined,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      duration: 60,
    });

    await expect(nativeHelmDeploy(deploy, { namespace: 'preview-ns' })).resolves.toEqual({
      completed: true,
      logs: 'successful helm logs',
      status: 'succeeded',
    });
    expect(mockArchiveLogs).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'Complete', sha: '', deployUuid: 'deploy-uuid' }),
      'successful helm logs'
    );
    expect(mockWarn).toHaveBeenCalledWith(
      { error: archiveError },
      'LogArchival: failed to archive deploy logs jobName=helm-job'
    );
  });

  it('archives an unsuccessful job with failed status', async () => {
    const { deploy } = createDeploy();
    mockGetAllConfigs.mockResolvedValueOnce({}).mockResolvedValueOnce({ logArchival: { enabled: true } });
    mockWaitForJob.mockResolvedValueOnce({
      logs: 'failed helm logs',
      success: false,
      status: 'failed',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      duration: 60,
    });

    await nativeHelmDeploy(deploy, { namespace: 'preview-ns' });

    expect(mockArchiveLogs).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'Failed', sha: 'abcdef1234567890' }),
      'failed helm logs'
    );
  });

  it('rejects invalid native Helm configuration before starting a job', async () => {
    const { deploy } = createDeploy();
    mockValidateHelmConfiguration.mockResolvedValueOnce(['chart is required', 'release is invalid']);

    await expect(deployNativeHelm(deploy)).rejects.toThrow(
      'Native helm configuration validation failed: chart is required, release is invalid'
    );
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockShellPromise).not.toHaveBeenCalled();
  });

  it.each([
    ['a generic job failure', 'upgrade failed', 'Deployment failed'],
    [
      'a Helm readiness timeout',
      'timed out waiting for the condition',
      'Deployment failed: Helm upgrade timed out. The deployed pods are not in a healthy state. Check Console > Pods for details',
    ],
  ])('reports %s with the public native deployment error', async (_case, logs, expectedMessage) => {
    const { deploy } = createDeploy();
    mockWaitForJob.mockResolvedValueOnce({ logs, success: false, status: 'failed' });

    await expect(deployNativeHelm(deploy)).rejects.toThrow(expectedMessage);
    expect(mockPatchIngress).not.toHaveBeenCalled();
  });

  it('patches env-lens ingress after native success and contains patch failures to a warning', async () => {
    const patchError = new Error('ingress unavailable');
    const { deploy } = createDeploy({
      deployable: {
        name: 'sample-service',
        helm: { deploymentMethod: 'native', envLens: true },
        repository: { fullName: 'example/repository' },
      },
    });
    mockPatchIngress.mockRejectedValueOnce(patchError);

    await expect(deployNativeHelm(deploy)).resolves.toBeUndefined();

    expect(mockIngressBannerSnippet).toHaveBeenCalledWith(deploy);
    expect(mockPatchIngress).toHaveBeenCalledWith('deploy-uuid', 'banner-snippet', 'preview-ns');
    expect(mockWarn).toHaveBeenCalledWith({ error: patchError }, 'Unable to patch ingress');
  });

  it('completes native deployment without ingress work when no service Helm block exists', async () => {
    const { deploy } = createDeploy({
      deployable: {
        name: 'sample-service',
        repository: { fullName: 'example/repository' },
      },
    });

    await expect(deployNativeHelm(deploy)).resolves.toBeUndefined();

    expect(mockPatchIngress).not.toHaveBeenCalled();
  });

  it('returns immediately for an empty deploy list without constructing a service', async () => {
    await expect(deployHelm([])).resolves.toBeUndefined();

    expect(mockDeployServiceConstructor).not.toHaveBeenCalled();
    expect(mockWithSpan).not.toHaveBeenCalled();
  });

  it('runs the Codefresh lifecycle, assigns a run id, and contains ingress patch failure', async () => {
    const patchError = new Error('ingress unavailable');
    const { deploy, patch } = createDeploy({
      runUUID: null,
      deployable: {
        name: 'sample-service',
        helm: { deploymentMethod: 'ci', envLens: true },
        repository: { fullName: 'example/repository' },
      },
    });
    mockPatchIngress.mockRejectedValueOnce(patchError);
    mockShellPromise.mockResolvedValueOnce('pipeline output');

    await expect(deployHelm([deploy])).resolves.toBeUndefined();

    expect(mockNanoid).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({ runUUID: 'generated-run' });
    expect(deploy.runUUID).toBe('generated-run');
    expect(mockGenerateCodefreshRunCommand).toHaveBeenCalledWith(deploy);
    expect(mockShellPromise).toHaveBeenCalledWith('codefresh run pipeline');
    expect(mockGetPipelineId).toHaveBeenCalledWith('pipeline output');
    expect(mockCheckPipelineStatus).toHaveBeenCalledWith('pipeline-1');
    expect(mockWaitForPipeline).toHaveBeenCalledTimes(1);
    expect(mockPatchActivity).toHaveBeenNthCalledWith(
      1,
      deploy,
      { status: DeployStatus.DEPLOYING, statusMessage: 'Deploying via Codefresh Helm' },
      'generated-run'
    );
    expect(mockPatchActivity).toHaveBeenNthCalledWith(
      2,
      deploy,
      { deployPipelineId: 'pipeline-1', statusMessage: 'Starting deployment via Helm' },
      'generated-run'
    );
    expect(mockPatchActivity).toHaveBeenNthCalledWith(
      3,
      deploy,
      { status: DeployStatus.READY, statusMessage: 'Successfully deployed via Codefresh Helm' },
      'generated-run'
    );
    expect(mockWarn).toHaveBeenCalledWith({ error: patchError }, 'Unable to patch ingress');
    expect(mockMetricIncrement).toHaveBeenCalledWith(
      'total',
      expect.objectContaining({ deployUUID: 'deploy-uuid', result: 'complete', method: 'native' })
    );
  });

  it('runs Codefresh without ingress work when no service Helm block exists', async () => {
    const { deploy } = createDeploy({
      deployable: {
        name: 'sample-service',
        repository: { fullName: 'example/repository' },
      },
    });

    await expect(deployHelm([deploy])).resolves.toBeUndefined();

    expect(mockGenerateCodefreshRunCommand).toHaveBeenCalledWith(deploy);
    expect(mockPatchIngress).not.toHaveBeenCalled();
  });

  it('records a normal deployment failure after tracking failure metrics', async () => {
    const deployError = new Error('codefresh unavailable');
    const { deploy } = createDeploy({
      deployable: {
        name: 'sample-service',
        helm: { deploymentMethod: 'ci' },
        repository: { fullName: 'example/repository' },
      },
    });
    mockGenerateCodefreshRunCommand.mockRejectedValueOnce(deployError);

    await expect(deployHelm([deploy])).rejects.toBe(deployError);

    expect(mockMetricIncrement).toHaveBeenCalledWith(
      'total',
      expect.objectContaining({ result: 'error', error: 'codefresh unavailable' })
    );
    expect(mockRecordFailure).toHaveBeenCalledWith(deploy, 'run-1', {
      status: DeployStatus.DEPLOY_FAILED,
      error: deployError,
      fallbackMessage: expect.stringContaining('Helm deployment failed for deploy-uuid'),
    });
    expect(mockPatchActivity).toHaveBeenCalledTimes(1);
  });

  it('records and rethrows a non-Error failure from the external deployment boundary', async () => {
    const { deploy } = createDeploy({
      deployable: {
        name: 'sample-service',
        helm: { deploymentMethod: 'ci' },
        repository: { fullName: 'example/repository' },
      },
    });
    mockGenerateCodefreshRunCommand.mockRejectedValueOnce('codefresh rejected');

    await expect(deployHelm([deploy])).rejects.toBe('codefresh rejected');

    expect(mockMetricIncrement).toHaveBeenCalledWith(
      'total',
      expect.objectContaining({ result: 'error', error: 'codefresh rejected' })
    );
    expect(mockRecordFailure).toHaveBeenCalledWith(
      deploy,
      'run-1',
      expect.objectContaining({ error: 'codefresh rejected' })
    );
  });

  it('uses the deploy UUID as the log label and records failure when the deployable relation is missing', async () => {
    const { deploy } = createDeploy({ deployable: undefined });

    await expect(deployHelm([deploy])).rejects.toThrow('Deployable missing for deploy deploy-uuid');

    expect(mockInfo).toHaveBeenCalledWith('Helm: deploying services=deploy-uuid');
    expect(mockWithLogContext).toHaveBeenCalledWith(
      { deployUuid: 'deploy-uuid', serviceName: undefined },
      expect.any(Function)
    );
    expect(mockGenerateCodefreshRunCommand).not.toHaveBeenCalled();
    expect(mockRecordFailure).toHaveBeenCalledWith(
      deploy,
      'run-1',
      expect.objectContaining({ status: DeployStatus.DEPLOY_FAILED })
    );
  });

  it('rethrows superseded native deployment without metrics or failure publication', async () => {
    const helmRef = { provider: 'aws', path: 'app', key: 'helm', envKey: 'HELM_SECRET' };
    const { deploy } = createDeploy();
    mockGetHelmConfiguration.mockResolvedValueOnce({ ...BASE_HELM_CONFIG, helmSecretRefs: [helmRef] });
    const secretMutationGate = jest.fn().mockResolvedValue({ admitted: false });

    await expect(deployHelm([deploy], { secretMutationGate })).rejects.toBeInstanceOf(DeploymentSupersededError);

    expect(mockMetricIncrement).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
    expect(mockPatchActivity).toHaveBeenCalledTimes(1);
  });

  it('tracks failure metrics with safe metadata defaults', async () => {
    const { deploy } = createDeploy({ sha: undefined, branchName: undefined });
    mockConstructBuildMetadata.mockResolvedValueOnce({});
    mockDetermineChartType.mockResolvedValueOnce(ChartType.LOCAL);

    await trackHelmDeploymentMetrics(deploy, 'failure', 321, 'upgrade failed');

    expect(mockMetricsConstructor).toHaveBeenCalledWith('build.deploy.native-helm', {});
    expect(mockMetricIncrement).toHaveBeenCalledWith('total', {
      deployUUID: 'deploy-uuid',
      result: 'error',
      error: 'upgrade failed',
      chartType: ChartType.LOCAL,
      method: 'native',
      durationMs: '321',
    });
    expect(mockMetricEvent).toHaveBeenCalledWith(
      'Native Helm Deploy Finished',
      'undefined native helm deploy deploy-uuid has finished for undefined (duration: 321ms)'
    );
  });
});
