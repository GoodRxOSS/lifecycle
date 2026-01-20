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

import yaml from 'js-yaml';
import * as k8s from '../kubernetes';

// Mock the logger to avoid console output during tests
jest.mock('../logger', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('Kubernetes Node Placement', () => {
  describe('generateAffinity', () => {
    it('should use custom node affinity when provided in deployable', () => {
      const customAffinity = {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                {
                  key: 'disktype',
                  operator: 'In',
                  values: ['ssd'],
                },
              ],
            },
          ],
        },
      };

      const build: any = {
        uuid: 'test-build-uuid',
        isStatic: false,
        capacityType: 'ON_DEMAND',
        enableFullYaml: true,
      };

      const deploy: any = {
        uuid: 'test-deploy-uuid',
        active: true,
        replicaCount: 1,
        dockerImage: 'test-image:latest',
        env: {},
        deployable: {
          name: 'test-service',
          port: '8080',
          capacityType: 'ON_DEMAND',
          nodeAffinity: customAffinity,
          memoryRequest: '512Mi',
          memoryLimit: '1Gi',
          cpuRequest: '250m',
          cpuLimit: '500m',
        },
      };

      const manifest = k8s.generateDeployManifests(
        build,
        [deploy],
        'test-build-uuid',
        true,
        'test-namespace',
        'default'
      );

      const parsed: any = yaml.load(manifest);
      expect(parsed.spec.template.spec.affinity.nodeAffinity).toEqual(customAffinity);
    });

    it('should use default capacity-type based affinity when no custom affinity provided', () => {
      const build: any = {
        uuid: 'test-build-uuid',
        isStatic: false,
        capacityType: 'ON_DEMAND',
        enableFullYaml: true,
      };

      const deploy: any = {
        uuid: 'test-deploy-uuid',
        active: true,
        replicaCount: 1,
        dockerImage: 'test-image:latest',
        env: {},
        deployable: {
          name: 'test-service',
          port: '8080',
          capacityType: 'ON_DEMAND',
          nodeAffinity: undefined,
          memoryRequest: '512Mi',
          memoryLimit: '1Gi',
          cpuRequest: '250m',
          cpuLimit: '500m',
        },
      };

      const manifest = k8s.generateDeployManifests(
        build,
        [deploy],
        'test-build-uuid',
        true,
        'test-namespace',
        'default'
      );

      const parsed: any = yaml.load(manifest);
      // Should have default ON_DEMAND affinity with required scheduling
      expect(
        parsed.spec.template.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution
      ).toBeDefined();
      expect(
        parsed.spec.template.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution
          .nodeSelectorTerms[0].matchExpressions
      ).toContainEqual({
        key: 'eks.amazonaws.com/capacityType',
        operator: 'In',
        values: ['ON_DEMAND'],
      });
    });

    it('should use preferred affinity for SPOT capacity type', () => {
      const build: any = {
        uuid: 'test-build-uuid',
        isStatic: false,
        capacityType: 'SPOT',
        enableFullYaml: true,
      };

      const deploy: any = {
        uuid: 'test-deploy-uuid',
        active: true,
        replicaCount: 1,
        dockerImage: 'test-image:latest',
        env: {},
        deployable: {
          name: 'test-service',
          port: '8080',
          capacityType: 'SPOT',
          nodeAffinity: undefined,
          memoryRequest: '512Mi',
          memoryLimit: '1Gi',
          cpuRequest: '250m',
          cpuLimit: '500m',
        },
      };

      const manifest = k8s.generateDeployManifests(
        build,
        [deploy],
        'test-build-uuid',
        true,
        'test-namespace',
        'default'
      );

      const parsed: any = yaml.load(manifest);
      // SPOT should use preferred scheduling
      expect(
        parsed.spec.template.spec.affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution
      ).toBeDefined();
      expect(
        parsed.spec.template.spec.affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution[0].preference
          .matchExpressions
      ).toContainEqual({
        key: 'eks.amazonaws.com/capacityType',
        operator: 'In',
        values: ['SPOT'],
      });
    });

    it('should override SPOT affinity with custom node affinity when provided', () => {
      const customAffinity = {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                {
                  key: 'custom-label',
                  operator: 'In',
                  values: ['custom-value'],
                },
              ],
            },
          ],
        },
      };

      const build: any = {
        uuid: 'test-build-uuid',
        isStatic: false,
        capacityType: 'SPOT',
        enableFullYaml: true,
      };

      const deploy: any = {
        uuid: 'test-deploy-uuid',
        active: true,
        replicaCount: 1,
        dockerImage: 'test-image:latest',
        env: {},
        deployable: {
          name: 'test-service',
          port: '8080',
          capacityType: 'SPOT',
          nodeAffinity: customAffinity,
          memoryRequest: '512Mi',
          memoryLimit: '1Gi',
          cpuRequest: '250m',
          cpuLimit: '500m',
        },
      };

      const manifest = k8s.generateDeployManifests(
        build,
        [deploy],
        'test-build-uuid',
        true,
        'test-namespace',
        'default'
      );

      const parsed: any = yaml.load(manifest);
      // Should use custom affinity, not SPOT affinity
      expect(parsed.spec.template.spec.affinity.nodeAffinity).toEqual(customAffinity);
    });
  });

  describe('generateDeployManifests with node_selector', () => {
    it('should include nodeSelector in pod spec when provided in deployable', () => {
      const build: any = {
        uuid: 'test-build-uuid',
        isStatic: false,
        capacityType: 'ON_DEMAND',
        enableFullYaml: true,
      };

      const deploy: any = {
        uuid: 'test-deploy-uuid',
        active: true,
        replicaCount: 1,
        dockerImage: 'test-image:latest',
        env: {},
        deployable: {
          name: 'test-service',
          port: '8080',
          capacityType: 'ON_DEMAND',
          nodeSelector: {
            disktype: 'ssd',
            region: 'us-west-2',
          },
          memoryRequest: '512Mi',
          memoryLimit: '1Gi',
          cpuRequest: '250m',
          cpuLimit: '500m',
        },
      };

      const manifest = k8s.generateDeployManifests(
        build,
        [deploy],
        'test-build-uuid',
        true,
        'test-namespace',
        'default'
      );

      const parsed: any = yaml.load(manifest);
      expect(parsed.spec.template.spec.nodeSelector).toEqual({
        disktype: 'ssd',
        region: 'us-west-2',
      });
    });

    it('should not include nodeSelector when not provided', () => {
      const build: any = {
        uuid: 'test-build-uuid',
        isStatic: false,
        capacityType: 'ON_DEMAND',
        enableFullYaml: true,
      };

      const deploy: any = {
        uuid: 'test-deploy-uuid',
        active: true,
        replicaCount: 1,
        dockerImage: 'test-image:latest',
        env: {},
        deployable: {
          name: 'test-service',
          port: '8080',
          capacityType: 'ON_DEMAND',
          nodeSelector: undefined,
          memoryRequest: '512Mi',
          memoryLimit: '1Gi',
          cpuRequest: '250m',
          cpuLimit: '500m',
        },
      };

      const manifest = k8s.generateDeployManifests(
        build,
        [deploy],
        'test-build-uuid',
        true,
        'test-namespace',
        'default'
      );

      const parsed: any = yaml.load(manifest);
      expect(parsed.spec.template.spec.nodeSelector).toBeUndefined();
    });

    it('should include nodeSelector from service model when not using full yaml', () => {
      const build: any = {
        uuid: 'test-build-uuid',
        isStatic: false,
        capacityType: 'ON_DEMAND',
        enableFullYaml: false,
      };

      const deploy: any = {
        uuid: 'test-deploy-uuid',
        active: true,
        replicaCount: 1,
        dockerImage: 'test-image:latest',
        env: {},
        service: {
          name: 'test-service',
          port: '8080',
          capacityType: 'ON_DEMAND',
          nodeSelector: {
            environment: 'production',
          },
          memoryRequest: '512Mi',
          memoryLimit: '1Gi',
          cpuRequest: '250m',
          cpuLimit: '500m',
        },
      };

      const manifest = k8s.generateDeployManifests(
        build,
        [deploy],
        'test-build-uuid',
        false,
        'test-namespace',
        'default'
      );

      const parsed: any = yaml.load(manifest);
      expect(parsed.spec.template.spec.nodeSelector).toEqual({
        environment: 'production',
      });
    });
  });

  describe('generateDeployManifests with both node_selector and node_affinity', () => {
    it('should include both nodeSelector and nodeAffinity when both are provided', () => {
      const customAffinity = {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                {
                  key: 'kubernetes.io/arch',
                  operator: 'In',
                  values: ['amd64'],
                },
              ],
            },
          ],
        },
      };

      const build: any = {
        uuid: 'test-build-uuid',
        isStatic: false,
        capacityType: 'ON_DEMAND',
        enableFullYaml: true,
      };

      const deploy: any = {
        uuid: 'test-deploy-uuid',
        active: true,
        replicaCount: 1,
        dockerImage: 'test-image:latest',
        env: {},
        deployable: {
          name: 'test-service',
          port: '8080',
          capacityType: 'ON_DEMAND',
          nodeSelector: {
            disktype: 'ssd',
          },
          nodeAffinity: customAffinity,
          memoryRequest: '512Mi',
          memoryLimit: '1Gi',
          cpuRequest: '250m',
          cpuLimit: '500m',
        },
      };

      const manifest = k8s.generateDeployManifests(
        build,
        [deploy],
        'test-build-uuid',
        true,
        'test-namespace',
        'default'
      );

      const parsed: any = yaml.load(manifest);
      expect(parsed.spec.template.spec.nodeSelector).toEqual({
        disktype: 'ssd',
      });
      expect(parsed.spec.template.spec.affinity.nodeAffinity).toEqual(customAffinity);
    });
  });
});

