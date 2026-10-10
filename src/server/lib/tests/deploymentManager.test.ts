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

import { DeploymentManager, DeploymentSupersededError } from '../deploymentManager/deploymentManager';
import { AuthorityLockLostError } from 'server/lib/authorityLock';
import { Deploy } from 'server/models';
import { buildDeployJobName } from '../kubernetes/jobNames';
import { deployHelm } from '../helm';
import { shouldUseNativeHelm } from '../nativeHelm';

jest.mock('../helm', () => ({
  deployHelm: jest.fn().mockResolvedValue(void 0),
}));
jest.mock('../nativeHelm', () => ({
  shouldUseNativeHelm: jest.fn().mockResolvedValue(false),
}));
jest.mock('../kubernetesApply/applyManifest', () => ({
  createKubernetesApplyJob: jest.fn().mockResolvedValue(void 0),
  monitorKubernetesJob: jest.fn().mockResolvedValue({ success: true, message: 'ok', logs: 'apply logs' }),
}));
jest.mock('../kubernetes/common/serviceAccount', () => ({
  ensureServiceAccountForJob: jest.fn().mockResolvedValue(void 0),
}));
jest.mock('../kubernetes', () => ({
  waitForDeployPodReady: jest.fn().mockResolvedValue({ ready: true }),
}));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(),
  },
}));
jest.mock('server/services/logArchival', () => ({
  getLogArchivalService: jest.fn(),
}));
const mockPatchAndUpdateActivityFeed = jest.fn().mockResolvedValue(undefined);
const mockRecordDeployFailure = jest.fn().mockResolvedValue(false);
jest.mock('server/services/deploy', () => {
  return jest.fn().mockImplementation(() => ({
    patchAndUpdateActivityFeed: (...args: any[]) => mockPatchAndUpdateActivityFeed(...args),
    recordDeployFailure: (...args: any[]) => mockRecordDeployFailure(...args),
  }));
});

import { createKubernetesApplyJob, monitorKubernetesJob } from '../kubernetesApply/applyManifest';
import { waitForDeployPodReady } from '../kubernetes';
import GlobalConfigService from 'server/services/globalConfig';
import { getLogArchivalService } from 'server/services/logArchival';
import { DeployStatus } from 'shared/constants';

// todo: add more tests for the below scenarios
// let deploysWithoutDependencies: Deploy[];
// let deploysWithDependencies: Deploy[];
// let deploysWithSelfDependency: Deploy[];
// let deploysWithInvalidDependencies: Deploy[];

