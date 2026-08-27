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

import * as k8s from '@kubernetes/client-node';

const mockReadDeployment = jest.fn();
const mockListDeployments = jest.fn();
const mockReadService = jest.fn();
const mockListServices = jest.fn();
const mockPatchDeployment = jest.fn();
const mockPatchService = jest.fn();
const mockReadHorizontalPodAutoscaler = jest.fn();
const mockListHorizontalPodAutoscalers = jest.fn();
const mockPatchHorizontalPodAutoscaler = jest.fn();

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockImplementation((apiClass: any) => {
        if (apiClass === actual.AppsV1Api) {
          return {
            readNamespacedDeployment: mockReadDeployment,
            listNamespacedDeployment: mockListDeployments,
            patchNamespacedDeployment: mockPatchDeployment,
          };
        }
        if (apiClass === actual.CoreV1Api) {
          return {
            readNamespacedService: mockReadService,
            listNamespacedService: mockListServices,
            patchNamespacedService: mockPatchService,
          };
        }
        if (apiClass === actual.AutoscalingV2Api) {
          return {
            readNamespacedHorizontalPodAutoscaler: mockReadHorizontalPodAutoscaler,
            listNamespacedHorizontalPodAutoscaler: mockListHorizontalPodAutoscalers,
            patchNamespacedHorizontalPodAutoscaler: mockPatchHorizontalPodAutoscaler,
          };
        }
        return {};
      }),
    })),
  };
});

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { DevModeManager, DevModeOptions } from '../devModeManager';

