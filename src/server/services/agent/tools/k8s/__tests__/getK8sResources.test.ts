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

import { GetK8sResourcesTool } from '../getK8sResources';

// Namespace scope state shared by the mock's resolveNamespace; mirrors K8sClient.
let mockAllowedNamespace: string | null = null;

const mockK8sClient = {
  coreApi: {
    listNamespacedPod: jest.fn(),
    readNamespacedPod: jest.fn(),
    readNamespacedPodLog: jest.fn(),
    listNamespacedService: jest.fn(),
    listNamespacedSecret: jest.fn(),
    listNamespacedConfigMap: jest.fn(),
    listNamespacedEvent: jest.fn(),
    deleteNamespacedPod: jest.fn(),
  },
  appsApi: {
    listNamespacedDeployment: jest.fn(),
    readNamespacedDeployment: jest.fn(),
    patchNamespacedDeployment: jest.fn(),
    listNamespacedStatefulSet: jest.fn(),
    listNamespacedDaemonSet: jest.fn(),
    listNamespacedReplicaSet: jest.fn(),
  },
  batchApi: {
    listNamespacedJob: jest.fn(),
    deleteNamespacedJob: jest.fn(),
  },
  networkingApi: {
    listNamespacedIngress: jest.fn(),
  },
  setAllowedNamespace: (ns: string | null | undefined) => {
    mockAllowedNamespace = ns?.trim() || null;
  },
  resolveNamespace: (requested?: string | null) => {
    const requestedTrimmed = requested?.trim() || null;
    if (!mockAllowedNamespace) {
      if (!requestedTrimmed) throw new Error('namespace is required');
      return requestedTrimmed;
    }
    if (!requestedTrimmed) return mockAllowedNamespace;
    if (requestedTrimmed !== mockAllowedNamespace) {
      throw new Error(
        `namespace "${requestedTrimmed}" is outside this environment's namespace "${mockAllowedNamespace}" and cannot be accessed.`
      );
    }
    return mockAllowedNamespace;
  },
} as any;

