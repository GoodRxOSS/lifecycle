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

var mockCreateNamespacedConfigMap: jest.Mock;
var mockCreateNamespacedJob: jest.Mock;
var mockGetAllConfigs: jest.Mock;
var mockWaitForJobAndGetLogs: jest.Mock;
var mockGetLogger: jest.Mock;
var mockInfo: jest.Mock;
var mockError: jest.Mock;

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  mockCreateNamespacedConfigMap = jest.fn();
  mockCreateNamespacedJob = jest.fn();
  const coreApi = {
    createNamespacedConfigMap: (...args: unknown[]) => mockCreateNamespacedConfigMap(...args),
  };
  const batchApi = {
    createNamespacedJob: (...args: unknown[]) => mockCreateNamespacedJob(...args),
  };

  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn((client: unknown) => {
        if (client === actual.CoreV1Api) return coreApi;
        if (client === actual.BatchV1Api) return batchApi;
        return {};
      }),
    })),
  };
});

jest.mock('server/services/globalConfig', () => {
  mockGetAllConfigs = jest.fn();
  return {
    __esModule: true,
    default: { getInstance: () => ({ getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args) }) },
  };
});

jest.mock('server/lib/kubernetes/JobMonitor', () => {
  mockWaitForJobAndGetLogs = jest.fn();
  return {
    JobMonitor: {
      waitForJobAndGetLogs: (...args: unknown[]) => mockWaitForJobAndGetLogs(...args),
    },
  };
});

jest.mock('server/lib/logger', () => {
  mockInfo = jest.fn();
  mockError = jest.fn();
  mockGetLogger = jest.fn(() => ({ info: mockInfo, error: mockError }));
  return { getLogger: (...args: unknown[]) => mockGetLogger(...args) };
});

import { HttpError } from '@kubernetes/client-node';
import { createKubernetesApplyJob, getKubernetesApplyJobName, monitorKubernetesJob } from './applyManifest';

function deploy(overrides: Record<string, unknown> = {}) {
  return {
    id: 37,
    uuid: 'catalog-deploy-uuid',
    sha: 'abcdef0123456789',
    manifest: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: catalog\n',
    build: { uuid: 'build-uuid' },
    deployable: { name: 'catalog' },
    ...overrides,
  } as any;
}