describe('DevModeManager', () => {
  let manager: DevModeManager;

  const notFound = () => new k8s.HttpError({ statusCode: 404 } as any, 'not found', 404);
  const devModeOptions = (overrides: Partial<DevModeOptions> = {}): DevModeOptions => ({
    namespace: 'test-ns',
    deploymentName: 'my-app',
    serviceName: 'my-app',
    pvcName: 'agent-pvc-abc',
    devConfig: { image: 'node:20-slim', command: 'pnpm dev' },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockReadDeployment.mockResolvedValue({
      body: {
        spec: {
          template: {
            spec: {
              containers: [{ name: 'web-app' }],
            },
          },
        },
      },
    });
    mockListDeployments.mockResolvedValue({ body: { items: [] } });
    mockReadService.mockResolvedValue({
      body: {
        metadata: { name: 'my-app-svc' },
        spec: {
          ports: [{ name: 'http', port: 8080, protocol: 'TCP' }],
        },
      },
    });
    mockListServices.mockResolvedValue({ body: { items: [] } });
    mockReadHorizontalPodAutoscaler.mockRejectedValue(new k8s.HttpError({ statusCode: 404 } as any, 'not found', 404));
    mockListHorizontalPodAutoscalers.mockResolvedValue({ body: { items: [] } });
    mockPatchDeployment.mockResolvedValue({});
    mockPatchService.mockResolvedValue({});
    mockPatchHorizontalPodAutoscaler.mockResolvedValue({});
    manager = new DevModeManager();
  });

  it('patches deployment with dev image and PVC', async () => {
    const opts: DevModeOptions = {
      namespace: 'test-ns',
      deploymentName: 'my-app',
      serviceName: 'my-app',
      pvcName: 'agent-pvc-abc',
      devConfig: { image: 'node:20-slim', command: 'pnpm dev', workDir: '/workspace' },
      requiredNodeName: 'agent-node-a',
    };

    await manager.enableDevMode(opts);

    expect(mockPatchDeployment).toHaveBeenCalledWith(
      'my-app',
      'test-ns',
      expect.objectContaining({
        metadata: {
          annotations: expect.objectContaining({
            'lifecycle.goodrx.com/dev-mode-deployment-snapshot': expect.any(String),
          }),
        },
        spec: expect.objectContaining({
          replicas: 1,
          template: {
            spec: {
              nodeSelector: { 'kubernetes.io/hostname': 'agent-node-a' },
              securityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
              volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: 'agent-pvc-abc' } }],
              containers: [
                expect.objectContaining({
                  name: 'web-app',
                  image: 'node:20-slim',
                  command: ['/bin/sh', '-c', 'pnpm dev'],
                  workingDir: '/workspace',
                  volumeMounts: [{ name: 'workspace', mountPath: '/workspace', subPath: 'repo' }],
                }),
              ],
            },
          },
        }),
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  });

  it('merges the required agent node with an existing deployment nodeSelector', async () => {
    mockReadDeployment.mockResolvedValue({
      body: {
        spec: {
          template: {
            spec: {
              nodeSelector: { 'app-long': 'deployments-m7i' },
              containers: [{ name: 'web-app' }],
            },
          },
        },
      },
    });

    const opts: DevModeOptions = {
      namespace: 'test-ns',
      deploymentName: 'my-app',
      serviceName: 'my-app',
      pvcName: 'agent-pvc-abc',
      devConfig: { image: 'node:20-slim', command: 'pnpm dev', workDir: '/workspace' },
      requiredNodeName: 'agent-node-a',
    };

    await manager.enableDevMode(opts);

    const patchBody = mockPatchDeployment.mock.calls[0][2];
    expect(patchBody.spec.template.spec.nodeSelector).toEqual({
      'app-long': 'deployments-m7i',
      'kubernetes.io/hostname': 'agent-node-a',
    });
  });

  it('preserves existing pod securityContext fields while normalizing shared workspace ownership', async () => {
    mockReadDeployment.mockResolvedValue({
      body: {
        spec: {
          template: {
            spec: {
              securityContext: {
                fsGroup: 2000,
                runAsNonRoot: false,
                supplementalGroups: [2000],
              },
              containers: [{ name: 'web-app' }],
            },
          },
        },
      },
    });

    const opts: DevModeOptions = {
      namespace: 'test-ns',
      deploymentName: 'my-app',
      serviceName: 'my-app',
      pvcName: 'agent-pvc-abc',
      devConfig: { image: 'node:20-slim', command: 'pnpm dev', workDir: '/workspace' },
    };

    await manager.enableDevMode(opts);

    const patchBody = mockPatchDeployment.mock.calls[0][2];
    expect(patchBody.spec.template.spec.securityContext).toEqual({
      fsGroup: 1000,
      fsGroupChangePolicy: 'OnRootMismatch',
      runAsNonRoot: false,
      supplementalGroups: [2000],
    });
  });

  it('mounts the shared workspace root when workDir points at a service subdirectory', async () => {
    const opts: DevModeOptions = {
      namespace: 'test-ns',
      deploymentName: 'my-app',
      serviceName: 'my-app',
      pvcName: 'agent-pvc-abc',
      devConfig: { image: 'node:20-slim', command: 'node --watch app.js', workDir: '/workspace/my-express-app' },
    };

    await manager.enableDevMode(opts);

    const patchBody = mockPatchDeployment.mock.calls[0][2];
    expect(patchBody.spec.template.spec.containers[0].workingDir).toBe('/workspace/my-express-app');
    expect(patchBody.spec.template.spec.containers[0].volumeMounts).toEqual([
      { name: 'workspace', mountPath: '/workspace', subPath: 'repo' },
    ]);
  });

  it('patches service targetPort when dev ports specified', async () => {
    const opts: DevModeOptions = {
      namespace: 'test-ns',
      deploymentName: 'my-app',
      serviceName: 'my-app-svc',
      pvcName: 'agent-pvc-abc',
      devConfig: { image: 'node:20-slim', command: 'pnpm dev', ports: [3000] },
    };

    await manager.enableDevMode(opts);

    expect(mockPatchService).toHaveBeenCalledWith(
      'my-app-svc',
      'test-ns',
      expect.objectContaining({
        metadata: {
          annotations: {
            'lifecycle.goodrx.com/dev-mode-service-snapshot': expect.any(String),
          },
        },
        spec: {
          ports: [{ name: 'http', port: 8080, protocol: 'TCP', targetPort: 3000 }],
        },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  });

  it('does not patch service when no dev ports specified', async () => {
    const opts: DevModeOptions = {
      namespace: 'test-ns',
      deploymentName: 'my-app',
      serviceName: 'my-app-svc',
      pvcName: 'agent-pvc-abc',
      devConfig: { image: 'node:20-slim', command: 'pnpm dev' },
    };

    await manager.enableDevMode(opts);

    expect(mockPatchService).not.toHaveBeenCalled();
  });

  it('reads actual container name from existing deployment', async () => {
    mockReadDeployment.mockResolvedValue({
      body: {
        spec: {
          template: {
            spec: {
              containers: [{ name: 'custom-container' }],
            },
          },
        },
      },
    });

    const opts: DevModeOptions = {
      namespace: 'test-ns',
      deploymentName: 'my-app',
      serviceName: 'my-app',
      pvcName: 'agent-pvc-abc',
      devConfig: { image: 'node:20-slim', command: 'pnpm dev' },
    };

    await manager.enableDevMode(opts);

    const patchBody = mockPatchDeployment.mock.calls[0][2];
    expect(patchBody.spec.template.spec.containers[0].name).toBe('custom-container');
  });

  it('uses default workDir when not specified in devConfig', async () => {
    const opts: DevModeOptions = {
      namespace: 'test-ns',
      deploymentName: 'my-app',
      serviceName: 'my-app',
      pvcName: 'agent-pvc-abc',
      devConfig: { image: 'node:20-slim', command: 'pnpm dev' },
    };

    await manager.enableDevMode(opts);

    const patchBody = mockPatchDeployment.mock.calls[0][2];
    expect(patchBody.spec.template.spec.containers[0].workingDir).toBe('/workspace');
  });

  it('maps devConfig env to k8s env format', async () => {
    const opts: DevModeOptions = {
      namespace: 'test-ns',
      deploymentName: 'my-app',
      serviceName: 'my-app',
      pvcName: 'agent-pvc-abc',
      devConfig: {
        image: 'node:20-slim',
        command: 'pnpm dev',
        env: { NODE_ENV: 'development', PORT: '3000' },
      },
    };

    await manager.enableDevMode(opts);

    const patchBody = mockPatchDeployment.mock.calls[0][2];
    expect(patchBody.spec.template.spec.containers[0].env).toEqual(
      expect.arrayContaining([
        { name: 'NODE_ENV', value: 'development' },
        { name: 'PORT', value: '3000' },
      ])
    );
  });

  it('captures the original replica count in the deployment snapshot', async () => {
    mockReadDeployment.mockResolvedValue({
      body: {
        metadata: { name: 'my-app' },
        spec: {
          replicas: 3,
          template: {
            spec: {
              securityContext: { fsGroup: 2000, supplementalGroups: [2000] },
              containers: [{ name: 'web-app', image: 'registry.example/my-app:built' }],
            },
          },
        },
      },
    });

    const opts: DevModeOptions = {
      namespace: 'test-ns',
      deploymentName: 'my-app',
      serviceName: 'my-app',
      pvcName: 'agent-pvc-abc',
      devConfig: { image: 'node:20-slim', command: 'pnpm dev' },
    };

    const snapshot = await manager.enableDevMode(opts);

    expect(snapshot.deployment.replicas).toBe(3);
    expect(snapshot.deployment.securityContext).toEqual({
      fsGroup: 2000,
      supplementalGroups: [2000],
    });
  });

  it('pins an attached HorizontalPodAutoscaler to a single replica during dev mode', async () => {
    mockListHorizontalPodAutoscalers.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'my-app-hpa' },
            spec: {
              minReplicas: 2,
              maxReplicas: 5,
              scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'my-app' },
            },
          },
        ],
      },
    });

    const opts: DevModeOptions = {
      namespace: 'test-ns',
      deploymentName: 'my-app',
      serviceName: 'my-app',
      pvcName: 'agent-pvc-abc',
      devConfig: { image: 'node:20-slim', command: 'pnpm dev' },
    };

    const snapshot = await manager.enableDevMode(opts);

    expect(snapshot.horizontalPodAutoscaler).toEqual({
      hpaName: 'my-app-hpa',
      minReplicas: 2,
      maxReplicas: 5,
    });
    expect(mockPatchHorizontalPodAutoscaler).toHaveBeenCalledWith(
      'my-app-hpa',
      'test-ns',
      {
        spec: {
          minReplicas: 1,
          maxReplicas: 1,
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
    expect(mockPatchHorizontalPodAutoscaler.mock.invocationCallOrder[0]).toBeLessThan(
      mockPatchDeployment.mock.invocationCallOrder[0]
    );
  });

  it('removes dev-mode-only deployment fields not present in last-applied configuration', async () => {
    mockReadDeployment.mockResolvedValue({
      body: {
        metadata: {
          name: 'my-app-resolved',
          annotations: {
            'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({
              spec: {
                template: {
                  spec: {
                    containers: [
                      {
                        name: 'web-app',
                        volumeMounts: [{ name: 'config-volume', mountPath: '/config' }],
                      },
                    ],
                    securityContext: { fsGroup: 2000 },
                    volumes: [{ name: 'config-volume' }],
                  },
                },
              },
            }),
          },
        },
        spec: {
          replicas: 1,
          template: {
            spec: {
              securityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
              containers: [
                {
                  name: 'web-app',
                  command: ['/bin/sh', '-c', 'npm run dev'],
                  workingDir: '/workspace/my-express-app',
                  volumeMounts: [
                    { name: 'workspace', mountPath: '/workspace', subPath: 'repo' },
                    { name: 'config-volume', mountPath: '/config' },
                  ],
                },
              ],
              nodeSelector: { 'kubernetes.io/hostname': 'agent-node-a' },
              volumes: [
                { name: 'workspace', persistentVolumeClaim: { claimName: 'agent-pvc-abc' } },
                { name: 'config-volume', emptyDir: {} },
              ],
            },
          },
        },
      },
    });

    await manager.disableDevMode('test-ns', 'my-app');

    expect(mockPatchDeployment).toHaveBeenCalledWith(
      'my-app-resolved',
      'test-ns',
      [
        { op: 'remove', path: '/spec/template/spec/containers/0/command' },
        { op: 'remove', path: '/spec/template/spec/containers/0/workingDir' },
        { op: 'remove', path: '/spec/template/spec/containers/0/volumeMounts/0' },
        { op: 'remove', path: '/spec/template/spec/volumes/0' },
        { op: 'remove', path: '/spec/replicas' },
        { op: 'remove', path: '/spec/template/spec/nodeSelector' },
        { op: 'replace', path: '/spec/template/spec/securityContext', value: { fsGroup: 2000 } },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/json-patch+json' } }
    );
  });

  it('preserves deployment fields that are present in last-applied configuration', async () => {
    mockReadDeployment.mockResolvedValue({
      body: {
        metadata: {
          name: 'my-app-resolved',
          annotations: {
            'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({
              spec: {
                replicas: 1,
                template: {
                  spec: {
                    containers: [
                      {
                        name: 'web-app',
                        command: ['/bin/sh', '-c', 'node server.js'],
                        workingDir: '/app',
                        volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
                      },
                    ],
                    volumes: [{ name: 'workspace' }],
                  },
                },
              },
            }),
          },
        },
        spec: {
          replicas: 1,
          template: {
            spec: {
              containers: [
                {
                  name: 'web-app',
                  command: ['/bin/sh', '-c', 'node server.js'],
                  workingDir: '/app',
                  volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
                },
              ],
              volumes: [{ name: 'workspace', emptyDir: {} }],
            },
          },
        },
      },
    });

    await manager.disableDevMode('test-ns', 'my-app');

    expect(mockPatchDeployment).not.toHaveBeenCalled();
  });

  it('restores deployment fields from dev mode snapshot annotations', async () => {
    mockReadDeployment.mockResolvedValue({
      body: {
        metadata: {
          name: 'grpc-echo-resolved',
          annotations: {
            'lifecycle.goodrx.com/dev-mode-deployment-snapshot': JSON.stringify({
              deploymentName: 'grpc-echo-resolved',
              containerName: 'grpc-echo',
              replicas: 3,
              image: 'registry.example/grpc-echo:built',
              env: [
                { name: 'COMPONENT', value: 'app' },
                { name: 'ENV', value: 'lifecycle' },
              ],
              volumeMounts: [{ name: 'config-volume', mountPath: '/config' }],
              volumes: [{ name: 'config-volume', emptyDir: {} }],
              nodeSelector: { 'app-long': 'deployments-m7i' },
              securityContext: { fsGroup: 2000 },
            }),
            'lifecycle.goodrx.com/dev-mode-hpa-snapshot': JSON.stringify({
              hpaName: 'grpc-echo-hpa',
              minReplicas: 2,
              maxReplicas: 5,
            }),
          },
        },
        spec: {
          replicas: 1,
          template: {
            spec: {
              securityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
              nodeSelector: {
                'app-long': 'deployments-m7i',
                'kubernetes.io/hostname': 'agent-node-a',
              },
              containers: [
                {
                  name: 'grpc-echo',
                  image: 'golang:1.20',
                  command: ['/bin/sh', '-c', 'go run ./server.go'],
                  workingDir: '/workspace/grpc-echo',
                  env: [],
                  volumeMounts: [
                    { name: 'workspace', mountPath: '/workspace', subPath: 'repo' },
                    { name: 'config-volume', mountPath: '/config' },
                  ],
                },
              ],
              volumes: [
                { name: 'workspace', persistentVolumeClaim: { claimName: 'agent-pvc-abc' } },
                { name: 'config-volume', emptyDir: {} },
              ],
            },
          },
        },
      },
    });
    mockReadHorizontalPodAutoscaler.mockResolvedValue({
      body: {
        metadata: { name: 'grpc-echo-hpa' },
        spec: {
          minReplicas: 1,
          maxReplicas: 1,
          scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'grpc-echo-resolved' },
        },
      },
    });

    await manager.disableDevMode('test-ns', 'grpc-echo');

    expect(mockPatchDeployment).toHaveBeenCalledWith(
      'grpc-echo-resolved',
      'test-ns',
      [
        {
          op: 'remove',
          path: '/metadata/annotations/lifecycle.goodrx.com~1dev-mode-deployment-snapshot',
        },
        {
          op: 'remove',
          path: '/metadata/annotations/lifecycle.goodrx.com~1dev-mode-hpa-snapshot',
        },
        {
          op: 'replace',
          path: '/spec/template/spec/containers/0/image',
          value: 'registry.example/grpc-echo:built',
        },
        { op: 'replace', path: '/spec/replicas', value: 3 },
        { op: 'remove', path: '/spec/template/spec/containers/0/command' },
        { op: 'remove', path: '/spec/template/spec/containers/0/workingDir' },
        {
          op: 'replace',
          path: '/spec/template/spec/containers/0/env',
          value: [
            { name: 'COMPONENT', value: 'app' },
            { name: 'ENV', value: 'lifecycle' },
          ],
        },
        {
          op: 'replace',
          path: '/spec/template/spec/containers/0/volumeMounts',
          value: [{ name: 'config-volume', mountPath: '/config' }],
        },
        {
          op: 'replace',
          path: '/spec/template/spec/volumes',
          value: [{ name: 'config-volume', emptyDir: {} }],
        },
        {
          op: 'replace',
          path: '/spec/template/spec/nodeSelector',
          value: { 'app-long': 'deployments-m7i' },
        },
        {
          op: 'replace',
          path: '/spec/template/spec/securityContext',
          value: { fsGroup: 2000 },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/json-patch+json' } }
    );
    expect(mockPatchHorizontalPodAutoscaler).toHaveBeenCalledWith(
      'grpc-echo-hpa',
      'test-ns',
      {
        spec: {
          minReplicas: 2,
          maxReplicas: 5,
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  });

  it('falls back to removing dev-mode-only deployment fields when last-applied annotation is missing', async () => {
    mockReadDeployment.mockResolvedValue({
      body: {
        metadata: {
          name: 'grpc-echo-resolved',
          annotations: {
            'meta.helm.sh/release-name': 'grpc-echo',
          },
        },
        spec: {
          replicas: 1,
          template: {
            spec: {
              securityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
              containers: [
                {
                  name: 'grpc-echo',
                  image: 'registry.example/grpc-echo:built',
                  command: ['/bin/sh', '-c', 'go run ./server.go'],
                  workingDir: '/workspace/grpc-echo',
                  volumeMounts: [
                    { name: 'workspace', mountPath: '/workspace', subPath: 'repo' },
                    { name: 'config-volume', mountPath: '/config' },
                  ],
                },
              ],
              nodeSelector: { 'kubernetes.io/hostname': 'agent-node-a' },
              volumes: [
                { name: 'workspace', persistentVolumeClaim: { claimName: 'agent-pvc-abc' } },
                { name: 'config-volume', emptyDir: {} },
              ],
            },
          },
        },
      },
    });

    await manager.disableDevMode('test-ns', 'grpc-echo');

    expect(mockPatchDeployment).toHaveBeenCalledWith(
      'grpc-echo-resolved',
      'test-ns',
      [
        { op: 'remove', path: '/spec/template/spec/containers/0/command' },
        { op: 'remove', path: '/spec/template/spec/containers/0/workingDir' },
        { op: 'remove', path: '/spec/template/spec/containers/0/volumeMounts/0' },
        { op: 'remove', path: '/spec/template/spec/volumes/0' },
        { op: 'remove', path: '/spec/template/spec/nodeSelector' },
        { op: 'remove', path: '/spec/template/spec/securityContext' },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/json-patch+json' } }
    );
  });

  it('restores deployment and service fields from an explicit snapshot', async () => {
    mockReadDeployment.mockResolvedValue({
      body: {
        metadata: {
          name: 'grpc-echo-resolved',
          annotations: {
            'meta.helm.sh/release-name': 'grpc-echo',
          },
        },
        spec: {
          replicas: 1,
          template: {
            spec: {
              securityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
              containers: [
                {
                  name: 'lc-apps',
                  image: 'registry.example/grpc-echo:dev',
                  command: ['/bin/sh', '-c', 'go run ./server.go'],
                  workingDir: '/workspace/grpc-echo',
                  env: [{ name: 'DEV_ONLY', value: 'true' }],
                  volumeMounts: [{ name: 'workspace', mountPath: '/workspace', subPath: 'repo' }],
                },
              ],
              nodeSelector: {
                'app-long': 'deployments-m7i',
                'kubernetes.io/hostname': 'agent-node-a',
              },
              volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: 'agent-pvc-abc' } }],
            },
          },
        },
      },
    });
    mockReadService.mockResolvedValue({
      body: {
        metadata: { name: 'grpc-echo-service' },
        spec: {
          ports: [{ name: 'tcp', port: 8080, targetPort: 8080, protocol: 'TCP' }],
        },
      },
    });
    mockReadHorizontalPodAutoscaler.mockResolvedValue({
      body: {
        metadata: { name: 'grpc-echo-hpa' },
        spec: {
          minReplicas: 1,
          maxReplicas: 1,
          scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'grpc-echo-resolved' },
        },
      },
    });

    await manager.disableDevMode('test-ns', 'grpc-echo', 'grpc-echo', {
      deployment: {
        deploymentName: 'grpc-echo-resolved',
        containerName: 'lc-apps',
        replicas: 2,
        image: 'registry.example/grpc-echo:built',
        command: null,
        workingDir: null,
        env: null,
        volumeMounts: null,
        volumes: null,
        nodeSelector: { 'app-long': 'deployments-m7i' },
        securityContext: { fsGroup: 2000 },
      },
      service: {
        serviceName: 'grpc-echo-service',
        ports: [{ name: 'tcp', port: 8080, targetPort: 8080, protocol: 'TCP' }],
      },
      horizontalPodAutoscaler: {
        hpaName: 'grpc-echo-hpa',
        minReplicas: 2,
        maxReplicas: 4,
      },
    });

    expect(mockPatchDeployment).toHaveBeenCalledWith(
      'grpc-echo-resolved',
      'test-ns',
      [
        {
          op: 'replace',
          path: '/spec/template/spec/containers/0/image',
          value: 'registry.example/grpc-echo:built',
        },
        { op: 'replace', path: '/spec/replicas', value: 2 },
        { op: 'remove', path: '/spec/template/spec/containers/0/command' },
        { op: 'remove', path: '/spec/template/spec/containers/0/workingDir' },
        { op: 'remove', path: '/spec/template/spec/containers/0/env' },
        { op: 'remove', path: '/spec/template/spec/containers/0/volumeMounts' },
        { op: 'remove', path: '/spec/template/spec/volumes' },
        {
          op: 'replace',
          path: '/spec/template/spec/nodeSelector',
          value: { 'app-long': 'deployments-m7i' },
        },
        {
          op: 'replace',
          path: '/spec/template/spec/securityContext',
          value: { fsGroup: 2000 },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/json-patch+json' } }
    );
    expect(mockPatchService).toHaveBeenCalledWith(
      'grpc-echo-service',
      'test-ns',
      {
        metadata: {
          annotations: {
            'lifecycle.goodrx.com/dev-mode-service-snapshot': null,
          },
        },
        spec: {
          ports: [{ name: 'tcp', port: 8080, targetPort: 8080, protocol: 'TCP' }],
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
    expect(mockPatchHorizontalPodAutoscaler).toHaveBeenCalledWith(
      'grpc-echo-hpa',
      'test-ns',
      {
        spec: {
          minReplicas: 2,
          maxReplicas: 4,
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
    expect(mockPatchDeployment.mock.invocationCallOrder[0]).toBeLessThan(
      mockPatchHorizontalPodAutoscaler.mock.invocationCallOrder[0]
    );
  });

  it('resolves build-specific deployment and service names when logical names do not exist directly', async () => {
    mockReadDeployment.mockRejectedValueOnce(new k8s.HttpError({ statusCode: 404 } as any, 'not found', 404));
    mockListDeployments.mockResolvedValue({
      body: {
        items: [
          {
            metadata: {
              name: 'sample-git-service-misty-river-123456',
              labels: { 'tags.datadoghq.com/service': 'sample-git-service' },
            },
            spec: {
              selector: { matchLabels: { name: 'sample-git-service-misty-river-123456' } },
              template: { spec: { containers: [{ name: 'sample-git-service' }] } },
            },
          },
        ],
      },
    });
    mockReadService
      .mockRejectedValueOnce(new k8s.HttpError({ statusCode: 404 } as any, 'not found', 404))
      .mockResolvedValueOnce({
        body: {
          metadata: { name: 'sample-git-service-misty-river-123456' },
          spec: { ports: [{ name: 'provided-8080', port: 8080, protocol: 'TCP' }] },
        },
      });

    const opts: DevModeOptions = {
      namespace: 'env-misty-river-123456',
      deploymentName: 'sample-git-service',
      serviceName: 'sample-git-service',
      pvcName: 'agent-pvc-abc',
      devConfig: { image: 'node:20-slim', command: 'node --watch app.js', ports: [8080] },
    };

    await manager.enableDevMode(opts);

    expect(mockPatchDeployment).toHaveBeenCalledWith(
      'sample-git-service-misty-river-123456',
      'env-misty-river-123456',
      expect.any(Object),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
    expect(mockPatchService).toHaveBeenCalledWith(
      'sample-git-service-misty-river-123456',
      'env-misty-river-123456',
      expect.objectContaining({
        spec: {
          ports: [{ name: 'provided-8080', port: 8080, protocol: 'TCP', targetPort: 8080 }],
        },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  });

  it('rolls back the deployment and HPA when service patching fails', async () => {
    const originalDeployment = {
      metadata: { name: 'my-app' },
      spec: {
        replicas: 2,
        template: {
          spec: {
            containers: [{ name: 'web-app', image: 'registry.example/app:built' }],
          },
        },
      },
    };
    const patchedDeployment = {
      metadata: {
        name: 'my-app',
        annotations: {
          'lifecycle.goodrx.com/dev-mode-deployment-snapshot': 'stored',
          'lifecycle.goodrx.com/dev-mode-hpa-snapshot': 'stored',
        },
      },
      spec: {
        replicas: 1,
        template: {
          spec: {
            containers: [
              {
                name: 'web-app',
                image: 'node:20-slim',
                command: ['/bin/sh', '-c', 'pnpm dev'],
                workingDir: '/workspace',
                env: [],
                volumeMounts: [{ name: 'workspace', mountPath: '/workspace', subPath: 'repo' }],
              },
            ],
            volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: 'agent-pvc-abc' } }],
            securityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
          },
        },
      },
    };
    mockReadDeployment
      .mockResolvedValueOnce({ body: originalDeployment })
      .mockResolvedValueOnce({ body: patchedDeployment });
    mockListHorizontalPodAutoscalers.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'my-app-hpa' },
            spec: {
              minReplicas: 2,
              maxReplicas: 5,
              scaleTargetRef: { kind: 'Deployment', name: 'my-app' },
            },
          },
        ],
      },
    });
    mockReadHorizontalPodAutoscaler.mockResolvedValueOnce({
      body: { metadata: { name: 'my-app-hpa' }, spec: { minReplicas: 1, maxReplicas: 1 } },
    });
    const patchFailure = new Error('service patch failed');
    mockPatchService.mockRejectedValueOnce(patchFailure);

    await expect(
      manager.enableDevMode(
        devModeOptions({
          serviceName: 'my-app-svc',
          devConfig: { image: 'node:20-slim', command: 'pnpm dev', ports: [3000] },
        })
      )
    ).rejects.toBe(patchFailure);

    expect(mockPatchDeployment).toHaveBeenCalledTimes(2);
    expect(mockPatchDeployment.mock.calls[1][2]).toEqual(
      expect.arrayContaining([
        { op: 'replace', path: '/spec/template/spec/containers/0/image', value: 'registry.example/app:built' },
        { op: 'replace', path: '/spec/replicas', value: 2 },
        { op: 'remove', path: '/spec/template/spec/containers/0/command' },
      ])
    );
    expect(mockPatchHorizontalPodAutoscaler).toHaveBeenCalledTimes(2);
    expect(mockPatchHorizontalPodAutoscaler.mock.calls[1][2]).toEqual({ spec: { minReplicas: 2, maxReplicas: 5 } });
  });

  it('preserves the original enable failure when best-effort rollback cannot reload the deployment', async () => {
    mockReadDeployment
      .mockResolvedValueOnce({
        body: {
          metadata: { name: 'my-app' },
          spec: { template: { spec: { containers: [{ name: 'web-app', image: 'built' }] } } },
        },
      })
      .mockRejectedValueOnce(new Error('deployment reload failed'));
    mockListHorizontalPodAutoscalers.mockResolvedValueOnce({
      body: {
        items: [
          {
            metadata: { name: 'my-app-hpa' },
            spec: { minReplicas: 2, maxReplicas: 5, scaleTargetRef: { kind: 'Deployment', name: 'my-app' } },
          },
        ],
      },
    });
    mockReadHorizontalPodAutoscaler.mockRejectedValueOnce(new Error('HPA reload failed'));
    const patchFailure = new Error('service patch failed');
    mockPatchService.mockRejectedValueOnce(patchFailure);

    await expect(
      manager.enableDevMode(
        devModeOptions({
          serviceName: 'my-app-svc',
          devConfig: { image: 'node:20-slim', command: 'pnpm dev', ports: [3000] },
        })
      )
    ).rejects.toBe(patchFailure);
    expect(mockPatchDeployment).toHaveBeenCalledTimes(1);
    expect(mockPatchHorizontalPodAutoscaler).toHaveBeenCalledTimes(1);
  });

  it('propagates non-not-found deployment read failures without attempting fallback discovery', async () => {
    const forbidden = new Error('deployment access denied');
    mockReadDeployment.mockRejectedValueOnce(forbidden);

    await expect(manager.enableDevMode(devModeOptions())).rejects.toBe(forbidden);
    expect(mockListDeployments).not.toHaveBeenCalled();
    expect(mockPatchDeployment).not.toHaveBeenCalled();
  });

  it('uses deterministic deployment fallback priority across direct, label, and namespace-suffixed matches', async () => {
    const cases = [
      {
        namespace: 'env-preview',
        items: [
          { metadata: { name: 'generated', labels: { 'tags.datadoghq.com/service': 'my-app' } } },
          { metadata: { name: 'my-app' } },
        ],
        expected: 'my-app',
      },
      {
        namespace: 'env-preview',
        items: [{ metadata: { name: 'generated', labels: { 'tags.datadoghq.com/service': 'my-app' } } }],
        expected: 'generated',
      },
      {
        namespace: 'env-preview',
        items: [{ metadata: { name: 'instance-match', labels: { 'app.kubernetes.io/instance': 'my-app' } } }],
        expected: 'instance-match',
      },
      {
        namespace: 'preview',
        items: [{ metadata: { name: 'my-app-preview' } }],
        expected: 'my-app-preview',
      },
    ];

    for (const testCase of cases) {
      mockReadDeployment.mockRejectedValueOnce(notFound());
      mockListDeployments.mockResolvedValueOnce({
        body: {
          items: testCase.items.map((item) => ({
            ...item,
            spec: { template: { spec: { containers: [{ name: 'web-app' }] } } },
          })),
        },
      });
      await manager.enableDevMode(devModeOptions({ namespace: testCase.namespace }));
      expect(mockPatchDeployment).toHaveBeenLastCalledWith(
        testCase.expected,
        testCase.namespace,
        expect.any(Object),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
      );
    }
  });

  it('reports a stable error when deployment fallback discovery has no matching candidate', async () => {
    mockReadDeployment.mockRejectedValueOnce(notFound());
    mockListDeployments.mockResolvedValueOnce({ body: { items: [{ metadata: { name: 'different-app' } }] } });

    await expect(manager.enableDevMode(devModeOptions())).rejects.toThrow(
      'Deployment not found for dev mode: my-app in namespace test-ns'
    );
  });

  it('resolves a service by matching the deployment selector after both direct names are absent', async () => {
    mockReadDeployment.mockResolvedValueOnce({
      body: {
        metadata: { name: 'my-app-generated' },
        spec: {
          selector: { matchLabels: { app: 'my-app' } },
          template: { spec: { containers: [{ name: 'web-app' }] } },
        },
      },
    });
    mockReadService.mockRejectedValueOnce(notFound()).mockRejectedValueOnce(notFound());
    mockListServices.mockResolvedValueOnce({
      body: {
        items: [
          { metadata: { name: 'unrelated' }, spec: {} },
          {
            metadata: { name: 'generated-service' },
            spec: { selector: { app: 'my-app' }, ports: [{ port: 80 }] },
          },
        ],
      },
    });

    await manager.enableDevMode(
      devModeOptions({
        serviceName: 'logical-service',
        devConfig: { image: 'node:20-slim', command: 'pnpm dev', ports: [3000] },
      })
    );
    expect(mockPatchService).toHaveBeenCalledWith(
      'generated-service',
      'test-ns',
      expect.objectContaining({ spec: { ports: [{ port: 80, targetPort: 3000 }] } }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  });

  it('prefers a public selector-matched service over an internal load balancer', async () => {
    mockReadDeployment.mockResolvedValueOnce({
      body: {
        metadata: { name: 'my-app-generated' },
        spec: {
          selector: { matchLabels: { app: 'my-app' } },
          template: { spec: { containers: [{ name: 'web-app' }] } },
        },
      },
    });
    mockReadService.mockRejectedValueOnce(notFound()).mockRejectedValueOnce(notFound());
    mockListServices.mockResolvedValueOnce({
      body: {
        items: [
          {
            metadata: { name: 'internal-lb-my-app' },
            spec: { selector: { app: 'my-app' }, ports: [{ port: 80 }] },
          },
          {
            metadata: { name: 'my-app-public' },
            spec: { selector: { app: 'my-app' }, ports: [{ port: 8080 }] },
          },
        ],
      },
    });

    await manager.enableDevMode(
      devModeOptions({
        serviceName: 'logical-service',
        devConfig: { image: 'node:20-slim', command: 'pnpm dev', ports: [3000] },
      })
    );

    expect(mockPatchService).toHaveBeenCalledWith(
      'my-app-public',
      'test-ns',
      expect.objectContaining({ spec: { ports: [{ port: 8080, targetPort: 3000 }] } }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  });

  it('propagates non-not-found service reads and reports an empty fallback search', async () => {
    const forbidden = new Error('service access denied');
    mockReadService.mockRejectedValueOnce(forbidden);
    await expect(
      manager.enableDevMode(
        devModeOptions({ devConfig: { image: 'node:20-slim', command: 'pnpm dev', ports: [3000] } })
      )
    ).rejects.toBe(forbidden);
    expect(mockListServices).not.toHaveBeenCalled();

    mockReadService.mockRejectedValueOnce(notFound()).mockRejectedValueOnce(notFound());
    mockListServices.mockResolvedValueOnce({ body: { items: [{ metadata: { name: 'unrelated' }, spec: {} }] } });
    await expect(
      manager.enableDevMode(
        devModeOptions({ devConfig: { image: 'node:20-slim', command: 'pnpm dev', ports: [3000] } })
      )
    ).rejects.toThrow('Service not found for dev mode: my-app in namespace test-ns');
  });

  it('does not patch a target-matching HPA that lacks a resource name', async () => {
    mockListHorizontalPodAutoscalers.mockResolvedValueOnce({
      body: {
        items: [{ metadata: {}, spec: { scaleTargetRef: { kind: 'Deployment', name: 'my-app' } } }],
      },
    });

    const snapshot = await manager.enableDevMode(devModeOptions());
    expect(snapshot.horizontalPodAutoscaler).toEqual({ hpaName: '', minReplicas: null, maxReplicas: 1 });
    expect(mockPatchHorizontalPodAutoscaler).not.toHaveBeenCalled();
  });

  it('ignores unrelated autoscalers and pins only the deployment target', async () => {
    mockListHorizontalPodAutoscalers.mockResolvedValueOnce({
      body: {
        items: [
          {
            metadata: { name: 'stateful-app-hpa' },
            spec: {
              minReplicas: 2,
              maxReplicas: 8,
              scaleTargetRef: { kind: 'StatefulSet', name: 'my-app' },
            },
          },
          {
            metadata: { name: 'other-deployment-hpa' },
            spec: {
              minReplicas: 2,
              maxReplicas: 6,
              scaleTargetRef: { kind: 'Deployment', name: 'other-app' },
            },
          },
          {
            metadata: { name: 'my-app-hpa' },
            spec: {
              minReplicas: 3,
              maxReplicas: 9,
              scaleTargetRef: { kind: 'Deployment', name: 'my-app' },
            },
          },
        ],
      },
    });

    const snapshot = await manager.enableDevMode(devModeOptions());

    expect(snapshot.horizontalPodAutoscaler).toEqual({
      hpaName: 'my-app-hpa',
      minReplicas: 3,
      maxReplicas: 9,
    });
    expect(mockPatchHorizontalPodAutoscaler).toHaveBeenCalledTimes(1);
    expect(mockPatchHorizontalPodAutoscaler).toHaveBeenCalledWith(
      'my-app-hpa',
      'test-ns',
      { spec: { minReplicas: 1, maxReplicas: 1 } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  });

  it('contains HPA restoration failures while disabling dev mode', async () => {
    mockReadDeployment.mockResolvedValueOnce({
      body: {
        metadata: {
          name: 'my-app',
          annotations: {
            'lifecycle.goodrx.com/dev-mode-hpa-snapshot': JSON.stringify({
              hpaName: 'my-app-hpa',
              minReplicas: 2,
              maxReplicas: 5,
            }),
          },
        },
        spec: { template: { spec: { containers: [{ name: 'web-app' }] } } },
      },
    });
    mockReadHorizontalPodAutoscaler.mockRejectedValueOnce(new Error('HPA API unavailable'));

    await expect(manager.disableDevMode('test-ns', 'my-app')).resolves.toBeUndefined();
    expect(mockListHorizontalPodAutoscalers).not.toHaveBeenCalled();
    expect(mockPatchHorizontalPodAutoscaler).not.toHaveBeenCalled();
  });

  it('falls back from a missing preferred HPA and restores a discovered target with nullable minimum replicas', async () => {
    const deploymentSnapshot = {
      deploymentName: 'my-app',
      containerName: 'web-app',
      replicas: null,
      image: null,
      command: null,
      workingDir: null,
      env: null,
      volumeMounts: null,
      volumes: null,
      nodeSelector: null,
      securityContext: null,
    };
    mockReadDeployment.mockResolvedValueOnce({
      body: { metadata: { name: 'my-app' }, spec: { template: { spec: { containers: [{ name: 'web-app' }] } } } },
    });
    mockReadHorizontalPodAutoscaler.mockRejectedValueOnce(notFound());
    mockListHorizontalPodAutoscalers.mockResolvedValueOnce({
      body: {
        items: [
          {
            metadata: {},
            spec: { minReplicas: 1, maxReplicas: 1, scaleTargetRef: { kind: 'Deployment', name: 'my-app' } },
          },
        ],
      },
    });

    await manager.disableDevMode('test-ns', 'my-app', undefined, {
      deployment: deploymentSnapshot,
      service: null,
      horizontalPodAutoscaler: { hpaName: 'preferred-hpa', minReplicas: null, maxReplicas: 5 },
    });
    expect(mockPatchHorizontalPodAutoscaler).toHaveBeenCalledWith(
      'preferred-hpa',
      'test-ns',
      { spec: { minReplicas: null, maxReplicas: 5 } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  });

  it('patches empty and fully attributed service ports using the first configured dev port', async () => {
    mockReadService.mockResolvedValueOnce({ body: { metadata: {}, spec: {} } });
    await manager.enableDevMode(
      devModeOptions({
        serviceName: 'logical-service',
        devConfig: { image: 'node:20-slim', command: 'pnpm dev', ports: [3000, 4000] },
      })
    );
    expect(mockPatchService).toHaveBeenLastCalledWith(
      'logical-service',
      'test-ns',
      expect.objectContaining({ spec: { ports: [{ port: 3000, targetPort: 3000 }] } }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );

    mockReadService.mockResolvedValueOnce({
      body: {
        metadata: { name: 'attributed-service' },
        spec: {
          ports: [{ name: 'https', protocol: 'TCP', nodePort: 30443, appProtocol: 'https' }],
        },
      },
    });
    await manager.enableDevMode(
      devModeOptions({ devConfig: { image: 'node:20-slim', command: 'pnpm dev', ports: [8443] } })
    );
    expect(mockPatchService).toHaveBeenLastCalledWith(
      'attributed-service',
      'test-ns',
      expect.objectContaining({
        spec: {
          ports: [
            { name: 'https', protocol: 'TCP', nodePort: 30443, appProtocol: 'https', port: 8443, targetPort: 8443 },
          ],
        },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  });

  it('restores a service directly from its dev-mode snapshot annotation', async () => {
    mockReadService.mockResolvedValueOnce({
      body: {
        metadata: {
          name: 'my-app-svc',
          annotations: {
            'lifecycle.goodrx.com/dev-mode-service-snapshot': JSON.stringify({
              serviceName: 'my-app-svc',
              ports: [{ name: 'http', port: 80, targetPort: 8080 }],
            }),
          },
        },
        spec: { ports: [{ name: 'http', port: 80, targetPort: 3000 }] },
      },
    });

    await manager.disableDevMode('test-ns', 'my-app', 'my-app-svc');
    expect(mockPatchService).toHaveBeenCalledWith(
      'my-app-svc',
      'test-ns',
      {
        metadata: { annotations: { 'lifecycle.goodrx.com/dev-mode-service-snapshot': null } },
        spec: { ports: [{ name: 'http', port: 80, targetPort: 8080 }] },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  });

  it('falls back from an invalid service snapshot to the last-applied port configuration', async () => {
    mockReadService.mockResolvedValueOnce({
      body: {
        metadata: {
          name: 'my-app-svc',
          annotations: {
            'lifecycle.goodrx.com/dev-mode-service-snapshot': '{invalid',
            'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({
              spec: {
                ports: [{ name: 'http', protocol: 'TCP', port: 80, targetPort: 8080 }, { port: 81 }],
              },
            }),
          },
        },
      },
    });

    await manager.disableDevMode('test-ns', 'my-app', 'my-app-svc');
    expect(mockPatchService).toHaveBeenCalledWith(
      'my-app-svc',
      'test-ns',
      {
        spec: {
          ports: [
            { name: 'http', protocol: 'TCP', port: 80, targetPort: 8080 },
            { port: 81, targetPort: 81 },
          ],
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
  });

  it('skips unsafe service cleanup states without issuing a patch', async () => {
    const services = [
      { metadata: {} },
      { metadata: { name: 'missing-annotation' } },
      {
        metadata: {
          name: 'invalid-annotation',
          annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{invalid' },
        },
      },
      {
        metadata: {
          name: 'empty-ports',
          annotations: { 'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({ spec: { ports: [] } }) },
        },
      },
    ];
    for (const service of services) {
      mockReadService.mockResolvedValueOnce({ body: service });
      await manager.disableDevMode('test-ns', 'my-app', 'logical-service');
    }
    expect(mockPatchService).not.toHaveBeenCalled();
  });

  it('contains service lookup failures while disabling dev mode', async () => {
    mockReadService.mockRejectedValueOnce(new Error('service API unavailable'));
    await expect(manager.disableDevMode('test-ns', 'my-app', 'my-app-svc')).resolves.toBeUndefined();
    expect(mockPatchService).not.toHaveBeenCalled();
  });

  it('uses the last-applied container by position when its name differs from the live container', async () => {
    const originalCommand = ['node', 'server.js'];
    const originalWorkspaceMount = { name: 'workspace', mountPath: '/workspace' };
    const originalWorkspaceVolume = { name: 'workspace', persistentVolumeClaim: { claimName: 'app-workspace' } };
    mockReadDeployment.mockResolvedValueOnce({
      body: {
        metadata: {
          name: 'my-app',
          annotations: {
            'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({
              spec: {
                replicas: 2,
                template: {
                  spec: {
                    containers: [
                      {
                        name: 'original-app',
                        command: originalCommand,
                        workingDir: '/workspace',
                        volumeMounts: [originalWorkspaceMount],
                      },
                    ],
                    volumes: [originalWorkspaceVolume],
                  },
                },
              },
            }),
          },
        },
        spec: {
          replicas: 1,
          template: {
            spec: {
              containers: [
                {
                  name: 'renamed-app',
                  command: originalCommand,
                  workingDir: '/workspace',
                  volumeMounts: [originalWorkspaceMount],
                },
              ],
              volumes: [originalWorkspaceVolume],
            },
          },
        },
      },
    });

    await manager.disableDevMode('test-ns', 'my-app');

    expect(mockPatchDeployment).toHaveBeenCalledWith(
      'my-app',
      'test-ns',
      [{ op: 'replace', path: '/spec/replicas', value: 2 }],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/json-patch+json' } }
    );
  });

  it('skips deployment cleanup when annotations are unusable or no live container exists', async () => {
    mockReadDeployment.mockResolvedValueOnce({
      body: {
        metadata: {
          name: 'invalid-annotation',
          annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{invalid' },
        },
        spec: { template: { spec: { containers: [{ name: 'app' }] } } },
      },
    });
    await manager.disableDevMode('test-ns', 'invalid-annotation');

    mockReadDeployment.mockResolvedValueOnce({
      body: {
        metadata: {
          name: 'no-containers',
          annotations: { 'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({ spec: {} }) },
        },
        spec: { template: { spec: { containers: [] } } },
      },
    });
    await manager.disableDevMode('test-ns', 'no-containers');

    mockReadDeployment.mockResolvedValueOnce({
      body: {
        metadata: { name: 'no-container-or-annotation' },
        spec: { template: { spec: { containers: [] } } },
      },
    });
    await manager.disableDevMode('test-ns', 'no-container-or-annotation');
    expect(mockPatchDeployment).not.toHaveBeenCalled();
  });

  it('does not patch an explicit deployment snapshot when there is no container or all values already match', async () => {
    const snapshot = {
      deploymentName: 'my-app',
      containerName: 'app',
      replicas: 1,
      image: 'built',
      command: null,
      workingDir: null,
      env: null,
      volumeMounts: null,
      volumes: null,
      nodeSelector: null,
      securityContext: null,
    };
    mockReadDeployment.mockResolvedValueOnce({
      body: { metadata: { name: 'my-app' }, spec: { replicas: 1, template: { spec: { containers: [] } } } },
    });
    await manager.disableDevMode('test-ns', 'my-app', undefined, { deployment: snapshot, service: null });

    mockReadDeployment.mockResolvedValueOnce({
      body: {
        metadata: { name: 'my-app' },
        spec: { replicas: 1, template: { spec: { containers: [{ name: 'app', image: 'built' }] } } },
      },
    });
    await manager.disableDevMode('test-ns', 'my-app', undefined, { deployment: snapshot, service: null });
    expect(mockPatchDeployment).not.toHaveBeenCalled();
  });

  it('adds snapshot values that are absent from a live deployment', async () => {
    mockReadDeployment.mockResolvedValueOnce({
      body: {
        spec: { template: { spec: { containers: [{ name: 'app' }] } } },
      },
    });
    await manager.disableDevMode('test-ns', 'logical-name', undefined, {
      deployment: {
        deploymentName: 'resolved-name',
        containerName: 'app',
        replicas: 3,
        image: 'registry.example/app:built',
        command: ['node', 'server.js'],
        workingDir: '/app',
        env: [{ name: 'PORT', value: '3000' }],
        volumeMounts: [{ name: 'config', mountPath: '/config' }],
        volumes: [{ name: 'config', emptyDir: {} }],
        nodeSelector: { pool: 'apps' },
        securityContext: { runAsNonRoot: true },
      },
      service: null,
    });

    expect(mockPatchDeployment).toHaveBeenCalledWith(
      'resolved-name',
      'test-ns',
      [
        { op: 'add', path: '/spec/template/spec/containers/0/image', value: 'registry.example/app:built' },
        { op: 'add', path: '/spec/replicas', value: 3 },
        { op: 'add', path: '/spec/template/spec/containers/0/command', value: ['node', 'server.js'] },
        { op: 'add', path: '/spec/template/spec/containers/0/workingDir', value: '/app' },
        { op: 'add', path: '/spec/template/spec/containers/0/env', value: [{ name: 'PORT', value: '3000' }] },
        {
          op: 'add',
          path: '/spec/template/spec/containers/0/volumeMounts',
          value: [{ name: 'config', mountPath: '/config' }],
        },
        { op: 'add', path: '/spec/template/spec/volumes', value: [{ name: 'config', emptyDir: {} }] },
        { op: 'add', path: '/spec/template/spec/nodeSelector', value: { pool: 'apps' } },
        { op: 'add', path: '/spec/template/spec/securityContext', value: { runAsNonRoot: true } },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/json-patch+json' } }
    );
  });

  it('removes only dev-mode node and ownership fields when fallback cleanup must preserve siblings', async () => {
    mockReadDeployment.mockResolvedValueOnce({
      body: {
        metadata: { name: 'my-app' },
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: 'app',
                  command: ['pnpm', 'dev'],
                  workingDir: '/workspace/app',
                  volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
                },
              ],
              volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: 'agent-pvc' } }],
              nodeSelector: { pool: 'apps', 'kubernetes.io/hostname': 'agent-node' },
              securityContext: {
                runAsNonRoot: true,
                fsGroup: 1000,
                fsGroupChangePolicy: 'OnRootMismatch',
              },
            },
          },
        },
      },
    });

    await manager.disableDevMode('test-ns', 'my-app');
    expect(mockPatchDeployment.mock.calls[0][2]).toEqual(
      expect.arrayContaining([
        { op: 'remove', path: '/spec/template/spec/nodeSelector/kubernetes.io~1hostname' },
        { op: 'remove', path: '/spec/template/spec/securityContext/fsGroup' },
        { op: 'remove', path: '/spec/template/spec/securityContext/fsGroupChangePolicy' },
      ])
    );
  });

  it('captures a stable fallback container identity when a deployment has no pod template', async () => {
    mockReadDeployment.mockResolvedValueOnce({ body: { metadata: { name: 'empty-deployment' } } });
    const snapshot = await manager.enableDevMode(devModeOptions({ deploymentName: 'empty-deployment' }));

    expect(snapshot.deployment).toMatchObject({
      deploymentName: 'empty-deployment',
      containerName: 'empty-deployment',
      replicas: null,
      image: null,
      command: null,
      workingDir: null,
    });
    expect(mockPatchDeployment.mock.calls[0][2].spec.template.spec.containers[0].name).toBe('empty-deployment');
  });
});