describe('generateDeployManifest labels for envLens', () => {
  it('should include app.kubernetes.io/instance label for log streaming compatibility', () => {
    const build: any = {
      uuid: 'test-build-uuid',
      isStatic: false,
      capacityType: 'ON_DEMAND',
      enableFullYaml: true,
    };

    const deploy: any = {
      uuid: 'test-deploy-uuid',
      active: true,
      replicaCount: 1,
      dockerImage: 'test-image:latest',
      env: {},
      deployable: {
        name: 'my-service',
        port: '8080',
        capacityType: 'ON_DEMAND',
        memoryRequest: '512Mi',
        memoryLimit: '1Gi',
        cpuRequest: '250m',
        cpuLimit: '500m',
      },
    };

    const manifest = k8s.generateDeployManifest({
      deploy,
      build,
      namespace: 'test-namespace',
      serviceAccountName: 'default',
    });

    // generateDeployManifest returns multiple YAML documents (deployment + services)
    const docs: any[] = yaml.loadAll(manifest);
    const deployment = docs.find((d) => d?.kind === 'Deployment');

    // The label should be serviceName-buildUUID to match Helm convention
    // Log streaming uses: app.kubernetes.io/instance=${name}-${uuid}
    expect(deployment.metadata.labels['app.kubernetes.io/instance']).toBe('my-service-test-build-uuid');
    expect(deployment.spec.template.metadata.labels['app.kubernetes.io/instance']).toBe('my-service-test-build-uuid');
  });
});
