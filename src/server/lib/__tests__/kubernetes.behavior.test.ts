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

const mockInfo = jest.fn();
const mockDebug = jest.fn();
const mockWarn = jest.fn();
const mockError = jest.fn();
const mockLogger = { info: mockInfo, debug: mockDebug, warn: mockWarn, error: mockError };
const mockGetLogger = jest.fn();
const mockShellPromise = jest.fn();
const mockGetAllConfigs = jest.fn();
const mockGetKeepLabel = jest.fn();
const mockLoadFromDefault = jest.fn();
const mockMakeApiClient = jest.fn();
const mockMakeObjectApiClient = jest.fn();

const mockReadNamespace = jest.fn();
const mockCreateNamespace = jest.fn();
const mockPatchNamespace = jest.fn();
const mockListNamespacedPod = jest.fn();
const mockReadNamespacedPod = jest.fn();
const mockReadNamespacedSecret = jest.fn();
const mockReplaceNamespacedSecret = jest.fn();
const mockReadNamespacedIngress = jest.fn();
const mockObjectRead = jest.fn();
const mockObjectPatch = jest.fn();
const mockObjectCreate = jest.fn();

const mockCoreClient = {
  readNamespace: mockReadNamespace,
  createNamespace: mockCreateNamespace,
  patchNamespace: mockPatchNamespace,
  listNamespacedPod: mockListNamespacedPod,
  readNamespacedPod: mockReadNamespacedPod,
  readNamespacedSecret: mockReadNamespacedSecret,
  replaceNamespacedSecret: mockReplaceNamespacedSecret,
};
const mockNetworkingClient = { readNamespacedIngress: mockReadNamespacedIngress };
const mockObjectClient = { read: mockObjectRead, patch: mockObjectPatch, create: mockObjectCreate };

jest.mock('../logger', () => ({
  getLogger: (...args: unknown[]) => mockGetLogger(...args),
}));

jest.mock('../shell', () => ({
  shellPromise: (...args: unknown[]) => mockShellPromise(...args),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args),
    }),
  },
}));

jest.mock('server/lib/utils', () => ({
  ...jest.requireActual('server/lib/utils'),
  getKeepLabel: (...args: unknown[]) => mockGetKeepLabel(...args),
}));

jest.mock('@kubernetes/client-node', () => {
  class MockHttpError extends Error {}
  class MockCoreV1Api {}
  class MockNetworkingV1Api {}

  return {
    HttpError: MockHttpError,
    CoreV1Api: MockCoreV1Api,
    NetworkingV1Api: MockNetworkingV1Api,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: mockLoadFromDefault,
      makeApiClient: mockMakeApiClient,
    })),
    KubernetesObjectApi: {
      makeApiClient: (...args: unknown[]) => mockMakeObjectApiClient(...args),
    },
    PatchUtils: {
      PATCH_FORMAT_JSON_MERGE_PATCH: 'application/merge-patch+json',
    },
  };
});

import fs from 'fs';
import { IncomingMessage } from 'http';
import yaml from 'js-yaml';
import { Socket } from 'net';
import { HttpError, KubeConfig } from '@kubernetes/client-node';
import { DeployTypes, MEDIUM_TYPE } from 'shared/constants';
import * as kubernetes from '../kubernetes';

const makeBuild = (overrides: Record<string, any> = {}) => ({
  uuid: 'build-uuid',
  namespace: 'env-build-uuid',
  capacityType: 'ON_DEMAND',
  isStatic: false,
  manifest: '',
  commentRuntimeEnv: {},
  commentInitEnv: {},
  pullRequest: {
    branchName: 'feature/test',
    fullName: 'goodrx/lifecycle',
  },
  sha: 'abc123',
  ...overrides,
});

const makeDeploy = (overrides: Record<string, any> = {}) => {
  const { deployable: deployableOverrides = {}, ...deployOverrides } = overrides;
  return {
    id: 7,
    uuid: 'deploy-uuid',
    active: true,
    replicaCount: 1,
    dockerImage: 'registry.example/service:latest',
    env: {},
    initEnv: {},
    cname: null,
    build: makeBuild(),
    deployable: {
      name: 'service',
      type: DeployTypes.DOCKER,
      port: '8080',
      capacityType: 'ON_DEMAND',
      ...deployableOverrides,
    },
    ...deployOverrides,
  };
};

const immediateTimers = () =>
  jest.spyOn(global, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void) => {
    callback();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);

const loadYamlDocuments = (manifest: string): any[] => yaml.loadAll(manifest).filter(Boolean) as any[];