describe('DeploymentManager', () => {
  let deploys: Deploy[];
  let deploymentManager: DeploymentManager;
  const mockGetAllConfigs = jest.fn();
  const mockArchiveLogs = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockPatchAndUpdateActivityFeed.mockReset().mockResolvedValue(undefined);
    mockRecordDeployFailure.mockReset().mockResolvedValue(false);
    (deployHelm as jest.Mock).mockReset().mockResolvedValue(undefined);
    (shouldUseNativeHelm as jest.Mock).mockReset().mockResolvedValue(false);
    (createKubernetesApplyJob as jest.Mock).mockReset().mockResolvedValue(undefined);
    (monitorKubernetesJob as jest.Mock)
      .mockReset()
      .mockResolvedValue({ success: true, message: 'ok', logs: 'apply logs' });
    (waitForDeployPodReady as jest.Mock).mockReset().mockResolvedValue({ ready: true });
    (GlobalConfigService.getInstance as jest.Mock).mockReturnValue({
      getAllConfigs: mockGetAllConfigs,
    });
    mockGetAllConfigs.mockReset().mockResolvedValue({ logArchival: { enabled: true } });
    mockArchiveLogs.mockReset().mockResolvedValue(undefined);
    (getLogArchivalService as jest.Mock).mockReturnValue({
      archiveLogs: mockArchiveLogs,
    });
    deploys = [
      { deployable: { name: 'serviceA', deploymentDependsOn: [] } },
      { deployable: { name: 'serviceB', deploymentDependsOn: ['serviceA'] } },
    ] as Deploy[];

    deploymentManager = new DeploymentManager(deploys);
  });

  describe('constructor', () => {
    it('should initialize deploys and calculate deployment order', () => {
      expect(deploymentManager['deploys'].size).toBe(2);
      expect(deploymentManager['deploymentLevels'].size).toBeGreaterThan(0);
    });
  });

  describe('calculateDeploymentOrder', () => {
    it('should correctly calculate deployment levels', () => {
      const levels = deploymentManager['deploymentLevels'];
      expect(levels.get(0)).toMatchObject([{ deployable: { name: 'serviceA' } }]);
      expect(levels.get(1)).toMatchObject([{ deployable: { name: 'serviceB' } }]);
    });

    it('should handle cross-type dependencies between GitHub and Helm services', () => {
      const crossTypeDeploys = [
        {
          deployable: { name: 'postgres', deploymentDependsOn: [], type: 'helm' },
          service: { type: 'helm' },
        },
        {
          deployable: { name: 'api', deploymentDependsOn: ['postgres'], type: 'github' },
          service: { type: 'github' },
        },
        {
          deployable: { name: 'frontend', deploymentDependsOn: ['api', 'cache'], type: 'github' },
          service: { type: 'github' },
        },
        {
          deployable: { name: 'cache', deploymentDependsOn: ['postgres'], type: 'helm' },
          service: { type: 'helm' },
        },
      ] as Deploy[];

      const crossTypeManager = new DeploymentManager(crossTypeDeploys);
      const levels = crossTypeManager['deploymentLevels'];

      expect(levels.get(0)).toMatchObject([{ deployable: { name: 'postgres' } }]);
      expect(levels.get(1)).toHaveLength(2);
      const level1Names = levels
        .get(1)
        .map((d) => d.deployable.name)
        .sort();
      expect(level1Names).toEqual(['api', 'cache']);
      expect(levels.get(2)).toMatchObject([{ deployable: { name: 'frontend' } }]);
    });

    it('should handle complex dependency chain from lifecycle.yaml correctly', () => {
      // This test matches the exact configuration from the provided lifecycle.yaml
      const lifecycleYamlDeploys = [
        {
          deployable: { name: 'sample-web', deploymentDependsOn: [], type: 'helm' },
          service: { type: 'helm' },
        },
        {
          deployable: { name: 'nginx', deploymentDependsOn: [], type: 'docker' },
          service: { type: 'docker' },
        },
        {
          deployable: { name: 'postgres-db', deploymentDependsOn: [], type: 'helm' },
          service: { type: 'helm' },
        },
        {
          deployable: { name: 'jenkins', deploymentDependsOn: [], type: 'helm' },
          service: { type: 'helm' },
        },
        {
          deployable: { name: 'redis', deploymentDependsOn: ['postgres-db'], type: 'helm' },
          service: { type: 'helm' },
        },
        {
          deployable: { name: 'sample-git-service', deploymentDependsOn: ['redis'], type: 'github' },
          service: { type: 'github' },
        },
        {
          deployable: { name: 'sample-rpc', deploymentDependsOn: ['sample-git-service'], type: 'helm' },
          service: { type: 'helm' },
        },
      ] as Deploy[];

      const lifecycleManager = new DeploymentManager(lifecycleYamlDeploys);
      const levels = lifecycleManager['deploymentLevels'];

      // Level 0: All services without dependencies
      const level0Names = levels
        .get(0)
        .map((d) => d.deployable.name)
        .sort();
      expect(level0Names).toEqual(['jenkins', 'nginx', 'postgres-db', 'sample-web']);

      // Level 1: redis (depends on postgres-db)
      const level1Names = levels.get(1).map((d) => d.deployable.name);
      expect(level1Names).toEqual(['redis']);

      // Level 2: sample-git-service (depends on redis)
      const level2Names = levels.get(2).map((d) => d.deployable.name);
      expect(level2Names).toEqual(['sample-git-service']);

      // Level 3: sample-rpc (depends on sample-git-service)
      const level3Names = levels.get(3).map((d) => d.deployable.name);
      expect(level3Names).toEqual(['sample-rpc']);

      // Verify that sample-git-service (GitHub type) waits for redis (Helm type)
      // Find which level each service is in
      let lcTestGhTypeLevel = -1;
      let redisLevel = -1;

      for (let i = 0; i < levels.size; i++) {
        const levelDeploys = levels.get(i);
        if (levelDeploys.some((d) => d.deployable.name === 'sample-git-service')) {
          lcTestGhTypeLevel = i;
        }
        if (levelDeploys.some((d) => d.deployable.name === 'redis')) {
          redisLevel = i;
        }
      }

      // sample-git-service should be deployed AFTER redis
      expect(lcTestGhTypeLevel).toBeGreaterThan(redisLevel);
      expect(lcTestGhTypeLevel).toBe(2);
      expect(redisLevel).toBe(1);
    });
  });

  // todo: add db mock for this test
  // describe('deploy', () => {
  //   it('should call deployHelm for each deployment level', async () => {
  //     await deploymentManager.deploy();

  //     expect(deployHelm).toHaveBeenCalledTimes(2);
  //   });
  // });

  describe('dependency cycles', () => {
    function cyclicDeploy(name: string, dependsOn: string[], patch: jest.Mock) {
      return {
        id: name.split('').reduce((total, character) => total + character.charCodeAt(0), 0),
        uuid: `${name}-uuid`,
        runUUID: `run-${name}`,
        deployable: { name, deploymentDependsOn: [...dependsOn], type: 'helm' },
        service: { type: 'helm' },
        $query: () => ({ patch }),
      } as unknown as Deploy;
    }

    it('leaves cycle members out of every level', () => {
      const patch = jest.fn().mockResolvedValue(undefined);
      const manager = new DeploymentManager([
        cyclicDeploy('a', ['b'], patch),
        cyclicDeploy('b', ['a'], patch),
        cyclicDeploy('standalone', [], patch),
      ]);

      const levels = manager['deploymentLevels'];
      expect(levels.size).toBe(1);
      expect(levels.get(0)).toMatchObject([{ deployable: { name: 'standalone' } }]);
      expect(manager['unresolvedDeploys'].map((d) => d.deployable.name).sort()).toEqual(['a', 'b']);
    });

    it('fails cycle members and their dependents with a cycle message instead of leaving them queued', async () => {
      const patchByName = new Map<string, jest.Mock>();
      const make = (name: string, dependsOn: string[]) => {
        const patch = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(1) });
        patchByName.set(name, patch);
        return cyclicDeploy(name, dependsOn, patch);
      };

      const manager = new DeploymentManager([
        make('a', ['b']),
        make('b', ['a']),
        make('depends-on-cycle', ['a']),
        make('standalone', []),
      ]);

      await manager.deploy();

      const cycleMessage = 'Dependency cycle detected: a -> b -> a; deploy order cannot be resolved';
      expect(patchByName.get('a')).toHaveBeenCalledWith({
        status: DeployStatus.DEPLOY_FAILED,
        statusMessage: cycleMessage,
      });
      expect(patchByName.get('b')).toHaveBeenCalledWith({
        status: DeployStatus.DEPLOY_FAILED,
        statusMessage: cycleMessage,
      });
      expect(patchByName.get('depends-on-cycle')).toHaveBeenCalledWith({
        status: DeployStatus.DEPLOY_FAILED,
        statusMessage: cycleMessage,
      });
      expect(patchByName.get('standalone')).toHaveBeenCalledWith({ status: DeployStatus.QUEUED });
      expect(patchByName.get('a')).not.toHaveBeenCalledWith({ status: DeployStatus.QUEUED });
    });
  });

  describe('provider-aware promotion', () => {
    function runnableDeploy(name: string, type: string, deploymentDependsOn: string[] = []): Deploy {
      return {
        id: name.split('').reduce((total, character) => total + character.charCodeAt(0), 0),
        uuid: `${name}-preview-build-123456`,
        sha: 'abcdef1234567890',
        manifest: 'apiVersion: v1\nkind: ConfigMap',
        runUUID: `run-${name}`,
        build: { namespace: 'testns' },
        deployable: { name, type, deploymentDependsOn: [...deploymentDependsOn] },
        service: { type },
        $query: () => ({
          patch: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(1) }),
        }),
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      } as unknown as Deploy;
    }

    it('admits each native service through its own gate while Codefresh and pod readiness stay outside', async () => {
      const nativeHelm = runnableDeploy('native-chart', 'helm');
      const codefreshHelm = runnableDeploy('codefresh-chart', 'helm');
      const kubernetes = runnableDeploy('web', 'github');
      const events: string[] = [];
      let insideGate = false;
      let gateDepth = 0;

      (shouldUseNativeHelm as jest.Mock).mockImplementation(async (deploy: Deploy) => {
        return deploy.deployable.name === 'native-chart';
      });
      (deployHelm as jest.Mock).mockImplementation(async (deploysToRun: Deploy[]) => {
        events.push(`${deploysToRun[0].deployable.name}:${insideGate}`);
      });
      (createKubernetesApplyJob as jest.Mock).mockImplementation(async () => {
        events.push(`apply:${insideGate}`);
      });
      (monitorKubernetesJob as jest.Mock).mockImplementation(async () => {
        events.push(`monitor:${insideGate}`);
        return { success: true, message: 'ok', logs: 'apply logs' };
      });
      (waitForDeployPodReady as jest.Mock).mockImplementation(async () => {
        events.push(`ready:${insideGate}`);
        return { ready: true };
      });

      const nativeMutationGate = jest.fn(async (_deploy: Deploy, action: () => Promise<unknown>) => {
        gateDepth += 1;
        insideGate = true;
        try {
          return { admitted: true as const, value: await action() };
        } finally {
          gateDepth -= 1;
          insideGate = gateDepth > 0;
        }
      });
      const nativeSecretMutationGate = jest.fn();

      const manager = new DeploymentManager([nativeHelm, codefreshHelm, kubernetes], {
        isCurrent: async () => true,
        nativeMutationGate: nativeMutationGate as any,
        nativeSecretMutationGate: nativeSecretMutationGate as any,
      });

      await manager.deploy();

      expect(nativeMutationGate).toHaveBeenCalledTimes(2);
      expect(nativeMutationGate).toHaveBeenCalledWith(nativeHelm, expect.any(Function));
      expect(nativeMutationGate).toHaveBeenCalledWith(kubernetes, expect.any(Function));
      expect(deployHelm).toHaveBeenCalledWith([nativeHelm], {
        secretMutationGate: nativeSecretMutationGate,
      });
      expect(nativeMutationGate).not.toHaveBeenCalledWith(codefreshHelm, expect.any(Function));
      expect(deployHelm).toHaveBeenCalledWith(
        [codefreshHelm],
        expect.objectContaining({ providerSubmissionGate: expect.any(Function) })
      );
      expect(events).toEqual(
        expect.arrayContaining(['native-chart:true', 'apply:true', 'monitor:true', 'ready:false'])
      );
    });

    it('holds a service gate until its native mutation is terminal, and a failed sibling does not block it', async () => {
      const nativeHelm = runnableDeploy('native-chart', 'helm');
      const kubernetes = runnableDeploy('web', 'github');
      let insideGate = false;
      let gateDepth = 0;
      let releaseMonitor!: () => void;
      let markMonitorStarted!: () => void;
      const monitorStarted = new Promise<void>((resolve) => {
        markMonitorStarted = resolve;
      });

      (shouldUseNativeHelm as jest.Mock).mockResolvedValue(true);
      (deployHelm as jest.Mock).mockRejectedValue(new Error('helm failed'));
      (monitorKubernetesJob as jest.Mock).mockImplementation(async () => {
        markMonitorStarted();
        await new Promise<void>((resolve) => {
          releaseMonitor = resolve;
        });
        return { success: true, message: 'ok', logs: 'apply logs' };
      });

      const nativeMutationGate = jest.fn(async (_deploy: Deploy, action: () => Promise<unknown>) => {
        gateDepth += 1;
        insideGate = true;
        try {
          return { admitted: true as const, value: await action() };
        } finally {
          gateDepth -= 1;
          insideGate = gateDepth > 0;
        }
      });
      const manager = new DeploymentManager([nativeHelm, kubernetes], {
        nativeMutationGate: nativeMutationGate as any,
      });

      const deployment = manager.deploy();
      await monitorStarted;
      expect(insideGate).toBe(true);

      releaseMonitor();
      await expect(deployment).resolves.toEqual({ failed: [nativeHelm] });
      expect(insideGate).toBe(false);
      expect(waitForDeployPodReady).toHaveBeenCalledWith(kubernetes);
    });

    it('skips a service whose native admission is denied without creating a job or recording failure', async () => {
      const deploy = runnableDeploy('web', 'github');
      const manager = new DeploymentManager([deploy], {
        nativeMutationGate: (async () => ({ admitted: false as const })) as any,
      });

      await expect(manager.deploy()).resolves.toEqual({ failed: [] });

      expect(createKubernetesApplyJob).not.toHaveBeenCalled();
      expect(monitorKubernetesJob).not.toHaveBeenCalled();
      expect(mockRecordDeployFailure).not.toHaveBeenCalled();
    });

    it('skips a service as superseded when the run-fenced queued patch affects no row', async () => {
      const deploy = runnableDeploy('web', 'github');
      const where = jest.fn().mockResolvedValue(0);
      deploy.$query = () => ({ patch: jest.fn().mockReturnValue({ where }) } as any);
      const manager = new DeploymentManager([deploy]);

      await expect(manager.deploy()).resolves.toEqual({ failed: [] });

      expect(where).toHaveBeenCalledWith({ id: deploy.id, runUUID: deploy.runUUID });
      expect(createKubernetesApplyJob).not.toHaveBeenCalled();
      expect(mockRecordDeployFailure).not.toHaveBeenCalled();
    });

    it('checks authority before advancing to the next dependency level', async () => {
      const first = runnableDeploy('first', 'github');
      const second = runnableDeploy('second', 'github', ['first']);
      let current = true;

      (waitForDeployPodReady as jest.Mock).mockImplementation(async () => {
        current = false;
        return { ready: true };
      });

      const manager = new DeploymentManager([first, second], {
        isCurrent: async () => current,
        nativeMutationGate: (async (_deploy: Deploy, action: () => Promise<unknown>) => ({
          admitted: true as const,
          value: await action(),
        })) as any,
      });

      await expect(manager.deploy()).rejects.toBeInstanceOf(DeploymentSupersededError);

      expect(createKubernetesApplyJob).toHaveBeenCalledTimes(1);
      expect(mockRecordDeployFailure).not.toHaveBeenCalled();
    });
  });

  describe('deployManifests', () => {
    it('monitors the canonical truncated deploy job name for long deploy uuids', async () => {
      const deploy = {
        uuid: 'sample-cosmos-emulator-preview-build-123456',
        sha: 'abcdef1234567890',
        manifest: 'apiVersion: v1\nkind: ConfigMap',
        runUUID: 'run-1',
        build: {
          namespace: 'testns',
        },
        deployable: {
          name: 'sample-cosmos-emulator',
          type: 'github',
          deploymentDependsOn: [],
        },
        service: {
          type: 'github',
        },
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      } as unknown as Deploy;

      deploymentManager = new DeploymentManager([deploy]);

      const deployment = await deploymentManager['applyManifests'](deploy);
      await deploymentManager['waitForManifestReadiness'](deployment);

      expect(createKubernetesApplyJob).toHaveBeenCalledWith({
        deploy,
        namespace: 'testns',
        jobId: expect.any(String),
      });

      const createdJobId = (createKubernetesApplyJob as jest.Mock).mock.calls[0][0].jobId;
      const expectedJobName = buildDeployJobName({
        deployUuid: deploy.uuid,
        jobId: createdJobId,
        shortSha: 'abcdef1',
      });

      expect(monitorKubernetesJob).toHaveBeenCalledWith(expectedJobName, 'testns');
    });

    it('throws the collected pod failure cause when pods never become ready', async () => {
      (waitForDeployPodReady as jest.Mock).mockResolvedValueOnce({
        ready: false,
        causeSummary: 'pod web-1: web waiting=ImagePullBackOff (Back-off pulling image "x") restarts=0',
      });

      const deploy = {
        uuid: 'web-preview-build-123456',
        sha: 'abcdef1234567890',
        manifest: 'apiVersion: v1\nkind: ConfigMap',
        runUUID: 'run-1',
        build: { namespace: 'testns' },
        deployable: { name: 'web', type: 'github', deploymentDependsOn: [] },
        service: { type: 'github' },
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      } as unknown as Deploy;

      deploymentManager = new DeploymentManager([deploy]);

      const deployment = await deploymentManager['applyManifests'](deploy);
      await expect(deploymentManager['waitForManifestReadiness'](deployment)).rejects.toThrow(
        'Pods failed to become ready within timeout: pod web-1: web waiting=ImagePullBackOff (Back-off pulling image "x") restarts=0'
      );
      expect(mockRecordDeployFailure).toHaveBeenCalledWith(
        deploy,
        'run-1',
        expect.objectContaining({ status: DeployStatus.DEPLOY_FAILED })
      );
    });

    it('archives kubernetes apply logs for non-helm deploys when log archival is enabled', async () => {
      (monitorKubernetesJob as jest.Mock).mockResolvedValueOnce({
        success: true,
        message: 'ok',
        logs: 'kubectl apply logs',
        startedAt: '2026-03-19T17:02:53.000Z',
        completedAt: '2026-03-19T17:02:57.000Z',
        duration: 4,
      });

      const deploy = {
        id: 42,
        uuid: 'sample-webapi-preview-build-123456',
        sha: 'abcdef1234567890',
        manifest: 'apiVersion: v1\nkind: ConfigMap',
        runUUID: 'run-1',
        build: {
          namespace: 'testns',
        },
        deployable: {
          name: 'sample-webapi',
          type: 'github',
          deploymentDependsOn: [],
        },
        service: {
          name: 'sample-webapi',
          type: 'github',
        },
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      } as unknown as Deploy;

      deploymentManager = new DeploymentManager([deploy]);

      const deployment = await deploymentManager['applyManifests'](deploy);
      await deploymentManager['waitForManifestReadiness'](deployment);

      expect(mockArchiveLogs).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: 'deploy',
          jobName: expect.stringContaining('sample-webapi-preview-build-123456-deploy-'),
          serviceName: 'sample-webapi',
          namespace: 'testns',
          deployUuid: 'sample-webapi-preview-build-123456',
          deploymentType: 'github',
        }),
        'kubectl apply logs'
      );
    });
  });

  describe('public deployment failure and boundary behavior', () => {
    function managedDeploy({
      name,
      type = 'github',
      deploymentDependsOn = [],
      manifest = 'apiVersion: v1\nkind: ConfigMap',
      runUUID,
      sha = 'abcdef1234567890',
    }: {
      name: string;
      type?: string;
      deploymentDependsOn?: string[];
      manifest?: string;
      runUUID?: string | null;
      sha?: string;
    }) {
      const where = jest.fn().mockResolvedValue(1);
      const patch = jest.fn().mockReturnValue({ where });
      const resolvedRunUUID = runUUID === undefined ? `run-${name}` : runUUID;
      const deploy = {
        id: name.split('').reduce((total, character) => total + character.charCodeAt(0), 0),
        uuid: `${name}-preview-build-123456`,
        sha,
        manifest,
        runUUID: resolvedRunUUID,
        build: { namespace: 'testns' },
        deployable: { name, type, deploymentDependsOn: [...deploymentDependsOn] },
        service: { type },
        $query: () => ({ patch }),
        $fetchGraph: jest.fn().mockResolvedValue(undefined),
      } as unknown as Deploy;

      return { deploy, patch, where };
    }

    it('removes a self-dependency and records a Codefresh provider failure on the service', async () => {
      const { deploy, patch } = managedDeploy({
        name: 'self-dependent-chart',
        type: 'helm',
        deploymentDependsOn: ['self-dependent-chart'],
      });
      const providerError = new Error('Codefresh deploy failed');
      (deployHelm as jest.Mock).mockRejectedValueOnce(providerError);

      const manager = new DeploymentManager([deploy]);

      await expect(manager.deploy()).resolves.toEqual({ failed: [deploy] });
      expect(deployHelm).toHaveBeenCalledWith(
        [deploy],
        expect.objectContaining({ providerSubmissionGate: expect.any(Function) })
      );
      expect(patch).toHaveBeenCalledWith({ status: DeployStatus.QUEUED });
      expect(createKubernetesApplyJob).not.toHaveBeenCalled();
    });

    it('records a readiness failure on the service and returns it from deploy()', async () => {
      const { deploy } = managedDeploy({ name: 'unready-service' });
      (waitForDeployPodReady as jest.Mock).mockResolvedValueOnce({
        ready: false,
        causeSummary: 'container waiting=ImagePullBackOff',
      });

      const manager = new DeploymentManager([deploy]);

      await expect(manager.deploy()).resolves.toEqual({ failed: [deploy] });
      expect(mockRecordDeployFailure).toHaveBeenCalledWith(
        deploy,
        deploy.runUUID,
        expect.objectContaining({
          status: DeployStatus.DEPLOY_FAILED,
          error: expect.objectContaining({
            message: 'Pods failed to become ready within timeout: container waiting=ImagePullBackOff',
          }),
        })
      );
      expect(deployHelm).not.toHaveBeenCalled();
    });

    it.each([
      {
        caseName: 'archival is disabled',
        config: { logArchival: { enabled: false } },
        logs: 'apply output',
      },
      {
        caseName: 'the provider returns no logs',
        config: { logArchival: { enabled: true } },
        logs: undefined,
      },
      {
        caseName: 'log archival configuration is absent',
        config: {},
        logs: 'apply output',
      },
    ])('skips log archival when $caseName', async ({ config, logs }) => {
      const { deploy } = managedDeploy({ name: 'archive-boundary' });
      mockGetAllConfigs.mockResolvedValueOnce(config);
      (monitorKubernetesJob as jest.Mock).mockResolvedValueOnce({ success: true, message: 'ok', logs });

      const manager = new DeploymentManager([deploy]);
      await manager.deploy();

      expect(mockArchiveLogs).not.toHaveBeenCalled();
      expect(mockPatchAndUpdateActivityFeed).toHaveBeenLastCalledWith(
        deploy,
        { status: DeployStatus.READY, statusMessage: 'Kubernetes pods are ready' },
        deploy.runUUID
      );
    });

    it('reports the base readiness timeout when the provider has no cause summary', async () => {
      const { deploy } = managedDeploy({ name: 'unready-without-cause' });
      (waitForDeployPodReady as jest.Mock).mockResolvedValueOnce({ ready: false });
      const manager = new DeploymentManager([deploy]);

      await expect(manager.deploy()).resolves.toEqual({ failed: [deploy] });
      expect(mockRecordDeployFailure).toHaveBeenCalledWith(
        deploy,
        deploy.runUUID,
        expect.objectContaining({
          status: DeployStatus.DEPLOY_FAILED,
          error: expect.objectContaining({ message: 'Pods failed to become ready within timeout' }),
        })
      );
    });

    it('completes an Aurora CLI deploy without polling pods and uses the missing-SHA fallback', async () => {
      const { deploy } = managedDeploy({ name: 'database-restore', type: 'aurora-restore', sha: '' });
      const manager = new DeploymentManager([deploy]);

      await manager.deploy();

      expect(waitForDeployPodReady).not.toHaveBeenCalled();
      expect(monitorKubernetesJob).toHaveBeenCalledWith(expect.stringContaining('unknown'), 'testns');
      expect(mockPatchAndUpdateActivityFeed).toHaveBeenLastCalledWith(
        deploy,
        { status: DeployStatus.READY, statusMessage: 'CLI Deploy completed' },
        deploy.runUUID
      );
    });

    it('records a deployment failure and avoids Kubernetes calls when the manifest is missing', async () => {
      const { deploy } = managedDeploy({ name: 'missing-manifest', manifest: '' });
      const manager = new DeploymentManager([deploy]);

      await expect(manager.deploy()).resolves.toEqual({ failed: [deploy] });
      expect(mockRecordDeployFailure).toHaveBeenCalledWith(
        deploy,
        deploy.runUUID,
        expect.objectContaining({
          status: DeployStatus.DEPLOY_FAILED,
          error: expect.objectContaining({
            message: `Deploy ${deploy.uuid} has no manifest. Ensure manifests are generated before deployment.`,
          }),
        })
      );
      expect(createKubernetesApplyJob).not.toHaveBeenCalled();
      expect(monitorKubernetesJob).not.toHaveBeenCalled();
      expect(waitForDeployPodReady).not.toHaveBeenCalled();
    });

    it('archives an unsuccessful apply result before recording the provider failure', async () => {
      const { deploy } = managedDeploy({ name: 'failed-apply' });
      (monitorKubernetesJob as jest.Mock).mockResolvedValueOnce({
        success: false,
        message: 'Kubernetes apply job failed',
        logs: 'kubectl error output',
      });
      const manager = new DeploymentManager([deploy]);

      await expect(manager.deploy()).resolves.toEqual({ failed: [deploy] });
      expect(mockArchiveLogs).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'Failed', deployUuid: deploy.uuid }),
        'kubectl error output'
      );
      expect(mockRecordDeployFailure).toHaveBeenCalledWith(
        deploy,
        deploy.runUUID,
        expect.objectContaining({ status: DeployStatus.DEPLOY_FAILED })
      );
      expect(waitForDeployPodReady).not.toHaveBeenCalled();
    });

    it('skips a service superseded during manifest application without recording a provider failure', async () => {
      const { deploy } = managedDeploy({ name: 'superseded-apply' });
      const superseded = new DeploymentSupersededError();
      mockPatchAndUpdateActivityFeed.mockRejectedValueOnce(superseded);
      const manager = new DeploymentManager([deploy]);

      await expect(manager.deploy()).resolves.toEqual({ failed: [] });
      expect(mockRecordDeployFailure).not.toHaveBeenCalled();
      expect(createKubernetesApplyJob).not.toHaveBeenCalled();
    });

    it('skips a service superseded during readiness without recording a provider failure', async () => {
      const { deploy } = managedDeploy({ name: 'superseded-readiness' });
      const superseded = new DeploymentSupersededError();
      (waitForDeployPodReady as jest.Mock).mockRejectedValueOnce(superseded);
      const manager = new DeploymentManager([deploy]);

      await expect(manager.deploy()).resolves.toEqual({ failed: [] });
      expect(mockRecordDeployFailure).not.toHaveBeenCalled();
      expect(mockPatchAndUpdateActivityFeed).not.toHaveBeenCalledWith(
        deploy,
        expect.objectContaining({ status: DeployStatus.READY }),
        deploy.runUUID
      );
    });

    it('blocks dependents of a service that failed before rollout and still deploys unrelated services', async () => {
      const { deploy: db, patch: dbPatch } = managedDeploy({ name: 'db' });
      const { deploy: api, patch: apiPatch } = managedDeploy({ name: 'api', deploymentDependsOn: ['db'] });
      const { deploy: web } = managedDeploy({ name: 'web' });
      const manager = new DeploymentManager([db, api, web], { failedServices: ['db'] });

      const result = await manager.deploy();

      expect(result.failed.map((failed) => failed.deployable.name).sort()).toEqual(['api', 'db']);
      expect(apiPatch).toHaveBeenCalledWith({
        status: DeployStatus.DEPLOY_FAILED,
        statusMessage: 'Not deployed: db failed.',
      });
      expect(dbPatch).not.toHaveBeenCalled();
      expect(createKubernetesApplyJob).toHaveBeenCalledTimes(1);
      expect(createKubernetesApplyJob).toHaveBeenCalledWith(expect.objectContaining({ deploy: web }));
    });

    it('attributes a Codefresh failure to its own service and lets a healthy sibling finish', async () => {
      const { deploy: good } = managedDeploy({ name: 'good-chart', type: 'helm' });
      const { deploy: bad } = managedDeploy({ name: 'bad-chart', type: 'helm' });
      (shouldUseNativeHelm as jest.Mock).mockResolvedValue(false);
      (deployHelm as jest.Mock).mockImplementation(async (deploys: Deploy[]) => {
        if (deploys[0].deployable.name === 'bad-chart') throw new Error('Codefresh deploy failed');
      });
      const manager = new DeploymentManager([good, bad]);

      await expect(manager.deploy()).resolves.toEqual({ failed: [bad] });
      expect(deployHelm).toHaveBeenCalledWith(
        [good],
        expect.objectContaining({ providerSubmissionGate: expect.any(Function) })
      );
      expect(deployHelm).toHaveBeenCalledWith(
        [bad],
        expect.objectContaining({ providerSubmissionGate: expect.any(Function) })
      );
    });

    it('rethrows a lost promotion lease instead of recording it as a service failure', async () => {
      const { deploy } = managedDeploy({ name: 'leased' });
      const lost = new AuthorityLockLostError('deploy-promotion.1');
      const manager = new DeploymentManager([deploy], {
        nativeMutationGate: (async () => {
          throw lost;
        }) as any,
      });

      await expect(manager.deploy()).rejects.toBe(lost);
      expect(mockRecordDeployFailure).not.toHaveBeenCalled();
      expect(waitForDeployPodReady).not.toHaveBeenCalled();
    });

    it('lets launched siblings finish and launches nothing more once a promotion lease is lost', async () => {
      const { deploy: leased } = managedDeploy({ name: 'leased' });
      const { deploy: slow } = managedDeploy({ name: 'slow' });
      const { deploy: dependent, patch: dependentPatch } = managedDeploy({
        name: 'dependent',
        deploymentDependsOn: ['slow'],
      });
      const lost = new AuthorityLockLostError('deploy-promotion.1');
      const events: string[] = [];
      let finishSlow!: () => void;
      const slowApply = new Promise<void>((resolve) => {
        finishSlow = resolve;
      });
      (createKubernetesApplyJob as jest.Mock).mockImplementation(async ({ deploy }: { deploy: Deploy }) => {
        if (deploy !== slow) return;
        await slowApply;
        events.push('slow applied');
      });
      const manager = new DeploymentManager([leased, slow, dependent], {
        nativeMutationGate: (async (deploy: Deploy, action: () => Promise<unknown>) => {
          if (deploy === leased) throw lost;
          return { admitted: true, value: await action() };
        }) as any,
      });

      try {
        const outcome = manager.deploy().catch((error) => {
          events.push('rejected');
          throw error;
        });
        for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
        expect(events).toEqual([]);

        finishSlow();
        await expect(outcome).rejects.toBe(lost);
        expect(events).toEqual(['slow applied', 'rejected']);
        expect(createKubernetesApplyJob).toHaveBeenCalledTimes(1);
        expect(createKubernetesApplyJob).toHaveBeenCalledWith(expect.objectContaining({ deploy: slow }));
        expect(dependentPatch).not.toHaveBeenCalledWith(
          expect.objectContaining({ status: DeployStatus.DEPLOY_FAILED })
        );
        expect(mockRecordDeployFailure).not.toHaveBeenCalled();
      } finally {
        (createKubernetesApplyJob as jest.Mock).mockResolvedValue(undefined);
      }
    });

    it('skips a service another run took while an earlier level was still deploying', async () => {
      const { deploy: first } = managedDeploy({ name: 'first' });
      const { deploy: second, where } = managedDeploy({ name: 'second', deploymentDependsOn: ['first'] });
      where.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
      const manager = new DeploymentManager([first, second]);

      await expect(manager.deploy()).resolves.toEqual({ failed: [] });
      expect(createKubernetesApplyJob).toHaveBeenCalledTimes(1);
      expect(createKubernetesApplyJob).toHaveBeenCalledWith(expect.objectContaining({ deploy: first }));
    });

    it('blocks a dependent of a failed prerequisite that never reaches the manager, such as a Codefresh service', async () => {
      const { deploy: api, patch: apiPatch } = managedDeploy({ name: 'api', deploymentDependsOn: ['migrations'] });
      const { deploy: web } = managedDeploy({ name: 'web' });
      const manager = new DeploymentManager([api, web], { failedServices: ['migrations'] });

      const result = await manager.deploy();

      expect(result.failed).toEqual([api]);
      expect(apiPatch).toHaveBeenCalledWith({
        status: DeployStatus.DEPLOY_FAILED,
        statusMessage: 'Not deployed: migrations failed.',
      });
      expect(createKubernetesApplyJob).toHaveBeenCalledTimes(1);
      expect(createKubernetesApplyJob).toHaveBeenCalledWith(expect.objectContaining({ deploy: web }));
    });

    it('does not hand a Codefresh service to the provider once another run owns its row', async () => {
      const { deploy, where } = managedDeploy({ name: 'chart', type: 'helm' });
      (shouldUseNativeHelm as jest.Mock).mockResolvedValue(false);
      where.mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(0);
      const manager = new DeploymentManager([deploy]);

      await expect(manager.deploy()).resolves.toEqual({ failed: [] });
      expect(deployHelm).not.toHaveBeenCalled();
    });

    it('hands the provider a submission gate that denies a row another run took during command generation', async () => {
      const { deploy, where } = managedDeploy({ name: 'chart', type: 'helm' });
      (shouldUseNativeHelm as jest.Mock).mockResolvedValue(false);
      where.mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(0);
      (deployHelm as jest.Mock).mockImplementation(async (_deploys: Deploy[], options: any) => {
        if (!(await options.providerSubmissionGate(deploy))) throw new DeploymentSupersededError();
      });
      const manager = new DeploymentManager([deploy]);

      await expect(manager.deploy()).resolves.toEqual({ failed: [] });
      expect(mockRecordDeployFailure).not.toHaveBeenCalled();
    });

    it('defers a dependent while another run holds its prerequisite and releases it once that service is ready', async () => {
      const { deploy: a, where: whereA } = managedDeploy({ name: 'a' });
      const { deploy: b } = managedDeploy({ name: 'b', deploymentDependsOn: ['a'] });
      whereA.mockResolvedValue(0);
      const prerequisiteOutcome = jest.fn().mockResolvedValue('ready');
      const manager = new DeploymentManager([a, b], { prerequisiteOutcome });

      await expect(manager.deploy()).resolves.toEqual({ failed: [] });

      expect(prerequisiteOutcome).toHaveBeenCalledWith(b, 'a');
      expect(createKubernetesApplyJob).toHaveBeenCalledTimes(1);
      expect(createKubernetesApplyJob).toHaveBeenCalledWith(expect.objectContaining({ deploy: b }));
    });

    it('defers a dependent whose prerequisite was taken at mutation admission', async () => {
      const { deploy: a } = managedDeploy({ name: 'a' });
      const { deploy: b } = managedDeploy({ name: 'b', deploymentDependsOn: ['a'] });
      const prerequisiteOutcome = jest.fn().mockResolvedValue('ready');
      const manager = new DeploymentManager([a, b], {
        prerequisiteOutcome,
        nativeMutationGate: (async (deploy: Deploy, action: () => Promise<unknown>) =>
          deploy === a ? { admitted: false as const } : { admitted: true as const, value: await action() }) as any,
      });

      await expect(manager.deploy()).resolves.toEqual({ failed: [] });

      expect(prerequisiteOutcome).toHaveBeenCalledWith(b, 'a');
      expect(createKubernetesApplyJob).toHaveBeenCalledTimes(1);
      expect(createKubernetesApplyJob).toHaveBeenCalledWith(expect.objectContaining({ deploy: b }));
    });

    it('waits for a declared prerequisite outside the plan before deploying', async () => {
      const { deploy: b } = managedDeploy({ name: 'b', deploymentDependsOn: ['a'] });
      const prerequisiteOutcome = jest.fn().mockResolvedValue('ready');
      const manager = new DeploymentManager([b], { prerequisiteOutcome });

      await expect(manager.deploy()).resolves.toEqual({ failed: [] });

      expect(prerequisiteOutcome).toHaveBeenCalledWith(b, 'a');
      expect(createKubernetesApplyJob).toHaveBeenCalledWith(expect.objectContaining({ deploy: b }));
    });

    it('never waits for a prerequisite this plan deploys itself', async () => {
      const { deploy: a } = managedDeploy({ name: 'a' });
      const { deploy: b } = managedDeploy({ name: 'b', deploymentDependsOn: ['a'] });
      const prerequisiteOutcome = jest.fn().mockResolvedValue('ready');
      const manager = new DeploymentManager([a, b], { prerequisiteOutcome });

      await expect(manager.deploy()).resolves.toEqual({ failed: [] });

      expect(prerequisiteOutcome).not.toHaveBeenCalled();
      expect(createKubernetesApplyJob).toHaveBeenCalledTimes(2);
    });

    it('blocks a dependent whose prerequisite finished failed elsewhere', async () => {
      const { deploy: b, patch } = managedDeploy({ name: 'b', deploymentDependsOn: ['a'] });
      const prerequisiteOutcome = jest.fn().mockResolvedValue('failed');
      const manager = new DeploymentManager([b], { prerequisiteOutcome });

      await expect(manager.deploy()).resolves.toEqual({ failed: [b] });

      expect(patch).toHaveBeenCalledWith({
        status: DeployStatus.DEPLOY_FAILED,
        statusMessage: 'Not deployed: a failed.',
      });
      expect(createKubernetesApplyJob).not.toHaveBeenCalled();
    });

    it("fails a dependent whose prerequisite never finishes while the row is still this run's", async () => {
      const { deploy: b, patch } = managedDeploy({ name: 'b', deploymentDependsOn: ['a'] });
      const prerequisiteOutcome = jest.fn().mockResolvedValue('stopped');
      const manager = new DeploymentManager([b], { prerequisiteOutcome });

      await expect(manager.deploy()).resolves.toEqual({ failed: [b] });

      expect(patch).toHaveBeenCalledWith({
        status: DeployStatus.DEPLOY_FAILED,
        statusMessage: 'Not deployed: a did not finish.',
      });
      expect(createKubernetesApplyJob).not.toHaveBeenCalled();
    });

    it('skips, rather than fails, a waiting dependent that another run took meanwhile', async () => {
      const { deploy: b, patch, where } = managedDeploy({ name: 'b', deploymentDependsOn: ['a'] });
      where.mockResolvedValueOnce(1).mockResolvedValue(0);
      const prerequisiteOutcome = jest.fn().mockResolvedValue('stopped');
      const manager = new DeploymentManager([b], { prerequisiteOutcome });

      await expect(manager.deploy()).resolves.toEqual({ failed: [] });

      expect(patch).not.toHaveBeenCalledWith(expect.objectContaining({ status: DeployStatus.DEPLOY_FAILED }));
      expect(createKubernetesApplyJob).not.toHaveBeenCalled();
    });

    it('does not hold up an independent service in the same level while a dependent waits', async () => {
      const { deploy: a, where: whereA } = managedDeploy({ name: 'a' });
      const { deploy: b } = managedDeploy({ name: 'b', deploymentDependsOn: ['a'] });
      const { deploy: y } = managedDeploy({ name: 'y' });
      const { deploy: x } = managedDeploy({ name: 'x', deploymentDependsOn: ['y'] });
      whereA.mockResolvedValue(0);
      let releaseWait!: () => void;
      const independentApplied = new Promise<void>((resolve) => {
        releaseWait = resolve;
      });
      (createKubernetesApplyJob as jest.Mock).mockImplementation(async ({ deploy }: { deploy: Deploy }) => {
        if (deploy === x) releaseWait();
      });
      const prerequisiteOutcome = jest.fn(async () => {
        await independentApplied;
        return 'ready' as const;
      });
      const manager = new DeploymentManager([a, b, y, x], { prerequisiteOutcome });

      try {
        await expect(manager.deploy()).resolves.toEqual({ failed: [] });
        expect(createKubernetesApplyJob).toHaveBeenCalledWith(expect.objectContaining({ deploy: b }));
      } finally {
        (createKubernetesApplyJob as jest.Mock).mockResolvedValue(undefined);
      }
    });

    it('launches a service whose prerequisite is absent without waiting for its level mates to finish', async () => {
      const { deploy: a } = managedDeploy({ name: 'a' });
      const { deploy: b } = managedDeploy({ name: 'b', deploymentDependsOn: ['absent'] });
      let releaseA!: () => void;
      const dependentLaunched = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      (createKubernetesApplyJob as jest.Mock).mockImplementation(async ({ deploy }: { deploy: Deploy }) => {
        if (deploy === b) releaseA();
        if (deploy === a) await dependentLaunched;
      });
      const prerequisiteOutcome = jest.fn().mockResolvedValue('ready');
      const manager = new DeploymentManager([a, b], { prerequisiteOutcome });

      try {
        await expect(manager.deploy()).resolves.toEqual({ failed: [] });
        expect(prerequisiteOutcome).toHaveBeenCalledWith(b, 'absent');
        expect(createKubernetesApplyJob).toHaveBeenCalledTimes(2);
      } finally {
        (createKubernetesApplyJob as jest.Mock).mockResolvedValue(undefined);
      }
    });

    it('starts later work whose own prerequisites are done while an unrelated service waits on another run', async () => {
      const { deploy: y } = managedDeploy({ name: 'y' });
      const { deploy: c } = managedDeploy({ name: 'c', deploymentDependsOn: ['y'] });
      const { deploy: b } = managedDeploy({ name: 'b', deploymentDependsOn: ['a'] });
      let releaseB!: () => void;
      const cApplied = new Promise<void>((resolve) => {
        releaseB = resolve;
      });
      (createKubernetesApplyJob as jest.Mock).mockImplementation(async ({ deploy }: { deploy: Deploy }) => {
        if (deploy === c) releaseB();
      });
      // The run that owns a needs c first, so b can only proceed once c (level 1 here) has been applied.
      const prerequisiteOutcome = jest.fn(async () => {
        await cApplied;
        return 'ready' as const;
      });
      const manager = new DeploymentManager([y, c, b], { prerequisiteOutcome });

      try {
        await expect(manager.deploy()).resolves.toEqual({ failed: [] });
        expect(createKubernetesApplyJob).toHaveBeenCalledTimes(3);
        expect(prerequisiteOutcome).toHaveBeenCalledWith(b, 'a');
      } finally {
        (createKubernetesApplyJob as jest.Mock).mockResolvedValue(undefined);
      }
    });

    it('fences every ownership patch on the generation it was handed', async () => {
      const { deploy, where } = managedDeploy({ name: 'chart', type: 'helm' });
      (shouldUseNativeHelm as jest.Mock).mockResolvedValue(false);
      (deployHelm as jest.Mock).mockImplementation(async (_deploys: Deploy[], options: any) => {
        await options.providerSubmissionGate(deploy);
      });
      const manager = new DeploymentManager([deploy], { expectedGeneration: 4 });

      await expect(manager.deploy()).resolves.toEqual({ failed: [] });

      expect(where).toHaveBeenCalled();
      for (const [criteria] of where.mock.calls) {
        expect(criteria).toEqual({ id: deploy.id, runUUID: deploy.runUUID, desiredGeneration: 4 });
      }
    });

    it('claims a persisted deploy whose nullable run identity has not been assigned yet', async () => {
      // The deploys.runUUID database column is nullable even though the model field is typed as string.
      const { deploy, patch, where } = managedDeploy({ name: 'unclaimed-run', runUUID: null });
      const manager = new DeploymentManager([deploy]);

      await manager.deploy();

      expect(deploy.runUUID).toEqual(expect.any(String));
      expect(deploy.runUUID).not.toBe('');
      expect(patch).toHaveBeenCalledTimes(1);
      expect(patch).toHaveBeenCalledWith({ runUUID: deploy.runUUID });
      expect(where).not.toHaveBeenCalled();
      expect(mockPatchAndUpdateActivityFeed).toHaveBeenCalledWith(
        deploy,
        expect.objectContaining({ status: DeployStatus.DEPLOYING }),
        deploy.runUUID
      );
    });
  });
});
