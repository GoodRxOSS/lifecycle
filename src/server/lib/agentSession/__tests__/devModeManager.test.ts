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
    mockPatchDeployment.mockResolvedValue({});
    mockPatchService.mockResolvedValue({});
    manager = new DevModeManager();
  });

  it('patches deployment with dev image and PVC', async () => {
    const opts: DevModeOptions = {
      namespace: 'test-ns',
      deploymentName: 'my-app',
      serviceName: 'my-app',
      pvcName: 'agent-pvc-abc',
      devConfig: { image: 'node:20-slim', command: 'pnpm dev', workDir: '/workspace' },
    };

    await manager.enableDevMode(opts);

    expect(mockPatchDeployment).toHaveBeenCalledWith(
      'my-app',
      'test-ns',
      expect.objectContaining({
        metadata: {
          annotations: {
            'lifecycle.goodrx.com/dev-mode-deployment-snapshot': expect.any(String),
          },
        },
        spec: {
          template: {
            spec: {
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
                    volumes: [{ name: 'config-volume' }],
                  },
                },
              },
            }),
          },
        },
        spec: {
          template: {
            spec: {
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
              containerName: 'grpc-echo',
              image: 'registry.example/grpc-echo:built',
              env: [
                { name: 'COMPONENT', value: 'app' },
                { name: 'ENV', value: 'lifecycle' },
              ],
              volumeMounts: [{ name: 'config-volume', mountPath: '/config' }],
              volumes: [{ name: 'config-volume', emptyDir: {} }],
            }),
          },
        },
        spec: {
          template: {
            spec: {
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
          op: 'replace',
          path: '/spec/template/spec/containers/0/image',
          value: 'registry.example/grpc-echo:built',
        },
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
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/json-patch+json' } }
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
          template: {
            spec: {
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
          template: {
            spec: {
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

    await manager.disableDevMode('test-ns', 'grpc-echo', 'grpc-echo', {
      deployment: {
        deploymentName: 'grpc-echo-resolved',
        containerName: 'lc-apps',
        image: 'registry.example/grpc-echo:built',
        command: null,
        workingDir: null,
        env: null,
        volumeMounts: null,
        volumes: null,
      },
      service: {
        serviceName: 'grpc-echo-service',
        ports: [{ name: 'tcp', port: 8080, targetPort: 8080, protocol: 'TCP' }],
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
        { op: 'remove', path: '/spec/template/spec/containers/0/command' },
        { op: 'remove', path: '/spec/template/spec/containers/0/workingDir' },
        { op: 'remove', path: '/spec/template/spec/containers/0/env' },
        { op: 'remove', path: '/spec/template/spec/containers/0/volumeMounts' },
        { op: 'remove', path: '/spec/template/spec/volumes' },
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
  });

  it('resolves build-specific deployment and service names when logical names do not exist directly', async () => {
    mockReadDeployment.mockRejectedValueOnce(new k8s.HttpError({ statusCode: 404 } as any, 'not found', 404));
    mockListDeployments.mockResolvedValue({
      body: {
        items: [
          {
            metadata: {
              name: 'lc-test-gh-type-wispy-frog-035797',
              labels: { 'tags.datadoghq.com/service': 'lc-test-gh-type' },
            },
            spec: {
              selector: { matchLabels: { name: 'lc-test-gh-type-wispy-frog-035797' } },
              template: { spec: { containers: [{ name: 'lc-test-gh-type' }] } },
            },
          },
        ],
      },
    });
    mockReadService
      .mockRejectedValueOnce(new k8s.HttpError({ statusCode: 404 } as any, 'not found', 404))
      .mockResolvedValueOnce({
        body: {
          metadata: { name: 'lc-test-gh-type-wispy-frog-035797' },
          spec: { ports: [{ name: 'provided-8080', port: 8080, protocol: 'TCP' }] },
        },
      });

    const opts: DevModeOptions = {
      namespace: 'env-wispy-frog-035797',
      deploymentName: 'lc-test-gh-type',
      serviceName: 'lc-test-gh-type',
      pvcName: 'agent-pvc-abc',
      devConfig: { image: 'node:20-slim', command: 'node --watch app.js', ports: [8080] },
    };

    await manager.enableDevMode(opts);

    expect(mockPatchDeployment).toHaveBeenCalledWith(
      'lc-test-gh-type-wispy-frog-035797',
      'env-wispy-frog-035797',
      expect.any(Object),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
    expect(mockPatchService).toHaveBeenCalledWith(
      'lc-test-gh-type-wispy-frog-035797',
      'env-wispy-frog-035797',
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
});
