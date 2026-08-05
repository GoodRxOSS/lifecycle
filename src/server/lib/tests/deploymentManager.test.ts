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
const mockRecordDeployFailure = jest.fn().mockResolvedValue(false);
jest.mock('server/services/deploy', () => {
  return jest.fn().mockImplementation(() => ({
    patchAndUpdateActivityFeed: jest.fn().mockResolvedValue(void 0),
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
    mockGetAllConfigs.mockResolvedValue({ logArchival: { enabled: true } });
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

    it('admits all native siblings for a level together while Codefresh and pod readiness stay outside', async () => {
      const nativeHelm = runnableDeploy('native-chart', 'helm');
      const codefreshHelm = runnableDeploy('codefresh-chart', 'helm');
      const kubernetes = runnableDeploy('web', 'github');
      const events: string[] = [];
      let insideGate = false;

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

      const nativeMutationGate = jest.fn(async (action: () => Promise<unknown>) => {
        insideGate = true;
        try {
          return { admitted: true as const, value: await action() };
        } finally {
          insideGate = false;
        }
      });
      const nativeSecretMutationGate = jest.fn();

      const manager = new DeploymentManager([nativeHelm, codefreshHelm, kubernetes], {
        isCurrent: async () => true,
        nativeMutationGate: nativeMutationGate as any,
        nativeSecretMutationGate: nativeSecretMutationGate as any,
      });

      await manager.deploy();

      expect(nativeMutationGate).toHaveBeenCalledTimes(1);
      expect(deployHelm).toHaveBeenCalledWith([nativeHelm], {
        secretMutationGate: nativeSecretMutationGate,
      });
      expect(events).toEqual(
        expect.arrayContaining([
          'codefresh-chart:false',
          'native-chart:true',
          'apply:true',
          'monitor:true',
          'ready:false',
        ])
      );
    });

    it('keeps the promotion gate until every admitted native sibling is terminal', async () => {
      const nativeHelm = runnableDeploy('native-chart', 'helm');
      const kubernetes = runnableDeploy('web', 'github');
      let insideGate = false;
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

      const nativeMutationGate = jest.fn(async (action: () => Promise<unknown>) => {
        insideGate = true;
        try {
          return { admitted: true as const, value: await action() };
        } finally {
          insideGate = false;
        }
      });
      const manager = new DeploymentManager([nativeHelm, kubernetes], {
        nativeMutationGate: nativeMutationGate as any,
      });

      const deployment = manager.deploy();
      await monitorStarted;
      expect(insideGate).toBe(true);

      releaseMonitor();
      await expect(deployment).rejects.toThrow('helm failed');
      expect(insideGate).toBe(false);
      expect(waitForDeployPodReady).toHaveBeenCalledWith(kubernetes);
    });

    it('treats denied native admission as supersession without creating a job or recording failure', async () => {
      const deploy = runnableDeploy('web', 'github');
      const manager = new DeploymentManager([deploy], {
        nativeMutationGate: (async () => ({ admitted: false as const })) as any,
      });

      await expect(manager.deploy()).rejects.toBeInstanceOf(DeploymentSupersededError);

      expect(createKubernetesApplyJob).not.toHaveBeenCalled();
      expect(monitorKubernetesJob).not.toHaveBeenCalled();
      expect(mockRecordDeployFailure).not.toHaveBeenCalled();
    });

    it('stops as superseded when the run-fenced queued patch affects no row', async () => {
      const deploy = runnableDeploy('web', 'github');
      const where = jest.fn().mockResolvedValue(0);
      deploy.$query = () => ({ patch: jest.fn().mockReturnValue({ where }) } as any);
      const manager = new DeploymentManager([deploy]);

      await expect(manager.deploy()).rejects.toBeInstanceOf(DeploymentSupersededError);

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
        nativeMutationGate: (async (action: () => Promise<unknown>) => ({
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
});
