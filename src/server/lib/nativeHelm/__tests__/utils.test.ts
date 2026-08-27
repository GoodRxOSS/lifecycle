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

const mockRbacApi = {
  readNamespacedRole: jest.fn(),
  replaceNamespacedRole: jest.fn(),
  createNamespacedRole: jest.fn(),
  readNamespacedRoleBinding: jest.fn(),
  replaceNamespacedRoleBinding: jest.fn(),
  createNamespacedRoleBinding: jest.fn(),
};
const mockLoadFromDefault = jest.fn();
const mockMakeApiClient = jest.fn(() => mockRbacApi);

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: mockLoadFromDefault,
    makeApiClient: mockMakeApiClient,
  })),
  RbacAuthorizationV1Api: jest.fn(),
}));

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => mockLogger),
}));

jest.mock('server/services/globalConfig');
jest.mock('server/lib/helm/utils', () => {
  const actual = jest.requireActual('server/lib/helm/utils');
  return {
    ...actual,
    renderTemplate: jest.fn().mockImplementation(async (_build, values) => values),
  };
});

import Deploy from 'server/models/Deploy';
import GlobalConfigService from 'server/services/globalConfig';
import { renderTemplate } from 'server/lib/helm/utils';
import { HELM_JOB_TIMEOUT_SECONDS, STATIC_ENV_JOB_TTL_SECONDS } from '../constants';
import {
  ChartType,
  calculateJobTTL,
  constructHelmCommand,
  constructHelmCustomValues,
  constructImageVersion,
  createHelmJob,
  createNamespacedRoleAndBinding,
  determineChartType,
  escapeHelmValue,
  generateHelmInstallScript,
  getHelmConfiguration,
  getRepoAliasFromUrl,
  getRepoUrl,
  mergeHelmConfigWithGlobal,
  resolveHelmCustomValuePrecedence,
  validateHelmConfiguration,
} from '../utils';

const mockGetAllConfigs = jest.fn();
const mockGetOrgChartName = jest.fn();

(GlobalConfigService.getInstance as jest.Mock) = jest.fn().mockReturnValue({
  getAllConfigs: mockGetAllConfigs,
  getOrgChartName: mockGetOrgChartName,
});

function notFoundError(resource: string) {
  return Object.assign(new Error(`${resource} not found`), {
    response: { statusCode: 404, statusMessage: 'Not Found' },
  });
}