describe('kubernetes behavior', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();

    (KubeConfig as unknown as jest.Mock).mockImplementation(() => ({
      loadFromDefault: mockLoadFromDefault,
      makeApiClient: mockMakeApiClient,
    }));
    mockGetLogger.mockReturnValue(mockLogger);
    mockGetKeepLabel.mockResolvedValue('lifecycle-keep!');
    mockGetAllConfigs.mockResolvedValue({ ttl_cleanup: { inactivityDays: 3 } });
    mockMakeApiClient.mockReturnValue(mockCoreClient);
    mockMakeObjectApiClient.mockReturnValue(mockObjectClient);
    mockReadNamespace.mockRejectedValue({ response: { statusCode: 404 } });
    mockCreateNamespace.mockResolvedValue({ body: {} });
    mockPatchNamespace.mockResolvedValue({ body: {} });
    mockListNamespacedPod.mockResolvedValue({ body: { items: [] } });
    mockReadNamespacedPod.mockResolvedValue({ body: {} });
    mockReadNamespacedSecret.mockResolvedValue({ body: { data: {} } });
    mockReplaceNamespacedSecret.mockResolvedValue({ body: {} });
    mockReadNamespacedIngress.mockResolvedValue({ body: {} });
    mockObjectRead.mockResolvedValue({ body: {} });
    mockObjectPatch.mockResolvedValue({ body: {} });
    mockObjectCreate.mockResolvedValue({ body: {} });
    mockShellPromise.mockResolvedValue('');
  });

  describe('namespaces', () => {
    it('creates an ephemeral namespace with configured TTL and pull-request metadata', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

      await kubernetes.createOrUpdateNamespace({
        name: 'env-build-uuid',
        buildUUID: 'build-uuid',
        staticEnv: false,
        pullRequest: {
          fullName: 'Good Rx/lifecycle api',
          pullRequestNumber: 42,
          githubLogin: '-octo/cat-',
          labels: ['reviewed'],
        },
      });

      expect(mockGetKeepLabel).toHaveBeenCalledTimes(1);
      expect(mockGetAllConfigs).toHaveBeenCalledTimes(1);
      expect(mockCreateNamespace).toHaveBeenCalledWith({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: {
          name: 'env-build-uuid',
          labels: expect.objectContaining({
            'lfc/uuid': 'build-uuid',
            'lfc/type': 'ephemeral',
            'lfc/org': 'Good-Rx',
            'lfc/repo': 'lifecycle-api',
            'lfc/pull-request': '42',
            'lfc/author': 'octo-cat',
            'lfc/ttl-enable': 'true',
            'lfc/ttl-createdAtUnix': '1700000000000',
            'lfc/ttl-expireAtUnix': String(1_700_000_000_000 + 3 * 24 * 60 * 60 * 1000),
          }),
        },
      });
      expect(mockPatchNamespace).not.toHaveBeenCalled();
      expect(mockInfo).toHaveBeenCalledWith('Deploy: creating namespace with TTL enabled (3 day expiration)');
    });

    it('disables TTL for a keep-labelled pull request and lets explicit metadata take precedence', async () => {
      mockReadNamespace.mockResolvedValue({ body: {} });

      await kubernetes.createOrUpdateNamespace({
        name: 'env-override',
        buildUUID: 'build-uuid',
        staticEnv: false,
        repo: 'explicit/repository',
        pullRequestNumber: 99,
        author: 'explicit-author',
        pullRequest: {
          fullName: 'ignored/repo',
          pullRequestNumber: 5,
          githubLogin: 'ignored-author',
          labels: JSON.stringify(['lifecycle-keep!']),
        },
      });

      expect(mockPatchNamespace).toHaveBeenCalledTimes(1);
      expect(mockPatchNamespace.mock.calls[0][0]).toBe('env-override');
      expect(mockPatchNamespace.mock.calls[0][1]).toEqual(
        expect.arrayContaining([
          { op: 'add', path: '/metadata/labels/lfc~1uuid', value: 'override' },
          { op: 'add', path: '/metadata/labels/lfc~1org', value: 'explicit' },
          { op: 'add', path: '/metadata/labels/lfc~1repo', value: 'repository' },
          { op: 'add', path: '/metadata/labels/lfc~1pull-request', value: '99' },
          { op: 'add', path: '/metadata/labels/lfc~1author', value: 'explicit-author' },
          { op: 'add', path: '/metadata/labels/lfc~1ttl-enable', value: 'false' },
        ])
      );
      expect(mockPatchNamespace.mock.calls[0].at(-1)).toEqual({
        headers: { 'Content-Type': 'application/json-patch+json' },
      });
      expect(mockGetAllConfigs).not.toHaveBeenCalled();
      expect(mockCreateNamespace).not.toHaveBeenCalled();
      expect(mockInfo).toHaveBeenCalledWith('Deploy: updated namespace to disable TTL (lifecycle-keep! present)');
    });

    it('forces TTL off for static namespaces even when explicitly enabled', async () => {
      mockReadNamespace.mockResolvedValue({ body: {} });

      await kubernetes.createOrUpdateNamespace({
        name: 'env-static',
        buildUUID: 'build-uuid',
        staticEnv: true,
        ttl: true,
      });

      expect(mockPatchNamespace).toHaveBeenCalledTimes(1);
      expect(mockPatchNamespace.mock.calls[0][0]).toBe('env-static');
      expect(mockPatchNamespace.mock.calls[0][1]).toEqual(
        expect.arrayContaining([
          { op: 'add', path: '/metadata/labels/lfc~1type', value: 'static' },
          { op: 'add', path: '/metadata/labels/lfc~1ttl-enable', value: 'false' },
        ])
      );
      expect(mockGetKeepLabel).not.toHaveBeenCalled();
      expect(mockGetAllConfigs).not.toHaveBeenCalled();
    });

    it('short-circuits keep-label lookup when deriving TTL for a static pull-request namespace', async () => {
      await kubernetes.createOrUpdateNamespace({
        name: 'env-static-pr',
        buildUUID: 'build-uuid',
        staticEnv: true,
        pullRequest: { fullName: 'goodrx/lifecycle', labels: undefined },
      });

      expect(mockGetKeepLabel).not.toHaveBeenCalled();
      expect(mockGetAllConfigs).not.toHaveBeenCalled();
      expect(mockCreateNamespace).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            labels: expect.objectContaining({ 'lfc/ttl-enable': 'false', 'lfc/type': 'static' }),
          }),
        })
      );
    });

    it('derives ephemeral TTL without pull-request metadata and patches all expiration labels', async () => {
      mockReadNamespace.mockResolvedValue({ body: {} });
      mockGetAllConfigs.mockResolvedValue({});
      jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

      await kubernetes.createOrUpdateNamespace({
        name: 'env-existing',
        buildUUID: 'build-uuid',
        staticEnv: false,
      });

      expect(mockGetKeepLabel).not.toHaveBeenCalled();
      expect(mockPatchNamespace.mock.calls[0][1]).toEqual(
        expect.arrayContaining([
          { op: 'add', path: '/metadata/labels/lfc~1ttl-enable', value: 'true' },
          { op: 'add', path: '/metadata/labels/lfc~1ttl-createdAtUnix', value: '1700000000000' },
          {
            op: 'add',
            path: '/metadata/labels/lfc~1ttl-expireAtUnix',
            value: String(1_700_000_000_000 + 14 * 24 * 60 * 60 * 1000),
          },
        ])
      );
      expect(mockInfo).toHaveBeenCalledWith('Deploy: updated namespace with new TTL expiration (14 days)');
    });

    it('falls back to the default TTL when global configuration cannot be read', async () => {
      const configError = new Error('config unavailable');
      mockGetAllConfigs.mockRejectedValue(configError);
      jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

      await kubernetes.createOrUpdateNamespace({
        name: 'env-default-ttl',
        buildUUID: 'build-uuid',
        staticEnv: false,
        ttl: true,
      });

      expect(mockCreateNamespace).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            labels: expect.objectContaining({
              'lfc/ttl-expireAtUnix': String(1_700_000_000_000 + 14 * 24 * 60 * 60 * 1000),
            }),
          }),
        })
      );
      expect(mockWarn).toHaveBeenCalledWith('TTL: config fetch failed default=14days');
      expect(mockGetLogger).toHaveBeenCalledWith({ error: configError });
    });

    it('treats AlreadyExists from concurrent namespace creation as success', async () => {
      mockCreateNamespace.mockRejectedValue({ statusCode: 409 });

      await expect(
        kubernetes.createOrUpdateNamespace({
          name: 'env-raced',
          buildUUID: 'build-uuid',
          staticEnv: false,
          ttl: false,
        })
      ).resolves.toBeUndefined();

      expect(mockInfo).toHaveBeenCalledWith('Namespace: create raced, already exists');
    });

    it('rethrows namespace read and create failures that are not absence or AlreadyExists', async () => {
      const readError = new Error('forbidden');
      mockReadNamespace.mockRejectedValueOnce(readError);

      await expect(
        kubernetes.createOrUpdateNamespace({
          name: 'env-read-fails',
          buildUUID: 'build-uuid',
          staticEnv: false,
          ttl: false,
        })
      ).rejects.toBe(readError);
      expect(mockError).toHaveBeenCalledWith('Namespace: read failed');

      const createError = new Error('create failed');
      mockReadNamespace.mockRejectedValueOnce({ response: { statusCode: 404 } });
      mockCreateNamespace.mockRejectedValueOnce(createError);
      await expect(
        kubernetes.createOrUpdateNamespace({
          name: 'env-create-fails',
          buildUUID: 'build-uuid',
          staticEnv: false,
          ttl: false,
        })
      ).rejects.toBe(createError);
      expect(mockError).toHaveBeenCalledWith('Namespace: create failed');
    });

    it('waits for both newly created and patched namespaces when requested', async () => {
      mockShellPromise.mockResolvedValue(' Active \n');

      await kubernetes.createOrUpdateNamespace({
        name: 'env-new-ready',
        buildUUID: 'build-uuid',
        staticEnv: false,
        ttl: false,
        waitForReady: true,
      });
      expect(mockShellPromise).toHaveBeenCalledWith(
        "kubectl get namespace env-new-ready -o jsonpath='{.status.phase}'"
      );

      mockReadNamespace.mockResolvedValueOnce({ body: {} });
      await kubernetes.createOrUpdateNamespace({
        name: 'env-patched-ready',
        buildUUID: 'build-uuid',
        staticEnv: false,
        ttl: false,
        waitForReady: true,
      });
      expect(mockShellPromise).toHaveBeenCalledWith(
        "kubectl get namespace env-patched-ready -o jsonpath='{.status.phase}'"
      );
    });

    it('times out when a requested namespace never becomes Active', async () => {
      immediateTimers();
      mockShellPromise.mockRejectedValue(new Error('not ready'));
      jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(30_001);

      await expect(
        kubernetes.createOrUpdateNamespace({
          name: 'env-never-ready',
          buildUUID: 'build-uuid',
          staticEnv: false,
          ttl: false,
          waitForReady: true,
        })
      ).rejects.toThrow('Namespace env-never-ready did not become ready within 30000ms');
    });

    it.each([
      [{ statusCode: 409 }, true],
      [{ code: 409 }, true],
      [{ response: { statusCode: 409 } }, true],
      [{ body: { reason: 'AlreadyExists' } }, true],
      [{ response: { body: { reason: 'AlreadyExists' } } }, true],
      [{ statusCode: 500, body: { reason: 'Other' } }, false],
      [null, false],
    ])('classifies namespace create error %#', (error, expected) => {
      expect(kubernetes.isNamespaceAlreadyExistsError(error)).toBe(expected);
    });
  });

  describe('generic Kubernetes object application', () => {
    it('uses deployment manager when the legacy manifest is absent or blank', async () => {
      await expect(kubernetes.applyManifests(makeBuild({ manifest: undefined }) as any)).resolves.toEqual([]);
      await expect(kubernetes.applyManifests(makeBuild({ manifest: '   ' }) as any)).resolves.toEqual([]);

      expect(mockMakeObjectApiClient).not.toHaveBeenCalled();
      expect(mockInfo).toHaveBeenCalledWith('Deploy: starting method=deploymentManager');
    });

    it('patches existing named resources and ignores malformed YAML documents', async () => {
      mockObjectPatch.mockResolvedValue({ body: { kind: 'Service', metadata: { name: 'api' } } });
      const manifest = [
        'apiVersion: v1\nkind: Service\nmetadata:\n  name: api',
        'apiVersion: v1\nmetadata:\n  name: missing-kind',
        'apiVersion: v1\nkind: ConfigMap\nmetadata: {}',
        'apiVersion: v1\nkind: Secret',
        '',
      ].join('\n---\n');

      await expect(kubernetes.applyManifests(makeBuild({ manifest }) as any)).resolves.toEqual([
        { kind: 'Service', metadata: { name: 'api' } },
      ]);

      expect(mockObjectRead).toHaveBeenCalledTimes(1);
      expect(mockObjectPatch).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'Service' }),
        undefined,
        undefined,
        undefined,
        true
      );
      expect(mockObjectCreate).not.toHaveBeenCalled();
    });

    it('retries an HttpError patch as JSON merge patch', async () => {
      const response = new IncomingMessage(new Socket());
      response.statusCode = 422;
      mockObjectPatch
        .mockRejectedValueOnce(new HttpError(response, 'server-side apply unsupported', 422))
        .mockResolvedValueOnce({ body: { kind: 'Deployment', metadata: { name: 'api' } } });
      const manifest = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api';

      await expect(kubernetes.applyManifests(makeBuild({ manifest }) as any)).resolves.toEqual([
        { kind: 'Deployment', metadata: { name: 'api' } },
      ]);

      expect(mockObjectPatch).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ kind: 'Deployment' }),
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-type': 'application/merge-patch+json' } }
      );
    });

    it('creates missing resources and logs create failures without aborting later resources', async () => {
      const missing = { response: { statusCode: 404 } };
      mockObjectRead.mockRejectedValue(missing);
      mockObjectCreate
        .mockRejectedValueOnce(new Error('invalid service'))
        .mockResolvedValueOnce({ body: { kind: 'ConfigMap', metadata: { name: 'settings' } } });
      const manifest = [
        'apiVersion: v1\nkind: Service\nmetadata:\n  name: api',
        'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings',
      ].join('\n---\n');

      await expect(kubernetes.applyManifests(makeBuild({ manifest }) as any)).resolves.toEqual([
        { kind: 'ConfigMap', metadata: { name: 'settings' } },
      ]);

      expect(mockObjectCreate).toHaveBeenCalledTimes(2);
      expect(mockError).toHaveBeenCalledWith('kubectl apply unsuccessful');
      expect(mockGetLogger).toHaveBeenCalledWith({ specName: 'api', error: expect.any(Error) });
    });
  });

  describe('pods and deletion', () => {
    it('constructs a Core API client and filters pod list responses by UUID in the name', async () => {
      const matching = { metadata: { name: 'api-build-uuid-123' } };
      mockListNamespacedPod.mockResolvedValue({
        body: {
          items: [matching, { metadata: { name: 'other' } }, { metadata: {} }],
        },
      });

      expect(kubernetes.getK8sApi()).toBe(mockCoreClient);
      await expect(kubernetes.getPods({ uuid: 'build-uuid', namespace: 'env-build-uuid' })).resolves.toEqual([
        matching,
      ]);
      expect(mockLoadFromDefault).toHaveBeenCalled();
      expect(mockListNamespacedPod).toHaveBeenCalledWith(
        'env-build-uuid',
        undefined,
        undefined,
        undefined,
        undefined,
        'lc_uuid=build-uuid'
      );

      mockListNamespacedPod.mockResolvedValueOnce(undefined);
      await expect(kubernetes.getPods({ uuid: 'build-uuid', namespace: 'env-build-uuid' })).resolves.toEqual([]);
    });

    it('waits through pod creation and transient readiness errors until an application pod is ready', async () => {
      immediateTimers();
      const pod = {
        metadata: { name: 'api-build-uuid', labels: { 'app.kubernetes.io/managed-by': 'lifecycle' } },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      };
      mockListNamespacedPod
        .mockResolvedValueOnce({ body: { items: [] } })
        .mockResolvedValueOnce({ body: { items: [pod] } })
        .mockRejectedValueOnce(new Error('temporary API failure'))
        .mockResolvedValueOnce({ body: { items: [pod] } });

      await expect(kubernetes.waitForPodReady(makeBuild() as any)).resolves.toBe(true);

      expect(mockWarn).toHaveBeenCalledWith('Pod: readiness check failed');
      expect(mockInfo).toHaveBeenCalledWith('Deploy: pods created');
      expect(mockInfo).toHaveBeenCalledWith('Deploy: pods ready');
    });

    it('rejects after the application pods remain non-ready for 15 minutes', async () => {
      immediateTimers();
      const pod = {
        metadata: { name: 'api-build-uuid', labels: {} },
        status: { conditions: [] },
      };
      mockListNamespacedPod.mockResolvedValue({ body: { items: [pod] } });

      await expect(kubernetes.waitForPodReady(makeBuild() as any)).rejects.toThrow(
        'Pods for build not ready after 15 minutes buildUuid=build-uuid repo=goodrx/lifecycle branch=feature/test'
      );
      expect(mockListNamespacedPod).toHaveBeenCalledTimes(182);
    });

    it('logs creation timeout and continues through the existing empty readiness behavior', async () => {
      immediateTimers();
      mockListNamespacedPod.mockResolvedValue({ body: { items: [] } });

      await expect(kubernetes.waitForPodReady(makeBuild({ pullRequest: null, sha: undefined }) as any)).resolves.toBe(
        true
      );

      expect(mockListNamespacedPod).toHaveBeenCalledTimes(62);
      expect(mockWarn).toHaveBeenCalledWith('Pod: not found timeout=5m');
      expect(mockInfo).toHaveBeenCalledWith('Deploy: pods ready');
    });

    it('ignores Helm-managed pods when deciding legacy deployment readiness', async () => {
      const helmPod = {
        metadata: {
          name: 'helm-build-uuid',
          labels: { 'app.kubernetes.io/managed-by': 'Helm' },
        },
        status: { conditions: [] },
      };
      mockListNamespacedPod.mockResolvedValue({ body: { items: [helmPod] } });

      await expect(kubernetes.waitForPodReady(makeBuild() as any)).resolves.toBe(true);
      expect(mockInfo).toHaveBeenCalledWith('Deploy: pods ready');
    });

    it('treats missing status and non-Ready conditions as not ready before a later successful poll', async () => {
      immediateTimers();
      const noStatus = {
        metadata: { name: 'api-build-uuid', labels: { 'app.kubernetes.io/managed-by': 'lifecycle' } },
      };
      const scheduled = {
        metadata: { name: 'api-build-uuid', labels: { 'app.kubernetes.io/managed-by': 'lifecycle' } },
        status: { conditions: [{ type: 'PodScheduled', status: 'True' }] },
      };
      const ready = {
        metadata: { name: 'api-build-uuid', labels: { 'app.kubernetes.io/managed-by': 'lifecycle' } },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      };
      mockListNamespacedPod
        .mockResolvedValueOnce({ body: { items: [noStatus] } })
        .mockResolvedValueOnce({ body: { items: [noStatus] } })
        .mockResolvedValueOnce({ body: { items: [scheduled] } })
        .mockResolvedValueOnce({ body: { items: [ready] } });

      await expect(kubernetes.waitForPodReady(makeBuild() as any)).resolves.toBe(true);
      expect(mockListNamespacedPod).toHaveBeenCalledTimes(4);
    });

    it('deletes build resources while treating mapping and missing-namespace failures as idempotent', async () => {
      const mappingError = new Error('mapping CRD unavailable');
      mockShellPromise.mockResolvedValueOnce('deleted').mockRejectedValueOnce(mappingError);

      await expect(kubernetes.deleteBuild(makeBuild() as any)).resolves.toBeUndefined();
      expect(mockDebug).toHaveBeenCalledWith('Resources: mapping delete skipped');
      expect(mockInfo).toHaveBeenCalledWith('Deploy: resources deleted');

      mockShellPromise.mockRejectedValueOnce(
        new Error('Error from server (NotFound): namespaces "env-build-uuid" not found')
      );
      await expect(kubernetes.deleteBuild(makeBuild() as any)).resolves.toBeUndefined();
      expect(mockInfo).toHaveBeenCalledWith('Deploy: resources skipped reason=namespaceNotFound');
    });

    it('rethrows non-idempotent build deletion failures, including non-Error values', async () => {
      const error = new Error('permission denied');
      mockShellPromise.mockRejectedValueOnce(error);
      await expect(kubernetes.deleteBuild(makeBuild() as any)).rejects.toBe(error);

      mockShellPromise.mockRejectedValueOnce('plain failure');
      await expect(kubernetes.deleteBuild(makeBuild() as any)).rejects.toBe('plain failure');
      expect(mockError).toHaveBeenCalledWith('Resources: delete failed');
    });

    it('probes present, missing-pod, and missing-namespace states without hiding API failures', async () => {
      mockReadNamespace.mockResolvedValue({ body: {} });
      await expect(kubernetes.probeWorkspacePodPresence('env-one', 'pod-one')).resolves.toBe('present');
      expect(mockReadNamespacedPod).toHaveBeenCalledWith('pod-one', 'env-one');

      mockReadNamespacedPod.mockRejectedValueOnce({ response: { statusCode: 404 } });
      await expect(kubernetes.probeWorkspacePodPresence('env-one', 'pod-missing')).resolves.toBe('pod_missing');

      mockReadNamespace.mockRejectedValueOnce({ response: { statusCode: 404 } });
      await expect(kubernetes.probeWorkspacePodPresence('env-gone', 'pod-one')).resolves.toBe('namespace_missing');

      const error = new Error('API unavailable');
      mockReadNamespace.mockResolvedValueOnce({ body: {} });
      mockReadNamespacedPod.mockRejectedValueOnce(error);
      await expect(kubernetes.probeWorkspacePodPresence('env-one', 'pod-one')).rejects.toBe(error);
      expect(mockError).toHaveBeenCalledWith('Pod: read failed');
    });

    it.each(['unsafe', 'environment', 'prod-env'])('refuses to delete an unscoped namespace named %s', async (name) => {
      await kubernetes.deleteNamespace(name);
      expect(mockShellPromise).not.toHaveBeenCalled();
    });

    it.each(['env-one', 'sbx-one', 'prj-one', 'chat-one'])(
      'deletes an agent-managed namespace named %s',
      async (name) => {
        await kubernetes.deleteNamespace(name);
        expect(mockShellPromise).toHaveBeenCalledWith(`kubectl delete ns ${name} --grace-period 120`);
        expect(mockInfo).toHaveBeenCalledWith('Deploy: namespace deleted');
      }
    );

    it('treats a missing namespace as deleted and rethrows other namespace deletion failures', async () => {
      mockShellPromise.mockRejectedValueOnce('Error from server (NotFound): namespaces already gone');
      await expect(kubernetes.deleteNamespace('env-gone')).resolves.toBeUndefined();
      expect(mockInfo).toHaveBeenCalledWith('Deploy: namespace skipped reason=notFound');

      const error = new Error('forbidden');
      mockShellPromise.mockRejectedValueOnce(error);
      await expect(kubernetes.deleteNamespace('env-protected')).rejects.toBe(error);
      expect(mockError).toHaveBeenCalledWith('Namespace: delete failed');
    });
  });

  describe('manifest generation', () => {
    it('assembles all legacy manifest categories for eligible CLI and Kubernetes deploys', () => {
      const cliDeploy = makeDeploy({
        uuid: 'database',
        cname: 'database.internal.example',
        deployable: { name: 'database', type: DeployTypes.CODEFRESH },
      });
      const dockerDeploy = makeDeploy({
        uuid: 'api',
        deployable: {
          name: 'api',
          type: DeployTypes.DOCKER,
          grpc: true,
          grpcHost: 'grpc.example.test',
          serviceDisksYaml: JSON.stringify([
            { name: 'data', mountPath: '/data', storageSize: '10Gi' },
            { name: 'cache', mountPath: '/cache', storageSize: '1Gi', medium: MEDIUM_TYPE.MEMORY },
          ]),
        },
      });
      const imageMissing = makeDeploy({
        uuid: 'not-runnable',
        dockerImage: null,
        deployable: { type: DeployTypes.DOCKER },
      });
      const unrelated = makeDeploy({
        uuid: 'configuration',
        deployable: { type: DeployTypes.CONFIGURATION },
      });

      const result = kubernetes.generateManifest({
        build: makeBuild() as any,
        deploys: [cliDeploy, dockerDeploy, imageMissing, unrelated] as any,
        uuid: 'build-uuid',
        namespace: 'env-build-uuid',
        serviceAccountName: 'runtime-account',
      });
      const documents = loadYamlDocuments(result);

      expect(documents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'PersistentVolumeClaim',
            metadata: expect.objectContaining({ name: 'api-data-claim' }),
          }),
          expect.objectContaining({ kind: 'Deployment', metadata: expect.objectContaining({ name: 'api' }) }),
          expect.objectContaining({ kind: 'Mapping', metadata: expect.objectContaining({ name: 'api' }) }),
          expect.objectContaining({ kind: 'Service', spec: expect.objectContaining({ type: 'ExternalName' }) }),
        ])
      );
      expect(documents.some((document) => document?.metadata?.name === 'not-runnable')).toBe(false);
      expect(documents.some((document) => document?.metadata?.name === 'configuration')).toBe(false);
    });

    it('generates PVCs only for active deploys and persistent disk media', () => {
      const disks = [
        { name: 'default', mountPath: '/default', storageSize: '1Gi' },
        { name: 'ebs', mountPath: '/ebs', storageSize: '2Gi', medium: MEDIUM_TYPE.EBS, accessModes: 'ReadWriteMany' },
        { name: 'disk', mountPath: '/disk', storageSize: '3Gi', medium: MEDIUM_TYPE.DISK },
        { name: 'memory', mountPath: '/memory', storageSize: '4Gi', medium: MEDIUM_TYPE.MEMORY },
      ];
      const active = disks.map((disk) =>
        makeDeploy({
          uuid: `storage-${disk.name}`,
          deployable: { serviceDisksYaml: JSON.stringify([disk]) },
        })
      );
      const inactive = makeDeploy({
        uuid: 'inactive',
        active: false,
        deployable: { serviceDisksYaml: JSON.stringify(disks) },
      });
      const noDisks = makeDeploy({ uuid: 'no-disks', deployable: { serviceDisksYaml: null } });

      const documents = loadYamlDocuments(
        kubernetes.generatePersistentDisks([...active, inactive, noDisks] as any, 'build-uuid', 'env-build-uuid')
      );

      expect(documents.map((document) => document.metadata.name)).toEqual([
        'storage-default-default-claim',
        'storage-ebs-ebs-claim',
        'storage-disk-disk-claim',
      ]);
      expect(documents[0].spec.accessModes).toEqual(['ReadWriteOnce']);
      expect(documents[1].spec.accessModes).toEqual(['ReadWriteMany']);
    });

    it('generates a feature-rich plural deployment while filtering unsupported environment values', () => {
      const deploy = makeDeploy({
        uuid: 'api',
        env: {
          API_TOKEN: '{{aws:apps/lifecycle:token}}',
          NESTED: { ignored: true },
          DD_ENV: 'manual-env',
          DD_SERVICE: 'manual-service',
          DD_VERSION: 'manual-version',
          LC_UUID: 'manual-uuid',
        },
        initDockerImage: 'registry.example/init:latest',
        initEnv: { INIT_TOKEN: '{{gcp:projects/demo:token}}', PLAIN: 'value' },
        deployable: {
          name: 'api',
          port: '8080,9090',
          capacityType: 'SPOT',
          memoryRequest: '256Mi',
          cpuRequest: '100m',
          memoryLimit: '512Mi',
          cpuLimit: '500m',
          readinessTcpSocketPort: 8080,
          readinessInitialDelaySeconds: 2,
          command: '/app/start',
          arguments: '--serve%%SPLIT%%--verbose',
          initCommand: '/init',
          initArguments: '--prepare%%SPLIT%%--once',
          nodeSelector: { architecture: 'amd64' },
          serviceDisksYaml: JSON.stringify([
            { name: 'default', mountPath: '/default', storageSize: '1Gi' },
            { name: 'memory', mountPath: '/memory', storageSize: '2Gi', medium: MEDIUM_TYPE.MEMORY },
            { name: 'unknown', mountPath: '/unknown', storageSize: '3Gi', medium: 'UNKNOWN' },
          ]),
        },
      });
      const build = makeBuild({
        capacityType: '',
        isStatic: true,
        commentRuntimeEnv: { COMMENT_VALUE: 'runtime' },
        commentInitEnv: { COMMENT_INIT: 'init' },
      });

      const document = yaml.load(
        kubernetes.generateDeployManifests(
          build as any,
          [deploy] as any,
          'build-uuid',
          'env-build-uuid',
          'runtime-account'
        )
      ) as any;
      const podSpec = document.spec.template.spec;
      const container = podSpec.containers[0];
      const initContainer = podSpec.initContainers[0];

      expect(document.spec.strategy).toEqual({ type: 'Recreate' });
      expect(podSpec.affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution).toBeDefined();
      expect(podSpec.nodeSelector).toEqual({ architecture: 'amd64' });
      expect(podSpec.tolerations).toBeDefined();
      expect(container.ports).toEqual([
        { name: 'port-8080', containerPort: 8080 },
        { name: 'port-9090', containerPort: 9090 },
      ]);
      expect(container.command).toEqual(['/app/start']);
      expect(container.args).toEqual(['--serve', '--verbose']);
      expect(container.readinessProbe.tcpSocket.port).toBe(8080);
      expect(container.livenessProbe.initialDelaySeconds).toBe(600);
      expect(container.env).toEqual(
        expect.arrayContaining([
          { name: 'API_TOKEN', valueFrom: { secretKeyRef: { name: 'api-aws-secrets', key: 'API_TOKEN' } } },
          { name: 'COMMENT_VALUE', value: 'runtime' },
          { name: 'DD_ENV', value: 'manual-env' },
        ])
      );
      expect(container.env.some((entry: any) => entry.name === 'NESTED')).toBe(false);
      expect(container.env.filter((entry: any) => entry.name === 'DD_ENV')).toHaveLength(1);
      expect(initContainer.env).toEqual(
        expect.arrayContaining([
          { name: 'INIT_TOKEN', valueFrom: { secretKeyRef: { name: 'api-gcp-secrets', key: 'INIT_TOKEN' } } },
          { name: 'PLAIN', value: 'value' },
        ])
      );
      expect(initContainer.command).toEqual(['/init']);
      expect(initContainer.args).toEqual(['--prepare', '--once']);
      expect(podSpec.volumes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'api-default', persistentVolumeClaim: { claimName: 'api-default-claim' } }),
          expect.objectContaining({ name: 'api-memory', emptyDir: { medium: 'Memory', sizeLimit: '2Gi' } }),
        ])
      );
      expect(mockWarn).toHaveBeenCalledWith('Disk: unknown medium medium=UNKNOWN');
      expect(mockInfo).toHaveBeenCalledWith('Build: static environment=true');
    });

    it('uses namespace-only environment defaults when plural deploy env inputs are absent', () => {
      const deploy = makeDeploy({
        env: undefined,
        initEnv: undefined,
        initDockerImage: 'registry.example/init:latest',
        deployable: { port: '' },
      });

      const deployment = yaml.load(
        kubernetes.generateDeployManifests(
          makeBuild() as any,
          [deploy] as any,
          'build-uuid',
          'env-build-uuid',
          'runtime-account'
        )
      ) as any;

      expect(deployment.spec.template.spec.containers[0].env).toEqual(
        expect.arrayContaining([{ name: '__NAMESPACE__', value: 'lifecycle' }])
      );
      expect(deployment.spec.template.spec.initContainers[0].env).toEqual(
        expect.arrayContaining([{ name: '__NAMESPACE__', value: 'lifecycle' }])
      );
    });

    it('generates focused service, mapping, external-name, and load-balancer manifests', () => {
      const noPort = makeDeploy({ uuid: 'no-port', deployable: { port: '' } });
      const inactive = makeDeploy({ uuid: 'inactive', active: false, cname: 'ignored.example' });
      const grpcDisabled = makeDeploy({ uuid: 'grpc-off', deployable: { grpc: false } });
      const grpcEnabled = makeDeploy({
        uuid: 'grpc-on',
        deployable: { grpc: true, grpcHost: 'example.test', port: '50051' },
      });
      const external = makeDeploy({ uuid: 'external', cname: 'external.example' });
      const emptyExternal = makeDeploy({ uuid: 'empty-external', cname: '' });
      const missingExternal = makeDeploy({ uuid: 'missing-external', cname: undefined });

      const nodePort = yaml.load(
        kubernetes.generateNodePortManifests([noPort, inactive] as any, 'build-uuid', 'env-build-uuid')
      ) as any;
      expect(nodePort.spec.ports).toEqual([]);

      const mappings = loadYamlDocuments(
        kubernetes.generateGRPCMappings([grpcDisabled, grpcEnabled, inactive] as any, 'build-uuid', 'env-build-uuid')
      );
      expect(mappings).toHaveLength(1);
      expect(mappings[0].spec).toEqual(
        expect.objectContaining({ hostname: 'grpc-on.example.test:443', service: 'grpc-on:50051' })
      );

      const externalNames = loadYamlDocuments(
        kubernetes.generateExternalNameManifests(
          [external, emptyExternal, missingExternal, inactive] as any,
          'build-uuid',
          'env-build-uuid'
        )
      );
      expect(externalNames.map((document) => document.metadata.name)).toEqual(['external', 'empty-external']);
      expect(externalNames[1].spec.externalName).toBe('');

      const loadBalancer = yaml.load(
        kubernetes.generateLoadBalancerManifests([noPort, inactive] as any, 'build-uuid', 'env-build-uuid')
      ) as any;
      expect(loadBalancer.spec.ports).toEqual([]);
    });

    it('returns an ExternalName manifest for CLI deploys and skips CLI deploys without a host', () => {
      const deploy = makeDeploy({
        uuid: 'database',
        cname: 'database.example',
        deployable: { type: DeployTypes.CODEFRESH },
      });
      const build = makeBuild();

      const externalName = yaml.load(
        kubernetes.generateDeployManifest({
          deploy: deploy as any,
          build: build as any,
          namespace: 'env-build-uuid',
          serviceAccountName: 'runtime-account',
        })
      ) as any;
      expect(externalName).toEqual(
        expect.objectContaining({ kind: 'Service', spec: { type: 'ExternalName', externalName: 'database.example' } })
      );

      expect(
        kubernetes.generateDeployManifest({
          deploy: { ...deploy, cname: null } as any,
          build: build as any,
          namespace: 'env-build-uuid',
          serviceAccountName: 'runtime-account',
        })
      ).toBe('');
      expect(mockInfo).toHaveBeenCalledWith('Manifest: skipped reason=empty');
    });

    it('generates a feature-rich single deployment including init containers, secrets, disks, probes, and static placement', () => {
      const deploy = makeDeploy({
        uuid: 'api',
        replicaCount: undefined,
        env: {
          API_TOKEN: '{{vault:apps/lifecycle:token}}',
          NESTED: { ignored: true },
          DD_ENV: 'manual-env',
          DD_SERVICE: 'manual-service',
          DD_VERSION: 'manual-version',
          LC_UUID: 'manual-uuid',
        },
        initDockerImage: 'registry.example/init:latest',
        initEnv: { INIT_TOKEN: '{{onepassword:services/api:token}}', NESTED: { ignored: true } },
        deployable: {
          name: 'api',
          port: '8080,9090',
          memoryLimit: '512Mi',
          cpuLimit: '500m',
          readinessHttpGetPort: 8080,
          readinessHttpGetPath: '/health',
          readinessPeriodSeconds: 5,
          command: '/app/start',
          arguments: '--serve%%SPLIT%%--verbose',
          initCommand: '/init',
          initArguments: '--prepare%%SPLIT%%--once',
          nodeSelector: { topology: 'private' },
          grpc: true,
          grpcHost: 'grpc.example.test',
          serviceDisksYaml: JSON.stringify([
            { name: 'memory', mountPath: '/memory', storageSize: '1Gi', medium: MEDIUM_TYPE.MEMORY },
            { name: 'data', mountPath: '/data', storageSize: '5Gi', medium: MEDIUM_TYPE.EBS },
          ]),
        },
      });
      const build = makeBuild({
        isStatic: true,
        commentRuntimeEnv: { COMMENT_VALUE: 7 },
        commentInitEnv: { INIT_VALUE: false },
      });

      const documents = loadYamlDocuments(
        kubernetes.generateDeployManifest({
          deploy: deploy as any,
          build: build as any,
          namespace: 'env-build-uuid',
          serviceAccountName: 'runtime-account',
        })
      );
      const deployment = documents.find((document) => document.kind === 'Deployment');
      const podSpec = deployment.spec.template.spec;
      const container = podSpec.containers[0];
      const initContainer = podSpec.initContainers[0];

      expect(deployment.spec.replicas).toBe(1);
      expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
      expect(podSpec.nodeSelector).toEqual({ topology: 'private' });
      expect(podSpec.tolerations).toBeDefined();
      expect(container.resources).toEqual({
        limits: { cpu: '500m', memory: '512Mi' },
        requests: { cpu: '500m', memory: '512Mi' },
      });
      expect(container.env).toEqual(
        expect.arrayContaining([
          { name: 'API_TOKEN', valueFrom: { secretKeyRef: { name: 'api-vault-secrets', key: 'API_TOKEN' } } },
          { name: 'COMMENT_VALUE', value: '7' },
          { name: 'DD_ENV', value: 'manual-env' },
        ])
      );
      expect(container.env.some((entry: any) => entry.name === 'NESTED')).toBe(false);
      expect(container.command).toEqual(['/app/start']);
      expect(container.args).toEqual(['--serve', '--verbose']);
      expect(container.readinessProbe.httpGet).toEqual({ path: '/health', port: 8080 });
      expect(container.livenessProbe.initialDelaySeconds).toBe(600);
      expect(container.volumeMounts).toEqual(
        expect.arrayContaining([
          { name: 'memory', mountPath: '/memory' },
          { name: 'data', mountPath: '/data' },
        ])
      );
      expect(initContainer.env).toEqual(
        expect.arrayContaining([
          {
            name: 'INIT_TOKEN',
            valueFrom: { secretKeyRef: { name: 'api-onepassword-secrets', key: 'INIT_TOKEN' } },
          },
          { name: 'INIT_VALUE', value: 'false' },
        ])
      );
      expect(initContainer.command).toEqual(['/init']);
      expect(initContainer.args).toEqual(['--prepare', '--once']);
      expect(initContainer.ports).toHaveLength(2);
    });

    it('omits optional submanifests and container settings when an inactive deploy has no optional configuration', () => {
      const deploy = makeDeploy({
        active: false,
        replicaCount: 0,
        dockerImage: null,
        env: undefined,
        deployable: {
          port: '',
          memoryLimit: undefined,
          cpuLimit: undefined,
          grpc: false,
          serviceDisksYaml: null,
        },
      });

      const documents = loadYamlDocuments(
        kubernetes.generateDeployManifest({
          deploy: deploy as any,
          build: makeBuild({ capacityType: '' }) as any,
          namespace: 'env-build-uuid',
          serviceAccountName: 'runtime-account',
        })
      );

      expect(documents).toHaveLength(1);
      expect(documents[0].kind).toBe('Deployment');
      expect(documents[0].spec.replicas).toBe(0);
      expect(documents[0].spec.strategy).toEqual({ rollingUpdate: { maxUnavailable: '0%' } });
      expect(documents[0].spec.template.spec.containers[0].resources).toBeUndefined();
      expect(documents[0].spec.template.spec.initContainers).toBeUndefined();
    });

    it('uses documented container-name fallbacks for an empty deployable name', () => {
      const deploy = makeDeploy({
        env: { API_TOKEN: '{{aws:apps/lifecycle:token}}' },
        initDockerImage: 'registry.example/init:latest',
        initEnv: { INIT_TOKEN: '{{gcp:projects/demo:token}}' },
        deployable: {
          name: '',
          port: '',
          cpuLimit: undefined,
          memoryLimit: '128Mi',
        },
      });

      const documents = loadYamlDocuments(
        kubernetes.generateDeployManifest({
          deploy: deploy as any,
          build: makeBuild() as any,
          namespace: 'env-build-uuid',
          serviceAccountName: 'runtime-account',
        })
      );
      const podSpec = documents.find((document) => document.kind === 'Deployment').spec.template.spec;

      expect(podSpec.containers[0].name).toBe('main');
      expect(podSpec.initContainers[0].name).toBe('init-container');
      expect(podSpec.containers[0].env).toEqual(
        expect.arrayContaining([
          { name: 'API_TOKEN', valueFrom: { secretKeyRef: { name: 'service-aws-secrets', key: 'API_TOKEN' } } },
        ])
      );
      expect(podSpec.initContainers[0].env).toEqual(
        expect.arrayContaining([
          {
            name: 'INIT_TOKEN',
            valueFrom: { secretKeyRef: { name: 'service-gcp-secrets', key: 'INIT_TOKEN' } },
          },
        ])
      );
      expect(podSpec.containers[0].resources).toEqual({
        limits: { memory: '128Mi' },
        requests: { memory: '128Mi' },
      });
    });

    it('uses single-deployment init environment defaults and supports a TCP-only probe', () => {
      const deploy = makeDeploy({
        initDockerImage: 'registry.example/init:latest',
        initEnv: undefined,
        deployable: {
          readinessTcpSocketPort: 8080,
          readinessHttpGetPort: undefined,
          readinessHttpGetPath: undefined,
        },
      });

      const documents = loadYamlDocuments(
        kubernetes.generateDeployManifest({
          deploy: deploy as any,
          build: makeBuild() as any,
          namespace: 'env-build-uuid',
          serviceAccountName: 'runtime-account',
        })
      );
      const podSpec = documents.find((document) => document.kind === 'Deployment').spec.template.spec;

      expect(podSpec.initContainers[0].env).toEqual(
        expect.arrayContaining([{ name: '__NAMESPACE__', value: 'lifecycle' }])
      );
      expect(podSpec.containers[0].readinessProbe).toEqual(expect.objectContaining({ tcpSocket: { port: 8080 } }));
    });

    it('logs generated legacy manifests outside development environments', () => {
      jest.isolateModules(() => {
        jest.doMock('shared/config', () => ({ APP_ENV: 'production', TMP_PATH: '/tmp/lifecycle' }));
        const isolatedKubernetes = require('../kubernetes') as typeof kubernetes;

        isolatedKubernetes.generateManifest({
          build: makeBuild() as any,
          deploys: [],
          uuid: 'build-uuid',
          namespace: 'env-build-uuid',
          serviceAccountName: 'runtime-account',
        });
      });

      expect(mockInfo).toHaveBeenCalledWith('Manifest: generated');
    });
  });

  describe('status, ingress, secrets, and local namespace', () => {
    it('returns kubectl status output and degrades command failures to an empty status', async () => {
      mockShellPromise.mockResolvedValueOnce('api-build-uuid Running');
      await expect(kubernetes.checkKubernetesStatus(makeBuild() as any)).resolves.toBe('api-build-uuid Running\n');

      const error = new Error('kubectl unavailable');
      mockShellPromise.mockRejectedValueOnce(error);
      await expect(kubernetes.checkKubernetesStatus(makeBuild() as any)).resolves.toBe('');
      expect(mockDebug).toHaveBeenCalledWith('Error executing kubectl command');
      expect(mockGetLogger).toHaveBeenCalledWith({
        command: 'kubectl --namespace env-build-uuid get pods | grep build-uuid',
        error,
      });
    });

    it('merges an ingress banner with an existing snippet and writes the exact patch before applying it', async () => {
      mockMakeApiClient.mockReturnValue(mockNetworkingClient);
      mockReadNamespacedIngress.mockResolvedValue({
        body: {
          metadata: {
            annotations: {
              'nginx.ingress.kubernetes.io/configuration-snippet': 'set $existing yes;;;  ',
            },
          },
        },
      });
      const mkdir = jest.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
      const writeFile = jest.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);

      await kubernetes.patchIngress(
        'api-ingress',
        {
          metadata: {
            annotations: {
              'nginx.ingress.kubernetes.io/configuration-snippet': '  add_header X-Lifecycle true  ',
            },
          },
        },
        'env-build-uuid'
      );

      expect(mkdir).toHaveBeenCalledWith('/tmp/lifecycle/banner/', { recursive: true });
      expect(writeFile).toHaveBeenCalledWith(
        '/tmp/lifecycle/banner/api-ingress-banner.yaml',
        expect.any(String),
        'utf8'
      );
      expect(yaml.load(writeFile.mock.calls[0][1] as string)).toEqual({
        metadata: {
          annotations: {
            'nginx.ingress.kubernetes.io/configuration-snippet': 'set $existing yes;\nadd_header X-Lifecycle true;',
          },
        },
      });
      expect(mockShellPromise).toHaveBeenCalledWith(
        'kubectl patch ingress api-ingress --namespace env-build-uuid --type merge --patch-file /tmp/lifecycle/banner/api-ingress-banner.yaml'
      );
      expect(mockInfo).toHaveBeenCalledWith('Deploy: ingress patched');
    });

    it('creates a standalone semicolon-terminated ingress snippet when the ingress cannot be fetched', async () => {
      mockMakeApiClient.mockReturnValue(mockNetworkingClient);
      mockReadNamespacedIngress.mockRejectedValue(new Error('not found'));
      jest.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
      const writeFile = jest.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);

      await kubernetes.patchIngress(
        'new-ingress',
        { metadata: { annotations: { 'nginx.ingress.kubernetes.io/configuration-snippet': 'return 204;' } } },
        'env-build-uuid'
      );

      expect(yaml.load(writeFile.mock.calls[0][1] as string)).toEqual({
        metadata: {
          annotations: { 'nginx.ingress.kubernetes.io/configuration-snippet': 'return 204;' },
        },
      });
      expect(mockWarn).toHaveBeenCalledWith('Ingress: fetch failed');
    });

    it('logs and rethrows ingress patch failures', async () => {
      mockMakeApiClient.mockReturnValue(mockNetworkingClient);
      mockReadNamespacedIngress.mockResolvedValue({ body: {} });
      const error = new Error('disk full');
      jest.spyOn(fs.promises, 'mkdir').mockRejectedValue(error);

      await expect(kubernetes.patchIngress('api-ingress', {}, 'env-build-uuid')).rejects.toBe(error);
      expect(mockWarn).toHaveBeenCalledWith('Ingress: patch failed (banner may not work)');
      expect(mockGetLogger).toHaveBeenCalledWith({
        ingressName: 'api-ingress',
        namespace: 'env-build-uuid',
        error,
      });
    });

    it('base64-encodes new secret values while preserving existing data', async () => {
      const secret = { metadata: { name: 'runtime' }, data: { EXISTING: 'YWxyZWFkeQ==' } };
      mockReadNamespacedSecret.mockResolvedValue({ body: secret });

      await kubernetes.updateSecret('runtime', { TOKEN: 'secret', COUNT: 7 as any }, 'env-build-uuid');

      expect(mockReplaceNamespacedSecret).toHaveBeenCalledWith('runtime', 'env-build-uuid', {
        metadata: { name: 'runtime' },
        data: {
          EXISTING: 'YWxyZWFkeQ==',
          TOKEN: Buffer.from('secret').toString('base64'),
          COUNT: Buffer.from('7').toString('base64'),
        },
      });
    });

    it('logs and rethrows secret update failures', async () => {
      const error = new Error('secret forbidden');
      mockReadNamespacedSecret.mockRejectedValue(error);

      await expect(kubernetes.updateSecret('runtime', {}, 'env-build-uuid')).rejects.toBe(error);
      expect(mockError).toHaveBeenCalledWith('Secret: update failed');
      expect(mockGetLogger).toHaveBeenCalledWith({ secretName: 'runtime', namespace: 'env-build-uuid', error });
    });

    it('reads and trims the service-account namespace and falls back to default on read errors', () => {
      const readFile = jest.spyOn(fs, 'readFileSync').mockReturnValue(' lifecycle-system \n');
      expect(kubernetes.getCurrentNamespaceFromFile()).toBe('lifecycle-system');
      expect(readFile).toHaveBeenCalledWith('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8');

      const error = new Error('namespace file absent');
      readFile.mockImplementationOnce(() => {
        throw error;
      });
      expect(kubernetes.getCurrentNamespaceFromFile()).toBe('default');
      expect(mockError).toHaveBeenCalledWith('Namespace: file read failed');
    });
  });

  describe('deployment pod readiness summaries', () => {
    it('summarizes waiting, terminated, restarted, and fallback pod states while ignoring ready pods', () => {
      const longMessage = `  ${'failure '.repeat(30)}  `;
      const summary = kubernetes.summarizeDeployPodFailures([
        {
          metadata: { name: 'ready' },
          status: { conditions: [{ type: 'Ready', status: 'True' }] },
        },
        {
          metadata: { name: 'waiting' },
          status: {
            conditions: [{ type: 'Ready', status: 'False' }],
            initContainerStatuses: [
              {
                name: 'setup',
                restartCount: 2,
                ready: false,
                image: 'init',
                imageID: 'init',
                state: { waiting: { reason: 'CrashLoopBackOff', message: '  setup   failed  ' } },
              },
            ],
            containerStatuses: [
              {
                name: 'api',
                restartCount: 1,
                ready: false,
                image: 'api',
                imageID: 'api',
                state: { waiting: { reason: 'ImagePullBackOff' } },
                lastState: { terminated: { reason: 'Error', message: 'pull failed', exitCode: 1 } },
              },
            ],
          },
        },
        {
          metadata: { name: 'terminated' },
          status: {
            conditions: [{ type: 'Ready', status: 'False' }],
            containerStatuses: [
              {
                name: 'worker',
                restartCount: 0,
                ready: false,
                image: 'worker',
                imageID: 'worker',
                state: { terminated: { reason: 'Error', message: longMessage, exitCode: 0 } },
              },
            ],
          },
        },
        {
          metadata: {},
          status: { conditions: [{ type: 'Ready', status: 'False', message: ' readiness gate pending ' }] },
        },
      ] as any);

      expect(summary).toContain('pod waiting: init setup waiting=CrashLoopBackOff (setup failed) restarts=2');
      expect(summary).toContain('api waiting=ImagePullBackOff (pull failed) restarts=1');
      expect(summary).toContain('pod terminated: worker terminated=Error exit=0');
      expect(summary).toContain('…');
      expect(summary).toContain('pod unknown: readiness gate pending');
      expect(summary).not.toContain('pod ready');
    });

    it('falls back to pod phase for ContainerCreating, completed containers, and absent status', () => {
      const summary = kubernetes.summarizeDeployPodFailures([
        {
          metadata: { name: 'creating' },
          status: {
            phase: 'Pending',
            containerStatuses: [
              {
                name: 'api',
                restartCount: 0,
                ready: false,
                image: 'api',
                imageID: 'api',
                state: { waiting: { reason: 'ContainerCreating' } },
              },
            ],
          },
        },
        {
          metadata: { name: 'complete' },
          status: {
            phase: 'Succeeded',
            containerStatuses: [
              {
                name: 'job',
                restartCount: 0,
                ready: false,
                image: 'job',
                imageID: 'job',
                state: { terminated: { reason: 'Completed', exitCode: 0 } },
              },
            ],
          },
        },
        { metadata: { name: 'unknown' } },
      ] as any);

      expect(summary).toBe('pod creating: phase=Pending | pod complete: phase=Succeeded | pod unknown: phase=unknown');
      expect(kubernetes.summarizeDeployPodFailures([])).toBeUndefined();
    });

    it('reports an init container termination and a restart-only application cause', () => {
      expect(
        kubernetes.summarizeDeployPodFailures([
          {
            metadata: { name: 'api' },
            status: {
              initContainerStatuses: [
                {
                  name: 'setup',
                  restartCount: 0,
                  ready: false,
                  image: 'setup',
                  imageID: 'setup',
                  state: { terminated: { reason: 'Completed', exitCode: 0 } },
                },
              ],
              containerStatuses: [
                {
                  name: 'api',
                  restartCount: 3,
                  ready: false,
                  image: 'api',
                  imageID: 'api',
                  state: { running: {} },
                },
              ],
            },
          },
        ] as any)
      ).toBe('pod api: init setup terminated=Completed exit=0; api restarts=3');
    });

    it('summarizes missing container state and reason fields using stable fallbacks', () => {
      expect(
        kubernetes.summarizeDeployPodFailures([
          {
            status: {
              containerStatuses: [
                {
                  name: 'stateless',
                  restartCount: 2,
                  ready: false,
                  image: 'api',
                  imageID: 'api',
                },
                {
                  name: 'waiting',
                  restartCount: 0,
                  ready: false,
                  image: 'api',
                  imageID: 'api',
                  state: { waiting: {} },
                },
                {
                  name: 'terminated',
                  restartCount: 0,
                  ready: false,
                  image: 'api',
                  imageID: 'api',
                  state: { terminated: {} },
                },
              ],
            },
          },
        ] as any)
      ).toBe('pod unknown: stateless restarts=2; waiting waiting=unknown; terminated terminated=unknown');
    });

    it('uses a terminated last state when ContainerCreating is only the current transient state', () => {
      expect(
        kubernetes.summarizeDeployPodFailures([
          {
            metadata: { name: 'api' },
            status: {
              containerStatuses: [
                {
                  name: 'api',
                  restartCount: 2,
                  ready: false,
                  image: 'api',
                  imageID: 'api',
                  state: { waiting: { reason: 'ContainerCreating' } },
                  lastState: { terminated: { reason: 'Error', exitCode: 137, message: 'OOM killed' } },
                },
              ],
            },
          },
        ] as any)
      ).toBe('pod api: api terminated=Error exit=137 (OOM killed) restarts=2');
    });

    it('returns ready after application pods appear and all become ready, excluding deployment jobs', async () => {
      immediateTimers();
      const jobPod = { metadata: { name: 'api-deploy-job' }, status: { conditions: [] } };
      const applicationPod = {
        metadata: { name: 'api-abc' },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      };
      mockListNamespacedPod
        .mockResolvedValueOnce({ body: { items: [jobPod] } })
        .mockResolvedValueOnce({ body: { items: [jobPod, applicationPod] } })
        .mockResolvedValueOnce({ body: { items: [jobPod, applicationPod] } });

      await expect(kubernetes.waitForDeployPodReady(makeDeploy() as any)).resolves.toEqual({ ready: true });
      expect(mockListNamespacedPod).toHaveBeenCalledWith(
        'env-build-uuid',
        undefined,
        undefined,
        undefined,
        undefined,
        'deploy_uuid=deploy-uuid'
      );
      expect(mockInfo).toHaveBeenCalledWith('Deploy: pods ready');
    });

    it('uses an unknown service label when the optional deployable relation is not loaded', async () => {
      const applicationPod = {
        metadata: { name: 'api-abc' },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
      };
      mockListNamespacedPod.mockResolvedValue({ body: { items: [applicationPod] } });

      await expect(
        kubernetes.waitForDeployPodReady({ uuid: 'deploy-uuid', build: makeBuild(), deployable: undefined } as any)
      ).resolves.toEqual({ ready: true });
      expect(mockGetLogger).toHaveBeenCalledWith({
        deployUuid: 'deploy-uuid',
        service: 'unknown',
        namespace: 'env-build-uuid',
      });
    });

    it('returns a specific cause when no application pod appears in five minutes', async () => {
      immediateTimers();
      mockListNamespacedPod.mockResolvedValue({ body: { items: [] } });

      await expect(kubernetes.waitForDeployPodReady(makeDeploy() as any)).resolves.toEqual({
        ready: false,
        causeSummary:
          'no application pods appeared within 5m (label deploy_uuid=deploy-uuid in namespace env-build-uuid)',
      });
      expect(mockListNamespacedPod).toHaveBeenCalledTimes(60);
      expect(mockWarn).toHaveBeenCalledWith('Pod: not found timeout=5m');
    });

    it('reports when application pods disappear during readiness polling', async () => {
      const applicationPod = { metadata: { name: 'api-abc' }, status: { conditions: [] } };
      mockListNamespacedPod
        .mockResolvedValueOnce({ body: { items: [applicationPod] } })
        .mockResolvedValueOnce({ body: { items: [] } });

      await expect(kubernetes.waitForDeployPodReady(makeDeploy() as any)).resolves.toEqual({
        ready: false,
        causeSummary: 'deployment pods disappeared while waiting for readiness',
      });
      expect(mockWarn).toHaveBeenCalledWith('Pod: deployment pods not found');
    });

    it('handles an incomplete pod payload before that pod disappears', async () => {
      immediateTimers();
      const incompletePod = {};
      mockListNamespacedPod
        .mockResolvedValueOnce({ body: { items: [incompletePod] } })
        .mockResolvedValueOnce({ body: { items: [incompletePod] } })
        .mockResolvedValueOnce({ body: { items: [] } });

      await expect(kubernetes.waitForDeployPodReady(makeDeploy() as any)).resolves.toEqual({
        ready: false,
        causeSummary: 'deployment pods disappeared while waiting for readiness',
      });
      expect(mockListNamespacedPod).toHaveBeenCalledTimes(3);
    });

    it('returns the last observed failure causes after a 15-minute readiness timeout', async () => {
      immediateTimers();
      const applicationPod = {
        metadata: { name: 'api-abc' },
        status: {
          conditions: [{ type: 'Ready', status: 'False' }],
          containerStatuses: [
            {
              name: 'api',
              restartCount: 4,
              ready: false,
              image: 'api',
              imageID: 'api',
              state: { waiting: { reason: 'CrashLoopBackOff', message: 'process exited' } },
            },
          ],
        },
      };
      mockListNamespacedPod.mockResolvedValue({ body: { items: [applicationPod] } });

      await expect(kubernetes.waitForDeployPodReady(makeDeploy() as any)).resolves.toEqual({
        ready: false,
        causeSummary: 'pod api-abc: api waiting=CrashLoopBackOff (process exited) restarts=4',
      });
      expect(mockListNamespacedPod).toHaveBeenCalledTimes(181);
      expect(mockWarn).toHaveBeenCalledWith('Pod: not ready timeout=15m');
    });
  });
});
