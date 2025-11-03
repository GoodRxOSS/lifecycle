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

import { DeploymentManager } from '../deploymentManager/deploymentManager';
import { Deploy } from 'server/models';
// import { deployHelm } from '../helm';

jest.mock('../helm', () => ({
  deployHelm: jest.fn().mockResolvedValue(void 0),
}));

// todo: add more tests for the below scenarios
// let deploysWithoutDependencies: Deploy[];
// let deploysWithDependencies: Deploy[];
// let deploysWithSelfDependency: Deploy[];
// let deploysWithInvalidDependencies: Deploy[];

describe('DeploymentManager', () => {
  let deploys: Deploy[];
  let deploymentManager: DeploymentManager;

  beforeEach(() => {
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
          deployable: { name: 'lc-test', deploymentDependsOn: [], type: 'helm' },
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
          deployable: { name: 'lc-test-gh-type', deploymentDependsOn: ['redis'], type: 'github' },
          service: { type: 'github' },
        },
        {
          deployable: { name: 'grpc-echo', deploymentDependsOn: ['lc-test-gh-type'], type: 'helm' },
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
      expect(level0Names).toEqual(['jenkins', 'lc-test', 'nginx', 'postgres-db']);

      // Level 1: redis (depends on postgres-db)
      const level1Names = levels.get(1).map((d) => d.deployable.name);
      expect(level1Names).toEqual(['redis']);

      // Level 2: lc-test-gh-type (depends on redis)
      const level2Names = levels.get(2).map((d) => d.deployable.name);
      expect(level2Names).toEqual(['lc-test-gh-type']);

      // Level 3: grpc-echo (depends on lc-test-gh-type)
      const level3Names = levels.get(3).map((d) => d.deployable.name);
      expect(level3Names).toEqual(['grpc-echo']);

      // Verify that lc-test-gh-type (GitHub type) waits for redis (Helm type)
      // Find which level each service is in
      let lcTestGhTypeLevel = -1;
      let redisLevel = -1;

      for (let i = 0; i < levels.size; i++) {
        const levelDeploys = levels.get(i);
        if (levelDeploys.some((d) => d.deployable.name === 'lc-test-gh-type')) {
          lcTestGhTypeLevel = i;
        }
        if (levelDeploys.some((d) => d.deployable.name === 'redis')) {
          redisLevel = i;
        }
      }

      // lc-test-gh-type should be deployed AFTER redis
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
});