describe('nativeHelm utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllConfigs.mockResolvedValue({});
    mockGetOrgChartName.mockResolvedValue('lifecycle-app');
    Object.values(mockRbacApi).forEach((mock) => mock.mockResolvedValue({}));
    (renderTemplate as jest.Mock).mockImplementation(async (_build, values) => values);
  });

  describe('command and configuration construction', () => {
    it('uses an OCI URL for an org chart and preserves flag-style custom values', () => {
      const command = constructHelmCommand(
        'template',
        'ignored-chart-name',
        'sample-release',
        'sample-namespace',
        ['feature.enabled', 'ingress.path=/api/v1,health'],
        [],
        ChartType.ORG_CHART,
        undefined,
        'oci://registry.example.com/charts/sample'
      );

      expect(command).toContain('helm template sample-release oci://registry.example.com/charts/sample');
      expect(command).toContain('--set "feature.enabled"');
      expect(command).toContain('--set "ingress.path=\\/api\\/v1\\,health"');
      expect(command).not.toContain('ignored-chart-name');
    });

    it('builds a renderer command without synthetic renderer arguments', () => {
      const command = constructHelmCommand(
        'template',
        'redis',
        'sample-release',
        'sample-namespace',
        [],
        [],
        ChartType.PUBLIC,
        undefined,
        undefined,
        undefined,
        undefined,
        { enabled: true, command: "/opt/renderer's/bin/render" }
      );

      expect(command).toContain("--post-renderer '/opt/renderer'\\''s/bin/render'");
      expect(command).not.toContain('--post-renderer-args');
    });

    it('generates a repository-free install script without requiring secret set-files', () => {
      const script = generateHelmInstallScript(
        'no-repo',
        'redis',
        'sample-release',
        'sample-namespace',
        [],
        [],
        ChartType.PUBLIC
      );

      expect(script).toContain('helm upgrade --install sample-release redis --namespace sample-namespace');
      expect(script).not.toContain('cd /workspace');
      expect(script).not.toContain('--set-file');
    });

    it('returns the service Helm object unchanged when no global merge source applies', async () => {
      const helm = { args: '--atomic' };
      const deploy = { deployable: { helm } } as Deploy;

      await expect(mergeHelmConfigWithGlobal(deploy)).resolves.toBe(helm);
      expect(mockGetAllConfigs).toHaveBeenCalledTimes(1);
    });

    it('normalizes an absent service Helm configuration to an empty object', async () => {
      const deploy = { deployable: {} } as Deploy;

      await expect(mergeHelmConfigWithGlobal(deploy)).resolves.toEqual({});
    });

    it('builds a complete public-chart configuration from chart and global defaults', async () => {
      mockGetAllConfigs.mockResolvedValue({
        helmDefaults: {
          nativeHelm: { defaultHelmVersion: '3.15.4' },
        },
        redis: {
          chart: {
            name: 'redis',
            values: ['replicaCount=2'],
            valueFiles: ['values/common.yaml'],
          },
        },
      });
      const deploy = Object.assign(new Deploy(), {
        uuid: 'Sample-Release',
        build: { commentRuntimeEnv: {}, isStatic: false },
        deployable: {
          name: 'redis',
          buildUUID: 'build-123',
          helm: { chart: { name: 'redis' } },
        },
      });

      await expect(getHelmConfiguration(deploy)).resolves.toEqual({
        chartType: ChartType.PUBLIC,
        customValues: [
          'replicaCount=2',
          'fullnameOverride=Sample-Release',
          'commonLabels.name=build-123',
          'commonLabels.lc__uuid=build-123',
        ],
        helmSecretRefs: [],
        secretSetFiles: [],
        valuesFiles: ['values/common.yaml'],
        chartPath: 'redis',
        releaseName: 'sample-release',
        helmVersion: '3.15.4',
      });
    });

    it('uses the service chart version ahead of defaults', async () => {
      const deploy = Object.assign(new Deploy(), {
        uuid: 'Local-Release',
        build: { commentRuntimeEnv: {}, isStatic: false },
        deployable: {
          name: 'local-service',
          buildUUID: 'build-123',
          helm: {
            version: '3.16.1',
            chart: { name: 'local' },
          },
        },
      });

      await expect(getHelmConfiguration(deploy)).resolves.toEqual(
        expect.objectContaining({
          chartType: ChartType.LOCAL,
          valuesFiles: [],
          chartPath: 'local',
          releaseName: 'local-release',
          helmVersion: '3.16.1',
        })
      );
    });

    it('uses the built-in Helm version when service and global defaults omit one', async () => {
      const deploy = Object.assign(new Deploy(), {
        uuid: 'Public-Release',
        build: { commentRuntimeEnv: {}, isStatic: false },
        deployable: {
          name: 'redis',
          buildUUID: 'build-123',
          helm: { chart: { name: 'redis' } },
        },
      });

      await expect(getHelmConfiguration(deploy)).resolves.toEqual(
        expect.objectContaining({ helmVersion: '3.12.0', valuesFiles: [] })
      );
    });

    it('does not classify the org chart as build-managed without Docker configuration', async () => {
      const deploy = {
        deployable: {
          helm: { chart: { name: 'lifecycle-app' } },
        },
      } as Deploy;

      await expect(determineChartType(deploy)).resolves.toBe(ChartType.PUBLIC);
    });
  });

  describe('namespace RBAC', () => {
    it('updates existing role resources and verifies both objects without creating replacements', async () => {
      await expect(createNamespacedRoleAndBinding('preview-123', 'helm-runner')).resolves.toBeUndefined();

      expect(mockLoadFromDefault).toHaveBeenCalledTimes(1);
      expect(mockMakeApiClient).toHaveBeenCalledTimes(1);
      expect(mockRbacApi.replaceNamespacedRole).toHaveBeenCalledWith(
        'native-helm-role',
        'preview-123',
        expect.objectContaining({
          kind: 'Role',
          metadata: expect.objectContaining({ name: 'native-helm-role', namespace: 'preview-123' }),
        })
      );
      expect(mockRbacApi.replaceNamespacedRoleBinding).toHaveBeenCalledWith(
        'native-helm-binding-helm-runner',
        'preview-123',
        expect.objectContaining({
          subjects: [{ kind: 'ServiceAccount', name: 'helm-runner', namespace: 'preview-123' }],
        })
      );
      expect(mockRbacApi.readNamespacedRole).toHaveBeenCalledTimes(2);
      expect(mockRbacApi.readNamespacedRoleBinding).toHaveBeenCalledTimes(2);
      expect(mockRbacApi.createNamespacedRole).not.toHaveBeenCalled();
      expect(mockRbacApi.createNamespacedRoleBinding).not.toHaveBeenCalled();
    });

    it('creates role resources only when Kubernetes reports each one missing', async () => {
      mockRbacApi.readNamespacedRole.mockRejectedValueOnce(notFoundError('role')).mockResolvedValueOnce({});
      mockRbacApi.readNamespacedRoleBinding.mockRejectedValueOnce(notFoundError('binding')).mockResolvedValueOnce({});

      await expect(createNamespacedRoleAndBinding('preview-123', 'helm-runner')).resolves.toBeUndefined();

      expect(mockRbacApi.createNamespacedRole).toHaveBeenCalledWith(
        'preview-123',
        expect.objectContaining({ kind: 'Role' })
      );
      expect(mockRbacApi.createNamespacedRoleBinding).toHaveBeenCalledWith(
        'preview-123',
        expect.objectContaining({ kind: 'RoleBinding' })
      );
      expect(mockRbacApi.replaceNamespacedRole).not.toHaveBeenCalled();
      expect(mockRbacApi.replaceNamespacedRoleBinding).not.toHaveBeenCalled();
    });

    it('logs verification failure without converting successful creation into a rejection', async () => {
      const verifyError = new Error('verification unavailable');
      mockRbacApi.readNamespacedRole.mockResolvedValueOnce({}).mockRejectedValueOnce(verifyError);

      await expect(createNamespacedRoleAndBinding('preview-123', 'helm-runner')).resolves.toBeUndefined();

      expect(mockLogger.error).toHaveBeenCalledWith(
        { error: verifyError },
        'Failed to verify RBAC resources: namespace=preview-123'
      );
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('logs and contains Kubernetes network failures without attempting later resources', async () => {
      const networkError = new Error('socket hang up');
      mockRbacApi.readNamespacedRole.mockRejectedValueOnce(networkError);

      await expect(createNamespacedRoleAndBinding('preview-123', 'helm-runner')).resolves.toBeUndefined();

      expect(mockRbacApi.createNamespacedRole).not.toHaveBeenCalled();
      expect(mockRbacApi.readNamespacedRoleBinding).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenNthCalledWith(
        1,
        { error: networkError },
        'Error creating namespace-scoped RBAC: namespace=preview-123'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: networkError,
          statusCode: undefined,
          statusMessage: undefined,
          serviceAccountName: 'helm-runner',
          namespace: 'preview-123',
          roleName: 'native-helm-role',
          roleBindingName: 'native-helm-binding-helm-runner',
        }),
        'RBAC creation failed: namespace=preview-123'
      );
      expect(mockLogger.warn).toHaveBeenNthCalledWith(
        2,
        'RBAC setup failed, helm deployment may have permission issues: namespace=preview-123'
      );
    });

    it('does not replace a missing binding when Kubernetes rejects its lookup for another reason', async () => {
      const unavailable = Object.assign(new Error('API unavailable'), {
        response: { statusCode: 503, statusMessage: 'Service Unavailable' },
      });
      mockRbacApi.readNamespacedRoleBinding.mockRejectedValueOnce(unavailable);

      await expect(createNamespacedRoleAndBinding('preview-123', 'helm-runner')).resolves.toBeUndefined();

      expect(mockRbacApi.replaceNamespacedRole).toHaveBeenCalledTimes(1);
      expect(mockRbacApi.createNamespacedRoleBinding).not.toHaveBeenCalled();
      expect(mockRbacApi.replaceNamespacedRoleBinding).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: unavailable,
          statusCode: 503,
          statusMessage: 'Service Unavailable',
        }),
        'RBAC creation failed: namespace=preview-123'
      );
    });
  });

  describe('job construction', () => {
    it('returns the static cleanup TTL only for static environments', () => {
      expect(calculateJobTTL(true)).toBe(STATIC_ENV_JOB_TTL_SECONDS);
      expect(calculateJobTTL(false)).toBeUndefined();
    });

    it('builds a static job with normalized deploy metadata and an isolated clone init container', () => {
      const job = createHelmJob(
        'helm-deploy-api',
        'preview-123',
        'git-user',
        'git-token',
        'git clone "$REPOSITORY" /workspace',
        [{ name: 'helm', image: 'alpine/helm:3.15.4', resources: { requests: { cpu: 'ignored' } } }],
        {
          workspaceName: 'workspace',
          volumes: [{ name: 'workspace', emptyDir: {} }],
        },
        true,
        'helm-runner',
        'api',
        'build-123',
        {
          sha: 'abcdef123456',
          branch: '/feature/hello world/',
          deployableId: '77',
        }
      );

      expect(job.metadata.labels).toEqual({
        'app.kubernetes.io/name': 'native-helm',
        'app.kubernetes.io/component': 'deployment',
        'lc-uuid': 'build-123',
        service: 'api',
        'git-sha': 'abcdef123456',
        'git-branch': 'feature-hello-world',
        'deploy-id': '',
        'deployable-id': '77',
      });
      expect(job.spec).toEqual(
        expect.objectContaining({
          backoffLimit: 0,
          activeDeadlineSeconds: HELM_JOB_TIMEOUT_SECONDS,
          ttlSecondsAfterFinished: STATIC_ENV_JOB_TTL_SECONDS,
        })
      );
      expect(job.spec.template.spec.containers).toEqual([
        expect.objectContaining({
          name: 'helm',
          image: 'alpine/helm:3.15.4',
          resources: {
            requests: { cpu: '200m', memory: '256Mi' },
            limits: { cpu: '1000m', memory: '1Gi' },
          },
        }),
      ]);
      expect(job.spec.template.spec.initContainers).toEqual([
        expect.objectContaining({
          name: 'clone-repo',
          image: 'alpine/git:latest',
          env: [
            { name: 'GIT_USERNAME', value: 'git-user' },
            { name: 'GIT_PASSWORD', value: 'git-token' },
          ],
          args: ['git clone "$REPOSITORY" /workspace'],
          volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
        }),
      ]);
      expect(job.spec.template.spec.volumes).toEqual([{ name: 'workspace', emptyDir: {} }]);
    });

    it('omits static cleanup, deploy metadata, and git credentials when cloning is disabled', () => {
      const job = createHelmJob(
        'helm-template-api',
        'preview-123',
        'unused-user',
        'unused-token',
        'unused-clone-script',
        [{ name: 'helm', image: 'alpine/helm:3.15.4' }],
        { workspaceName: 'workspace', volumes: [] },
        false,
        undefined,
        'api',
        'build-123',
        undefined,
        false
      );

      expect(job.spec).not.toHaveProperty('ttlSecondsAfterFinished');
      expect(job.spec.template.spec).not.toHaveProperty('initContainers');
      expect(job.spec.template.spec.serviceAccountName).toBe('default');
      expect(job.metadata.labels).toEqual({
        'app.kubernetes.io/name': 'native-helm',
        'app.kubernetes.io/component': 'deployment',
        'lc-uuid': 'build-123',
        service: 'api',
      });
      expect(JSON.stringify(job)).not.toContain('unused-token');
      expect(JSON.stringify(job)).not.toContain('unused-user');
    });
  });

  describe('custom values', () => {
    it('keeps flag entries and retains only the last keyed value without reordering survivors', () => {
      expect(
        resolveHelmCustomValuePrecedence([
          'feature.enabled',
          'image.tag=old',
          'replicaCount=2',
          'image.tag=new',
          'metrics.enabled',
        ])
      ).toEqual(['feature.enabled', 'replicaCount=2', 'image.tag=new', 'metrics.enabled']);
    });

    it('generates gRPC mappings for every configured host and adds ingress only when explicitly enabled', async () => {
      mockGetOrgChartName.mockResolvedValue('lifecycle-app');
      mockGetAllConfigs.mockResolvedValue({
        serviceDefaults: { defaultIPWhiteList: '[10.0.0.0/8]' },
        domainDefaults: {
          http: 'preview.example.test',
          altHttp: [],
          grpc: 'grpc.example.test',
          altGrpc: ['grpc-alt.example.test'],
        },
        'lifecycle-app': { chart: { values: [] } },
      });
      const deploy = Object.assign(new Deploy(), {
        uuid: 'api-preview',
        dockerImage: 'registry.example.com/api:abc123',
        env: {},
        initEnv: {},
        build: { commentRuntimeEnv: {}, isStatic: false },
        deployable: {
          name: 'api',
          buildUUID: 'build-123',
          port: 8080,
          builder: {},
          helm: {
            chart: { name: 'lifecycle-app', values: [] },
            docker: { app: {} },
            grpc: true,
            disableIngressHost: false,
          },
        },
      });

      const values = await constructHelmCustomValues(deploy, ChartType.ORG_CHART);

      expect(values).toEqual(
        expect.arrayContaining([
          'ambassadorMappings[0].name=api-preview-0',
          'ambassadorMappings[0].host=api-preview.grpc.example.test:443',
          'ambassadorMappings[0].port=8080',
          'ambassadorMappings[1].name=api-preview-1',
          'ambassadorMappings[1].host=api-preview.grpc-alt.example.test:443',
          'ambassadorMappings[1].port=8080',
          'ingress.host=api-preview.preview.example.test',
          'ingress.ipAllowlist[0]=10.0.0.0/8',
        ])
      );

      mockGetAllConfigs.mockResolvedValue({
        serviceDefaults: { defaultIPWhiteList: '[10.0.0.0/8]' },
        domainDefaults: {
          http: 'preview.example.test',
          grpc: 'grpc.example.test',
        },
        'lifecycle-app': { chart: { values: [] } },
      });

      const primaryHostOnlyValues = await constructHelmCustomValues(deploy, ChartType.ORG_CHART);
      expect(primaryHostOnlyValues).toContain('ambassadorMappings[0].host=api-preview.grpc.example.test:443');
      expect(primaryHostOnlyValues.some((value) => value.startsWith('ambassadorMappings[1].'))).toBe(false);
    });

    it('adds configured labels, tolerations, and node selection to static public charts', async () => {
      mockGetAllConfigs.mockResolvedValue({
        redis: {
          label: 'workloadLabels',
          tolerations: 'workloadTolerations',
          nodeSelector: 'workloadNodeSelector',
          chart: { name: 'redis', values: [] },
        },
      });
      const deploy = Object.assign(new Deploy(), {
        uuid: 'redis-preview',
        build: { commentRuntimeEnv: {}, isStatic: true },
        deployable: {
          name: 'redis',
          buildUUID: 'build-123',
          helm: { chart: { name: 'redis', values: [] } },
        },
      });

      const values = await constructHelmCustomValues(deploy, ChartType.PUBLIC);

      expect(values).toEqual(
        expect.arrayContaining([
          'workloadLabels.name=build-123',
          'workloadLabels.lc__uuid=build-123',
          'workloadTolerations[0].key=static_env',
          'workloadTolerations[0].operator=Equal',
          'workloadTolerations[0].value=yes',
          'workloadTolerations[0].effect=NoSchedule',
          'workloadNodeSelector.app-long=lifecycle-static-env',
        ])
      );
    });
  });

  describe('URL and validation boundaries', () => {
    it('maps known chart repositories, preserves custom URLs, and derives image versions', () => {
      expect(getRepoUrl('bitnami')).toBe('https://charts.bitnami.com/bitnami');
      expect(getRepoUrl('https://charts.example.test/custom')).toBe('https://charts.example.test/custom');
      expect(constructImageVersion('registry.example.test/api:abc123')).toBe('abc123');
      expect(constructImageVersion('registry.example.test/api')).toBe('latest');
      expect(escapeHelmValue('/api/v1,health')).toBe('\\/api\\/v1\\,health');
    });

    it('derives a deterministic alias from malformed repository URLs', () => {
      expect(getRepoAliasFromUrl('not a valid/repository URL')).toBe('notavalidrepositoryu');
      expect(getRepoAliasFromUrl('%%%')).toBe('default-repo');
    });

    it('reports missing chart and runner version without attempting to invent defaults during validation', async () => {
      const deploy = {
        uuid: 'sample-release',
        build: { commentRuntimeEnv: {}, isStatic: false },
        deployable: {
          name: 'sample-service',
          buildUUID: 'build-123',
          helm: {},
        },
      } as Deploy;

      await expect(validateHelmConfiguration(deploy)).resolves.toEqual([
        'Helm chart name is required',
        'Helm version is required',
      ]);
    });

    it('requires an image when the configured chart is the org application chart', async () => {
      mockGetOrgChartName.mockResolvedValue('lifecycle-app');
      mockGetAllConfigs.mockResolvedValue({
        serviceDefaults: { defaultIPWhiteList: '[]' },
        domainDefaults: { http: 'preview.example.test', grpc: 'grpc.example.test' },
        'lifecycle-app': { chart: { values: [] } },
      });
      const deploy = Object.assign(new Deploy(), {
        uuid: 'sample-release',
        env: {},
        initEnv: {},
        build: { commentRuntimeEnv: {}, isStatic: false },
        deployable: {
          name: 'sample-service',
          buildUUID: 'build-123',
          port: 8080,
          builder: {},
          helm: {
            version: '3.15.4',
            chart: { name: 'lifecycle-app', values: [] },
            docker: { app: {} },
          },
        },
      });

      await expect(validateHelmConfiguration(deploy)).resolves.toContain(
        'Docker image is required for org chart deployments'
      );
    });

    it('surfaces custom-value rendering failures as validation errors', async () => {
      const renderError = new Error('template variable SAMPLE_TOKEN was not found');
      (renderTemplate as jest.Mock).mockRejectedValueOnce(renderError);
      const deploy = {
        uuid: 'sample-release',
        build: { commentRuntimeEnv: {}, isStatic: false },
        deployable: {
          name: 'sample-service',
          buildUUID: 'build-123',
          helm: {
            version: '3.15.4',
            chart: { name: 'redis', values: ['token={{SAMPLE_TOKEN}}'] },
          },
        },
      } as Deploy;

      await expect(validateHelmConfiguration(deploy)).resolves.toEqual([
        'template variable SAMPLE_TOKEN was not found',
      ]);
    });
  });
});