describe('GetK8sResourcesTool', () => {
  let tool: GetK8sResourcesTool;

  const agentData = (result: Awaited<ReturnType<GetK8sResourcesTool['execute']>>) =>
    JSON.parse(result.agentContent as string);
  const displayText = (result: Awaited<ReturnType<GetK8sResourcesTool['execute']>>) =>
    (result.displayContent as { content: string }).content;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAllowedNamespace = null;
    tool = new GetK8sResourcesTool(mockK8sClient);
  });

  it('lists pods', async () => {
    mockK8sClient.coreApi.listNamespacedPod.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'pod-1', creationTimestamp: '2025-01-01T00:00:00Z' },
            status: {
              phase: 'Running',
              containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }],
            },
          },
          {
            metadata: { name: 'pod-2', creationTimestamp: '2025-01-01T00:00:00Z' },
            status: {
              phase: 'Pending',
              containerStatuses: [{ name: 'app', ready: false, restartCount: 2, state: { waiting: {} } }],
            },
          },
        ],
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'pods' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent);
    expect(data.pods).toHaveLength(2);
    expect(data.pods[0].name).toBe('pod-1');
    expect(data.pods[0].phase).toBe('Running');
    expect(data.pods[0].ready).toBe('1/1');
    expect(data.pods[0].restarts).toBe(0);
    expect(data.pods[1].restarts).toBe(2);
  });

  it('gets specific pod by name', async () => {
    mockK8sClient.coreApi.readNamespacedPod.mockResolvedValue({
      body: {
        metadata: { name: 'my-pod' },
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: [{ name: 'app', ready: true, restartCount: 0 }],
          hostIP: '10.0.0.1',
          podIP: '10.0.1.5',
          startTime: '2025-01-01T00:00:00Z',
        },
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'pods', name: 'my-pod' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent);
    expect(data.pod.name).toBe('my-pod');
    expect(data.pod.podIP).toBe('10.0.1.5');
  });

  it('lists deployments', async () => {
    mockK8sClient.appsApi.listNamespacedDeployment.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'deploy-1', creationTimestamp: '2025-01-01T00:00:00Z' },
            spec: { replicas: 3 },
            status: { readyReplicas: 3, availableReplicas: 3 },
          },
        ],
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'deployments' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent);
    expect(data.deployments).toHaveLength(1);
    expect(data.deployments[0].name).toBe('deploy-1');
  });

  it('gets specific deployment by name', async () => {
    mockK8sClient.appsApi.readNamespacedDeployment.mockResolvedValue({
      body: {
        metadata: { name: 'my-deploy' },
        spec: {
          replicas: 2,
          strategy: { type: 'RollingUpdate' },
          template: { spec: { containers: [{ name: 'app', image: 'nginx:latest' }] } },
        },
        status: { replicas: 2, readyReplicas: 2, availableReplicas: 2, updatedReplicas: 2 },
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'deployments', name: 'my-deploy' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent);
    expect(data.deployment.name).toBe('my-deploy');
    expect(data.deployment.replicas.desired).toBe(2);
  });

  it('lists services', async () => {
    mockK8sClient.coreApi.listNamespacedService.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'svc-1' },
            spec: {
              type: 'ClusterIP',
              clusterIP: '10.96.0.1',
              ports: [{ name: 'http', port: 80, targetPort: 8080, protocol: 'TCP' }],
              selector: { app: 'web' },
            },
          },
        ],
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'services' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent);
    expect(data.services).toHaveLength(1);
    expect(data.services[0].name).toBe('svc-1');
    expect(data.count).toBe(1);
  });

  it('returns error for unsupported resource type', async () => {
    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'unknown' });
    expect(result.success).toBe(false);
    expect(result.agentContent).toContain('Unsupported resource type');
  });

  it('handles aborted signal', async () => {
    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'pods' }, { aborted: true } as any);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CANCELLED');
  });

  it('handles API error gracefully', async () => {
    mockK8sClient.coreApi.listNamespacedPod.mockRejectedValue(new Error('Forbidden'));

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'pods' });
    expect(result.success).toBe(false);
    expect(result.agentContent).toContain('Forbidden');
  });

  it('uses stable fallback errors when namespace or API failures have no message', async () => {
    const resolveNamespace = jest.spyOn(mockK8sClient, 'resolveNamespace').mockImplementationOnce(() => {
      throw {};
    });
    const namespaceResult = await tool.execute({ namespace: 'test-ns', resource_type: 'pods' });
    expect(namespaceResult.error).toEqual({ code: 'NAMESPACE_NOT_ALLOWED', message: 'Namespace not allowed' });

    resolveNamespace.mockRestore();
    mockK8sClient.coreApi.listNamespacedPod.mockRejectedValueOnce({});
    const apiResult = await tool.execute({ namespace: 'test-ns', resource_type: 'pods' });
    expect(apiResult.error).toEqual({ code: 'EXECUTION_ERROR', message: 'Unknown error' });
  });

  it('rejects a namespace outside the build scope', async () => {
    mockK8sClient.setAllowedNamespace('env-mine');

    const result = await tool.execute({ namespace: 'env-other', resource_type: 'pods' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NAMESPACE_NOT_ALLOWED');
    expect(result.agentContent).toContain('env-other');
    expect(result.agentContent).toContain('env-mine');
    expect(mockK8sClient.coreApi.listNamespacedPod).not.toHaveBeenCalled();
  });

  it('defaults to the build namespace when none is supplied', async () => {
    mockK8sClient.setAllowedNamespace('env-mine');
    mockK8sClient.coreApi.listNamespacedPod.mockResolvedValue({ body: { items: [] } });

    const result = await tool.execute({ resource_type: 'pods' });
    expect(result.success).toBe(true);
    expect(mockK8sClient.coreApi.listNamespacedPod).toHaveBeenCalledWith(
      'env-mine',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
  });

  it('allows the matching build namespace', async () => {
    mockK8sClient.setAllowedNamespace('env-mine');
    mockK8sClient.coreApi.listNamespacedPod.mockResolvedValue({ body: { items: [] } });

    const result = await tool.execute({ namespace: 'env-mine', resource_type: 'pods' });
    expect(result.success).toBe(true);
    expect(mockK8sClient.coreApi.listNamespacedPod).toHaveBeenCalled();
  });

  it('never returns secret values, only metadata/keys', async () => {
    mockK8sClient.coreApi.listNamespacedSecret.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'db-creds' },
            type: 'Opaque',
            data: { DB_PASSWORD: 'c3VwZXItc2VjcmV0', DB_USER: 'YWRtaW4=' },
          },
        ],
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'secrets' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent as string);
    expect(data.secrets[0].name).toBe('db-creds');
    expect(data.secrets[0].keys).toEqual(['DB_PASSWORD', 'DB_USER']);
    expect(result.agentContent).not.toContain('c3VwZXItc2VjcmV0');
    expect(result.agentContent).not.toContain('super-secret');
  });

  it('surfaces waiting reason for non-running containers (ImagePullBackOff)', async () => {
    mockK8sClient.coreApi.listNamespacedPod.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'pod-bad', creationTimestamp: '2025-01-01T00:00:00Z' },
            status: {
              phase: 'Pending',
              containerStatuses: [
                {
                  name: 'app',
                  ready: false,
                  restartCount: 0,
                  state: {
                    waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image "nope:latest"' },
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'pods' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent as string);
    expect(data.pods[0].containers[0].waiting).toEqual({
      reason: 'ImagePullBackOff',
      message: 'Back-off pulling image "nope:latest"',
    });
    expect((result.displayContent as { content: string }).content).toContain('ImagePullBackOff');
  });

  it('surfaces terminated reason and lastState (OOMKilled / CrashLoop)', async () => {
    mockK8sClient.coreApi.listNamespacedPod.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'pod-crash', creationTimestamp: '2025-01-01T00:00:00Z' },
            status: {
              phase: 'Running',
              containerStatuses: [
                {
                  name: 'app',
                  ready: false,
                  restartCount: 7,
                  state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off restarting' } },
                  lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
                },
              ],
            },
          },
        ],
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'pods' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.agentContent as string);
    const container = data.pods[0].containers[0];
    expect(container.waiting.reason).toBe('CrashLoopBackOff');
    expect(container.lastState.terminated).toEqual({ reason: 'OOMKilled', exitCode: 137 });
  });

  it('summarizes waiting, terminated, previous, and stateless container states without inventing fields', () => {
    expect(
      GetK8sResourcesTool.summarizeContainerStatus({
        name: 'waiting',
        ready: false,
        restartCount: 0,
        state: { waiting: { message: 'still pulling' } },
      })
    ).toEqual({
      name: 'waiting',
      ready: false,
      state: 'waiting',
      restarts: 0,
      waiting: { reason: undefined, message: 'still pulling' },
    });
    expect(
      GetK8sResourcesTool.summarizeContainerStatus({
        name: 'terminated',
        ready: false,
        restartCount: 1,
        state: { terminated: { reason: 'Error', message: 'failed', exitCode: 2 } },
      })
    ).toMatchObject({
      state: 'terminated',
      terminated: { reason: 'Error', message: 'failed', exitCode: 2 },
    });
    expect(
      GetK8sResourcesTool.summarizeContainerStatus({
        name: 'restarted',
        ready: true,
        restartCount: 1,
        lastState: { terminated: { exitCode: 0 } },
      })
    ).toMatchObject({
      state: undefined,
      lastState: { terminated: { reason: undefined, exitCode: 0 } },
    });
    expect(GetK8sResourcesTool.summarizeContainerStatus({ name: 'new', ready: false, restartCount: 0 })).toEqual({
      name: 'new',
      ready: false,
      state: undefined,
      restarts: 0,
    });
  });

  it('summarizes large pod lists while retaining full unhealthy diagnostics', async () => {
    const pod = (index: number) => ({
      metadata: { name: `pod-${index}` },
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }],
      },
    });
    const pods = Array.from({ length: 51 }, (_, index) => pod(index));
    pods[0].status.phase = 'Pending';
    pods[0].status.containerStatuses = [
      { name: 'app', ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff' } } },
    ] as any;
    pods[1].status.containerStatuses[0].restartCount = 6;
    mockK8sClient.coreApi.listNamespacedPod.mockResolvedValueOnce({ body: { items: pods } });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'pod', label_selector: 'app=api' });
    const data = agentData(result);
    expect(data).toMatchObject({ total: 51, unhealthyCount: 2, healthyCount: 49 });
    expect(data.unhealthyPods.map((entry: any) => entry.name)).toEqual(['pod-0', 'pod-1']);
    expect(data.healthyPods[0]).toEqual({ name: 'pod-2', phase: 'Running', ready: '1/1' });
    expect(displayText(result)).toContain('Unhealthy:\n  - pod-0: Pending');
    expect(displayText(result)).toContain('ImagePullBackOff');
    expect(mockK8sClient.coreApi.listNamespacedPod).toHaveBeenCalledWith(
      'test-ns',
      undefined,
      undefined,
      undefined,
      undefined,
      'app=api'
    );
  });

  it('omits an empty unhealthy heading for a large healthy pod list and defaults missing status counters', async () => {
    const healthyPods = Array.from({ length: 51 }, (_, index) => ({
      metadata: { name: `healthy-${index}` },
      status: { phase: 'Running' },
    }));
    mockK8sClient.coreApi.listNamespacedPod.mockResolvedValue({ body: { items: healthyPods } });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'pods' });
    const data = agentData(result);
    expect(data).toMatchObject({ total: 51, unhealthyCount: 0, healthyCount: 51 });
    expect(data.healthyPods[0]).toEqual({ name: 'healthy-0', phase: 'Running', ready: '0/0' });
    expect(displayText(result)).toBe('51 pods (0 unhealthy, 51 healthy)');
  });

  it('renders terminated and previous termination reasons in compact pod display text', async () => {
    mockK8sClient.coreApi.listNamespacedPod.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'terminated' },
            status: {
              phase: 'Failed',
              containerStatuses: [
                {
                  name: 'api',
                  ready: false,
                  restartCount: 1,
                  state: { terminated: { reason: 'Error' } },
                },
              ],
            },
          },
          {
            metadata: { name: 'previous' },
            status: {
              phase: 'Running',
              containerStatuses: [
                {
                  name: 'worker',
                  ready: false,
                  restartCount: 1,
                  state: { running: {} },
                  lastState: { terminated: { reason: 'Completed', exitCode: 0 } },
                },
              ],
            },
          },
        ],
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'pods' });
    expect(displayText(result)).toContain('api: Error');
    expect(displayText(result)).toContain('worker: last Completed (exit 0)');
  });

  it('returns complete deployment diagnostics for a named deployment', async () => {
    mockK8sClient.appsApi.readNamespacedDeployment.mockResolvedValue({
      body: {
        metadata: { name: 'api' },
        spec: {
          replicas: 0,
          strategy: { type: 'Recreate' },
          template: {
            spec: {
              containers: [
                {
                  name: 'app',
                  image: 'api:sha',
                  env: [{ name: 'PORT', value: '3000' }],
                  resources: { requests: { cpu: '100m' } },
                  readinessProbe: { httpGet: { path: '/ready' } },
                  livenessProbe: { httpGet: { path: '/health' } },
                  command: ['node'],
                  args: ['server.js'],
                  ports: [{ containerPort: 3000 }],
                },
              ],
            },
          },
        },
        status: {
          replicas: 0,
          readyReplicas: 0,
          availableReplicas: 0,
          updatedReplicas: 0,
          conditions: [
            { type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable', message: 'waiting' },
          ],
        },
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'deployment', name: 'api' });
    expect(agentData(result).deployment).toEqual({
      name: 'api',
      replicas: { desired: 0, current: 0, ready: 0, available: 0, updated: 0 },
      conditions: [{ type: 'Available', status: 'False', reason: 'MinimumReplicasUnavailable', message: 'waiting' }],
      strategy: 'Recreate',
      containers: [
        {
          name: 'app',
          image: 'api:sha',
          envNames: ['PORT'],
          resources: { requests: { cpu: '100m' } },
          readinessProbe: { httpGet: { path: '/ready' } },
          livenessProbe: { httpGet: { path: '/health' } },
          command: ['node'],
          args: ['server.js'],
          ports: [3000],
        },
      ],
    });
    expect(displayText(result)).toBe('Deployment: api (0/0 ready)');
  });

  it('summarizes large deployment lists and distinguishes ready from unavailable replicas', async () => {
    const deployments = Array.from({ length: 51 }, (_, index) => ({
      metadata: { name: `deployment-${index}` },
      spec: { replicas: 2 },
      status: { readyReplicas: 2, availableReplicas: 2 },
    }));
    deployments[0].status.readyReplicas = 1;
    deployments[1].status.availableReplicas = 1;
    mockK8sClient.appsApi.listNamespacedDeployment.mockResolvedValueOnce({ body: { items: deployments } });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'deployments' });
    const data = agentData(result);
    expect(data).toMatchObject({ total: 51, unhealthyCount: 2, healthyCount: 49 });
    expect(data.unhealthyDeployments.map((entry: any) => entry.name)).toEqual(['deployment-0', 'deployment-1']);
    expect(data.healthyDeployments[0]).toEqual({ name: 'deployment-2', ready: '2/2' });
    expect(displayText(result)).toContain('Unhealthy:\n  - deployment-0: 1/2 ready');

    const healthy = deployments.map((deployment) => ({
      ...deployment,
      status: { readyReplicas: 2, availableReplicas: 2 },
    }));
    mockK8sClient.appsApi.listNamespacedDeployment.mockResolvedValueOnce({ body: { items: healthy } });
    const healthyResult = await tool.execute({ namespace: 'test-ns', resource_type: 'deployments' });
    expect(displayText(healthyResult)).toBe('51 deployments (0 unhealthy, 51 healthy)');
  });

  it('summarizes large service lists and forwards label selectors', async () => {
    const services = Array.from({ length: 51 }, (_, index) => ({
      metadata: { name: `service-${index}` },
      spec: index === 0 ? { type: 'ClusterIP' } : { type: 'ClusterIP', ports: [{ port: 80 + index }] },
    }));
    mockK8sClient.coreApi.listNamespacedService.mockResolvedValue({ body: { items: services } });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'service', label_selector: 'tier=api' });
    const data = agentData(result);
    expect(data.total).toBe(51);
    expect(data.services[0]).toEqual({ name: 'service-0', type: 'ClusterIP' });
    expect(data.services[1]).toEqual({ name: 'service-1', type: 'ClusterIP', ports: [81] });
    expect(displayText(result)).toBe('Found 51 services');
    expect(mockK8sClient.coreApi.listNamespacedService).toHaveBeenCalledWith(
      'test-ns',
      undefined,
      undefined,
      undefined,
      undefined,
      'tier=api'
    );
  });

  it('maps ingress rules, paths, class, and TLS without assuming optional rules', async () => {
    mockK8sClient.networkingApi.listNamespacedIngress.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'public' },
            spec: {
              rules: [
                { host: 'api.example.com', http: { paths: [{ path: '/' }, { path: '/health' }] } },
                { host: 'empty.example.com' },
              ],
              ingressClassName: 'nginx',
              tls: [{ hosts: ['api.example.com'], secretName: 'api-tls' }],
            },
          },
          { metadata: { name: 'internal' }, spec: {} },
        ],
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'ingresses', label_selector: 'app=api' });
    expect(agentData(result)).toEqual({
      success: true,
      ingresses: [
        {
          name: 'public',
          hosts: ['api.example.com', 'empty.example.com'],
          paths: ['/', '/health'],
          ingressClassName: 'nginx',
          tls: [{ hosts: ['api.example.com'], secretName: 'api-tls' }],
        },
        { name: 'internal', hosts: [], paths: [] },
      ],
      count: 2,
    });
    expect(displayText(result)).toBe('Found 2 ingresses');
  });

  it('returns ConfigMap keys and aggregate value size without leaking absent data assumptions', async () => {
    mockK8sClient.coreApi.listNamespacedConfigMap.mockResolvedValue({
      body: {
        items: [
          { metadata: { name: 'app-config' }, data: { HOST: 'example.com', PORT: '3000' } },
          { metadata: { name: 'empty' } },
        ],
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'configmaps', label_selector: 'app=api' });
    expect(agentData(result).configmaps).toEqual([
      { name: 'app-config', keys: ['HOST', 'PORT'], dataSize: 15 },
      { name: 'empty', keys: [], dataSize: 0 },
    ]);
    expect(displayText(result)).toBe('Found 2 configmaps');
    expect(mockK8sClient.coreApi.listNamespacedConfigMap).toHaveBeenCalledWith(
      'test-ns',
      undefined,
      undefined,
      undefined,
      undefined,
      'app=api'
    );
  });

  it('sorts jobs newest-first and defaults missing status counts', async () => {
    mockK8sClient.batchApi.listNamespacedJob.mockResolvedValue({
      body: {
        items: [
          { metadata: { name: 'old', namespace: 'test-ns' }, status: { startTime: '2026-01-01T00:00:00Z' } },
          {
            metadata: { name: 'new', namespace: 'test-ns', labels: { app: 'api' } },
            status: {
              active: 1,
              succeeded: 2,
              failed: 3,
              startTime: '2026-01-02T00:00:00Z',
              completionTime: '2026-01-02T00:01:00Z',
              conditions: [{ type: 'Complete' }],
            },
          },
          { metadata: { name: 'undated', namespace: 'test-ns' } },
        ],
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'jobs', label_selector: 'app=api' });
    const data = agentData(result);
    expect(data.jobs.map((job: any) => job.name)).toEqual(['new', 'old', 'undated']);
    expect(data.jobs[0]).toMatchObject({ active: 1, succeeded: 2, failed: 3, labels: { app: 'api' } });
    expect(data.jobs[2]).toMatchObject({ active: 0, succeeded: 0, failed: 0 });
    expect(data.note).toContain('newest first');
    expect(displayText(result)).toBe('Found 3 jobs');
  });

  it('bounds large job diagnostics while retaining failed, active, and recent subsets', async () => {
    const jobs = Array.from({ length: 55 }, (_, index) => ({
      metadata: { name: `job-${index}`, namespace: 'test-ns' },
      status: {
        startTime: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        failed: index < 25 ? 1 : 0,
        active: index >= 25 && index < 30 ? 1 : 0,
      },
    }));
    mockK8sClient.batchApi.listNamespacedJob.mockResolvedValue({ body: { items: jobs } });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'job' });
    const data = agentData(result);
    expect(data).toMatchObject({ total: 55, failedCount: 25, activeCount: 5 });
    expect(data.failedJobs).toHaveLength(20);
    expect(data.activeJobs).toHaveLength(5);
    expect(data.recentJobs).toHaveLength(20);
    expect(data.recentJobs[0].name).toBe('job-54');
    expect(displayText(result)).toBe('K8s job result');
  });

  it('maps StatefulSet, DaemonSet, and ReplicaSet state and defaults absent counters', async () => {
    mockK8sClient.appsApi.listNamespacedStatefulSet.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'database' },
            spec: { replicas: 2, serviceName: 'database-headless' },
            status: { readyReplicas: 1, replicas: 2 },
          },
          { metadata: { name: 'empty' }, spec: {} },
        ],
      },
    });
    mockK8sClient.appsApi.listNamespacedDaemonSet.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'node-agent' },
            status: { desiredNumberScheduled: 3, currentNumberScheduled: 2, numberReady: 1, numberAvailable: 1 },
          },
          { metadata: { name: 'empty' }, status: {} },
        ],
      },
    });
    mockK8sClient.appsApi.listNamespacedReplicaSet.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'api-abc', ownerReferences: [{ kind: 'Deployment', name: 'api' }] },
            spec: { replicas: 3 },
            status: { readyReplicas: 2, availableReplicas: 1 },
          },
          { metadata: { name: 'empty' }, spec: {}, status: {} },
        ],
      },
    });

    const stateful = await tool.execute({
      namespace: 'test-ns',
      resource_type: 'statefulsets',
      label_selector: 'app=db',
    });
    expect(agentData(stateful).statefulsets).toEqual([
      {
        name: 'database',
        replicas: { desired: 2, ready: 1, current: 2 },
        serviceName: 'database-headless',
      },
      { name: 'empty', replicas: { desired: 0, ready: 0, current: 0 } },
    ]);
    expect(displayText(stateful)).toBe('Found 2 statefulsets');

    const daemon = await tool.execute({
      namespace: 'test-ns',
      resource_type: 'daemonsets',
      label_selector: 'all=true',
    });
    expect(agentData(daemon).daemonsets).toEqual([
      { name: 'node-agent', desired: 3, current: 2, ready: 1, available: 1 },
      { name: 'empty', desired: 0, current: 0, ready: 0, available: 0 },
    ]);
    expect(displayText(daemon)).toBe('Found 2 daemonsets');

    const replica = await tool.execute({
      namespace: 'test-ns',
      resource_type: 'replicasets',
      label_selector: 'app=api',
    });
    expect(agentData(replica).replicasets).toEqual([
      {
        name: 'api-abc',
        replicas: { desired: 3, ready: 2, available: 1 },
        ownerReferences: [{ kind: 'Deployment', name: 'api' }],
      },
      { name: 'empty', replicas: { desired: 0, ready: 0, available: 0 } },
    ]);
    expect(displayText(replica)).toBe('Found 2 replicasets');
  });

  it('sorts events by their available timestamp and bounds warning and normal output', async () => {
    const warnings = Array.from({ length: 51 }, (_, index) => ({
      type: 'Warning',
      reason: `Warning-${index}`,
      message: 'warning',
      count: 1,
      involvedObject: { kind: 'Pod', name: `pod-${index}` },
      lastTimestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    }));
    const normal = Array.from({ length: 11 }, (_, index) => ({
      type: 'Normal',
      reason: `Normal-${index}`,
      message: 'normal',
      count: 1,
      involvedObject: index === 10 ? undefined : { kind: 'Pod', name: `pod-${index}` },
      eventTime: index === 10 ? undefined : new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    }));
    mockK8sClient.coreApi.listNamespacedEvent.mockResolvedValue({ body: { items: [...normal, ...warnings] } });

    const result = await tool.execute({
      namespace: 'test-ns',
      resource_type: 'events',
      field_selector: 'involvedObject.name=api',
    });
    const data = agentData(result);
    expect(data).toMatchObject({ total: 62, warningCount: 51, normalCount: 11 });
    expect(data.warnings).toHaveLength(50);
    expect(data.recentNormal).toHaveLength(10);
    expect(data.warnings[0].reason).toBe('Warning-50');
    expect(data.recentNormal[0].reason).toBe('Normal-9');
    expect(displayText(result)).toBe('62 events (51 warnings, 11 normal)');
    expect(mockK8sClient.coreApi.listNamespacedEvent).toHaveBeenCalledWith(
      'test-ns',
      undefined,
      undefined,
      undefined,
      'involvedObject.name=api'
    );
  });

  it('keeps partial Kubernetes objects inspectable using the tool’s documented zero and empty fallbacks', async () => {
    mockK8sClient.coreApi.listNamespacedPod.mockResolvedValueOnce({
      body: {
        items: [
          {},
          {
            metadata: { name: 'ready-without-state' },
            status: {
              phase: 'Running',
              containerStatuses: [{ name: 'sidecar', ready: true, restartCount: 0 }],
            },
          },
        ],
      },
    });
    const pods = await tool.execute({ namespace: 'test-ns', resource_type: 'pods' });
    expect(agentData(pods).pods).toEqual([
      { ready: '0/0', restarts: 0 },
      {
        name: 'ready-without-state',
        phase: 'Running',
        ready: '1/1',
        restarts: 0,
        containers: [{ name: 'sidecar', ready: true, restarts: 0 }],
      },
    ]);

    mockK8sClient.coreApi.readNamespacedPod.mockResolvedValueOnce({ body: {} });
    const pod = await tool.execute({ namespace: 'test-ns', resource_type: 'pods', name: 'partial' });
    expect(agentData(pod)).toEqual({ success: true, pod: {} });

    mockK8sClient.appsApi.listNamespacedDeployment.mockResolvedValueOnce({ body: { items: [{}] } });
    const deployments = await tool.execute({ namespace: 'test-ns', resource_type: 'deployments' });
    expect(agentData(deployments).deployments).toEqual([{ replicas: { desired: 0, ready: 0, available: 0 } }]);

    mockK8sClient.appsApi.readNamespacedDeployment.mockResolvedValueOnce({ body: {} });
    const deployment = await tool.execute({ namespace: 'test-ns', resource_type: 'deployments', name: 'partial' });
    expect(agentData(deployment).deployment).toEqual({
      replicas: { desired: 0, current: 0, ready: 0, available: 0, updated: 0 },
    });

    mockK8sClient.coreApi.listNamespacedService.mockResolvedValueOnce({ body: { items: [{}] } });
    const services = await tool.execute({ namespace: 'test-ns', resource_type: 'services' });
    expect(agentData(services).services).toEqual([{}]);

    mockK8sClient.networkingApi.listNamespacedIngress.mockResolvedValueOnce({ body: { items: [{}] } });
    const ingresses = await tool.execute({ namespace: 'test-ns', resource_type: 'ingresses' });
    expect(agentData(ingresses).ingresses).toEqual([{ hosts: [], paths: [] }]);

    mockK8sClient.coreApi.listNamespacedSecret.mockResolvedValueOnce({ body: { items: [{}] } });
    const secrets = await tool.execute({ namespace: 'test-ns', resource_type: 'secrets' });
    expect(agentData(secrets).secrets).toEqual([{ keys: [] }]);

    mockK8sClient.coreApi.listNamespacedConfigMap.mockResolvedValueOnce({ body: { items: [{}] } });
    const configmaps = await tool.execute({ namespace: 'test-ns', resource_type: 'configmaps' });
    expect(agentData(configmaps).configmaps).toEqual([{ keys: [], dataSize: 0 }]);

    mockK8sClient.batchApi.listNamespacedJob.mockResolvedValueOnce({ body: { items: [{}, {}] } });
    const jobs = await tool.execute({ namespace: 'test-ns', resource_type: 'jobs' });
    expect(agentData(jobs).jobs).toEqual([
      { active: 0, succeeded: 0, failed: 0 },
      { active: 0, succeeded: 0, failed: 0 },
    ]);

    mockK8sClient.appsApi.listNamespacedStatefulSet.mockResolvedValueOnce({ body: { items: [{}] } });
    const statefulsets = await tool.execute({ namespace: 'test-ns', resource_type: 'statefulsets' });
    expect(agentData(statefulsets).statefulsets).toEqual([{ replicas: { desired: 0, ready: 0, current: 0 } }]);

    mockK8sClient.appsApi.listNamespacedDaemonSet.mockResolvedValueOnce({ body: { items: [{}] } });
    const daemonsets = await tool.execute({ namespace: 'test-ns', resource_type: 'daemonsets' });
    expect(agentData(daemonsets).daemonsets).toEqual([{ desired: 0, current: 0, ready: 0, available: 0 }]);

    mockK8sClient.appsApi.listNamespacedReplicaSet.mockResolvedValueOnce({ body: { items: [{}] } });
    const replicasets = await tool.execute({ namespace: 'test-ns', resource_type: 'replicasets' });
    expect(agentData(replicasets).replicasets).toEqual([{ replicas: { desired: 0, ready: 0, available: 0 } }]);

    mockK8sClient.coreApi.listNamespacedEvent.mockResolvedValueOnce({ body: { items: [{}, {}] } });
    const events = await tool.execute({ namespace: 'test-ns', resource_type: 'events' });
    expect(agentData(events)).toMatchObject({ total: 2, warningCount: 0, normalCount: 2 });
  });

  it('formats each available container termination reason with and without an exit code', async () => {
    mockK8sClient.coreApi.listNamespacedPod.mockResolvedValue({
      body: {
        items: [
          {
            metadata: { name: 'terminated-with-code' },
            status: {
              phase: 'Failed',
              containerStatuses: [
                {
                  name: 'api',
                  ready: false,
                  restartCount: 1,
                  state: { terminated: { reason: 'Error', exitCode: 2 } },
                },
              ],
            },
          },
          {
            metadata: { name: 'previous-without-code' },
            status: {
              phase: 'Running',
              containerStatuses: [
                {
                  name: 'worker',
                  ready: false,
                  restartCount: 1,
                  state: { running: {} },
                  lastState: { terminated: { reason: 'OOMKilled' } },
                },
              ],
            },
          },
        ],
      },
    });

    const result = await tool.execute({ namespace: 'test-ns', resource_type: 'pods' });
    expect(displayText(result)).toContain('api: Error (exit 2)');
    expect(displayText(result)).toContain('worker: last OOMKilled');
    expect(displayText(result)).not.toContain('OOMKilled (exit');
  });
});