describe('Kubernetes apply jobs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateNamespacedConfigMap.mockResolvedValue({ body: {} });
    mockCreateNamespacedJob.mockResolvedValue({ body: { metadata: { uid: 'created-job-uid' } } });
    mockGetAllConfigs.mockResolvedValue({ serviceAccount: { name: 'lifecycle-apply' } });
    mockWaitForJobAndGetLogs.mockResolvedValue({ success: true, logs: 'applied' });
  });

  it('derives the Kubernetes-safe deploy job name and uses unknown when the SHA is absent', () => {
    expect(getKubernetesApplyJobName(deploy(), 'j123')).toBe('catalog-deploy-uuid-deploy-j123-abcdef0');
    expect(getKubernetesApplyJobName(deploy({ sha: undefined }), 'j123')).toBe(
      'catalog-deploy-uuid-deploy-j123-unknown'
    );
  });

  it('creates the manifest ConfigMap and a bounded apply Job with the required identity and mount', async () => {
    const input = deploy();

    const result = await createKubernetesApplyJob({ deploy: input, namespace: 'env-build', jobId: 'j123' });

    expect(result).toEqual({ metadata: { uid: 'created-job-uid' } });
    expect(mockCreateNamespacedConfigMap).toHaveBeenCalledWith('env-build', {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: 'catalog-deploy-uuid-deploy-j123-abcdef0-manifest',
        namespace: 'env-build',
        labels: {
          'app.kubernetes.io/managed-by': 'lifecycle',
          lc_uuid: 'build-uuid',
          deploy_uuid: 'catalog-deploy-uuid',
          app: 'lifecycle-deploy',
        },
      },
      data: { 'manifest.yaml': input.manifest },
    });

    const createdJob = mockCreateNamespacedJob.mock.calls[0][1];
    expect(mockCreateNamespacedJob).toHaveBeenCalledWith('env-build', expect.any(Object));
    expect(createdJob.metadata).toEqual({
      name: 'catalog-deploy-uuid-deploy-j123-abcdef0',
      namespace: 'env-build',
      labels: {
        'app.kubernetes.io/managed-by': 'lifecycle',
        lc_uuid: 'build-uuid',
        deploy_uuid: 'catalog-deploy-uuid',
        app: 'lifecycle-deploy',
        type: 'kubernetes-apply',
        service: 'catalog',
      },
      annotations: {
        'lifecycle/deploy-id': '37',
        'lifecycle/job-type': 'kubernetes-apply',
        'lifecycle/service-name': 'catalog',
      },
    });
    expect(createdJob.spec).toMatchObject({
      ttlSecondsAfterFinished: 86400,
      activeDeadlineSeconds: 540,
      backoffLimit: 0,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/managed-by': 'lifecycle',
            lc_uuid: 'build-uuid',
            deploy_uuid: 'catalog-deploy-uuid',
            'job-name': 'catalog-deploy-uuid-deploy-j123-abcdef0',
            service: 'catalog',
          },
        },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: 'lifecycle-apply',
          volumes: [
            {
              name: 'manifest',
              configMap: {
                name: 'catalog-deploy-uuid-deploy-j123-abcdef0-manifest',
                items: [{ key: 'manifest.yaml', path: 'manifest.yaml' }],
              },
            },
          ],
        },
      },
    });
    expect(createdJob.spec.template.spec.containers).toEqual([
      {
        name: 'kubectl-apply',
        image: 'bitnamilegacy/kubectl:1.30',
        command: ['/bin/bash', '-c'],
        args: [expect.any(String)],
        volumeMounts: [{ name: 'manifest', mountPath: '/manifests', readOnly: true }],
        resources: {
          requests: { memory: '128Mi', cpu: '100m' },
          limits: { memory: '256Mi', cpu: '200m' },
        },
      },
    ]);
    const applyScript = createdJob.spec.template.spec.containers[0].args[0];
    expect(applyScript).toContain('set -e');
    expect(applyScript).toContain('kubectl apply -f /manifests/manifest.yaml');
    expect(applyScript).toContain('kubectl get deployment catalog-deploy-uuid -n env-build');
    expect(applyScript).toContain('kubectl rollout restart deployment/catalog-deploy-uuid -n env-build');
  });

  it('falls back to the default service account and omits an empty service label', async () => {
    mockGetAllConfigs.mockResolvedValue({});

    await createKubernetesApplyJob({
      deploy: deploy({ deployable: undefined }),
      namespace: 'env-build',
      jobId: 'j123',
    });

    const createdJob = mockCreateNamespacedJob.mock.calls[0][1];
    expect(createdJob.metadata.labels.service).toBeUndefined();
    expect(createdJob.spec.template.metadata.labels.service).toBeUndefined();
    expect(createdJob.metadata.annotations['lifecycle/service-name']).toBe('');
    expect(createdJob.spec.template.spec.serviceAccountName).toBe('default');
  });

  it('rejects a deploy without a manifest before creating either Kubernetes resource', async () => {
    await expect(
      createKubernetesApplyJob({ deploy: deploy({ manifest: '' }), namespace: 'env-build', jobId: 'j123' })
    ).rejects.toThrow('Deploy catalog-deploy-uuid has no manifest');
    expect(mockCreateNamespacedConfigMap).not.toHaveBeenCalled();
    expect(mockCreateNamespacedJob).not.toHaveBeenCalled();
  });

  it('logs the status and rethrows an HTTP ConfigMap creation failure', async () => {
    const failure = new HttpError({ statusCode: 422 } as any, { message: 'invalid manifest' }, 422);
    mockCreateNamespacedConfigMap.mockRejectedValue(failure);

    await expect(createKubernetesApplyJob({ deploy: deploy(), namespace: 'env-build', jobId: 'j123' })).rejects.toBe(
      failure
    );
    expect(mockGetLogger).toHaveBeenCalledWith({ error: failure });
    expect(mockError).toHaveBeenCalledWith(
      'Failed to create ConfigMap: configMapName=catalog-deploy-uuid-deploy-j123-abcdef0-manifest statusCode=422'
    );
    expect(mockCreateNamespacedJob).not.toHaveBeenCalled();
  });

  it('rethrows a non-HTTP ConfigMap failure without misclassifying it', async () => {
    const failure = new Error('connection reset');
    mockCreateNamespacedConfigMap.mockRejectedValue(failure);

    await expect(createKubernetesApplyJob({ deploy: deploy(), namespace: 'env-build', jobId: 'j123' })).rejects.toBe(
      failure
    );
    expect(mockGetLogger).not.toHaveBeenCalledWith({ error: failure });
    expect(mockCreateNamespacedJob).not.toHaveBeenCalled();
  });

  it('maps successful and failed monitor results using the requested polling budget and apply container', async () => {
    mockWaitForJobAndGetLogs.mockResolvedValueOnce({
      success: true,
      logs: 'resources applied',
      status: 'succeeded',
      startedAt: '2026-08-27T18:00:00.000Z',
      completedAt: '2026-08-27T18:00:05.000Z',
      duration: 5,
    });

    await expect(monitorKubernetesJob('apply-job', 'env-build', 3)).resolves.toEqual({
      success: true,
      message: 'Kubernetes resources applied successfully',
      logs: 'resources applied',
      status: 'succeeded',
      startedAt: '2026-08-27T18:00:00.000Z',
      completedAt: '2026-08-27T18:00:05.000Z',
      duration: 5,
    });
    expect(mockWaitForJobAndGetLogs).toHaveBeenCalledWith('apply-job', 'env-build', 15, ['kubectl-apply']);

    mockWaitForJobAndGetLogs.mockResolvedValueOnce({ success: false, logs: 'apply failed', status: 'failed' });
    await expect(monitorKubernetesJob('failed-job', 'env-build')).resolves.toEqual({
      success: false,
      message: 'Kubernetes apply job failed',
      logs: 'apply failed',
      status: 'failed',
      startedAt: undefined,
      completedAt: undefined,
      duration: undefined,
    });
    expect(mockWaitForJobAndGetLogs).toHaveBeenLastCalledWith('failed-job', 'env-build', 600, ['kubectl-apply']);
  });

  it('logs and rethrows an unexpected monitor failure', async () => {
    const failure = new Error('monitor unavailable');
    mockWaitForJobAndGetLogs.mockRejectedValue(failure);

    await expect(monitorKubernetesJob('apply-job', 'env-build')).rejects.toBe(failure);
    expect(mockGetLogger).toHaveBeenCalledWith({ error: failure });
    expect(mockError).toHaveBeenCalledWith('Job: monitor failed name=apply-job');
  });
});
