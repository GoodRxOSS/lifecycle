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
import { AGENT_EDITOR_WORKSPACE_FILE } from '../workspace';

const mockCreatePod = jest.fn();
const mockReadPod = jest.fn();
const mockDeletePod = jest.fn();
const mockReadPodLog = jest.fn();

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node');
  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockReturnValue({
        createNamespacedPod: mockCreatePod,
        readNamespacedPod: mockReadPod,
        readNamespacedPodLog: mockReadPodLog,
        deleteNamespacedPod: mockDeletePod,
      }),
    })),
  };
});

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { buildAgentPodSpec, createAgentPod, deleteAgentPod, AgentPodOpts } from '../podFactory';

const baseOpts: AgentPodOpts = {
  podName: 'agent-abc123',
  namespace: 'test-ns',
  pvcName: 'agent-pvc-abc123',
  image: 'lifecycle-agent:latest',
  editorImage: 'codercom/code-server:4.98.2',
  apiKeySecretName: 'agent-secret-abc123',
  hasGitHubToken: true,
  model: 'claude-sonnet-4-20250514',
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'feature/test',
  workspacePath: '/workspace',
  userIdentity: {
    userId: 'user-123',
    githubUsername: 'sample-user',
    preferredUsername: 'sample-user',
    email: 'sample-user@example.com',
    firstName: 'Sample',
    lastName: 'User',
    displayName: 'Sample User',
    gitUserName: 'Sample User',
    gitUserEmail: 'sample-user@example.com',
  },
};

function getInitContainer(pod: k8s.V1Pod, name: string): k8s.V1Container {
  const container = pod.spec!.initContainers!.find((entry) => entry.name === name);
  if (!container) {
    throw new Error(`Init container not found: ${name}`);
  }

  return container;
}

describe('podFactory', () => {
  const originalTimeout = process.env.AGENT_POD_READY_TIMEOUT_MS;
  const originalPoll = process.env.AGENT_POD_READY_POLL_MS;
  const originalCpuRequest = process.env.AGENT_POD_CPU_REQUEST;
  const originalCpuLimit = process.env.AGENT_POD_CPU_LIMIT;
  const originalMemoryRequest = process.env.AGENT_POD_MEMORY_REQUEST;
  const originalMemoryLimit = process.env.AGENT_POD_MEMORY_LIMIT;
  const originalNodeOptions = process.env.AGENT_NODE_OPTIONS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AGENT_POD_READY_TIMEOUT_MS = '10';
    process.env.AGENT_POD_READY_POLL_MS = '0';
    delete process.env.AGENT_POD_CPU_REQUEST;
    delete process.env.AGENT_POD_CPU_LIMIT;
    delete process.env.AGENT_POD_MEMORY_REQUEST;
    delete process.env.AGENT_POD_MEMORY_LIMIT;
    delete process.env.AGENT_NODE_OPTIONS;
    mockReadPod.mockResolvedValue({
      body: {
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      },
    });
    mockReadPodLog.mockResolvedValue({ body: 'init logs' });
  });

  afterAll(() => {
    if (originalTimeout === undefined) delete process.env.AGENT_POD_READY_TIMEOUT_MS;
    else process.env.AGENT_POD_READY_TIMEOUT_MS = originalTimeout;
    if (originalPoll === undefined) delete process.env.AGENT_POD_READY_POLL_MS;
    else process.env.AGENT_POD_READY_POLL_MS = originalPoll;
    if (originalCpuRequest === undefined) delete process.env.AGENT_POD_CPU_REQUEST;
    else process.env.AGENT_POD_CPU_REQUEST = originalCpuRequest;
    if (originalCpuLimit === undefined) delete process.env.AGENT_POD_CPU_LIMIT;
    else process.env.AGENT_POD_CPU_LIMIT = originalCpuLimit;
    if (originalMemoryRequest === undefined) delete process.env.AGENT_POD_MEMORY_REQUEST;
    else process.env.AGENT_POD_MEMORY_REQUEST = originalMemoryRequest;
    if (originalMemoryLimit === undefined) delete process.env.AGENT_POD_MEMORY_LIMIT;
    else process.env.AGENT_POD_MEMORY_LIMIT = originalMemoryLimit;
    if (originalNodeOptions === undefined) delete process.env.AGENT_NODE_OPTIONS;
    else process.env.AGENT_NODE_OPTIONS = originalNodeOptions;
  });

  describe('buildAgentPodSpec', () => {
    it('creates a pod with init and main containers', () => {
      const pod = buildAgentPodSpec(baseOpts);
      expect(pod.spec!.initContainers).toHaveLength(3);
      expect(pod.spec!.containers).toHaveLength(2);
      expect(pod.spec!.initContainers!.map((container) => container.name)).toEqual([
        'prepare-workspace',
        'init-workspace',
        'prepare-editor-workspace',
      ]);
      expect(pod.spec!.containers[0].name).toBe('agent');
      expect(pod.spec!.containers[1].name).toBe('editor');
    });

    it('main container runs sleep infinity', () => {
      const pod = buildAgentPodSpec(baseOpts);
      expect(pod.spec!.containers[0].command).toEqual(['sleep', 'infinity']);
      expect(pod.spec!.containers[0].imagePullPolicy).toBe('IfNotPresent');
      expect(getInitContainer(pod, 'init-workspace').imagePullPolicy).toBe('IfNotPresent');
    });

    it('mounts PVC as workspace volume', () => {
      const pod = buildAgentPodSpec(baseOpts);
      const workspaceVolume = pod.spec!.volumes!.find((v: any) => v.name === 'workspace');
      expect(workspaceVolume).toBeDefined();
      expect(workspaceVolume!.persistentVolumeClaim!.claimName).toBe('agent-pvc-abc123');
    });

    it('includes claude-config emptyDir volume', () => {
      const pod = buildAgentPodSpec(baseOpts);
      const configVolume = pod.spec!.volumes!.find((v: any) => v.name === 'claude-config');
      expect(configVolume).toBeDefined();
      expect(configVolume!.emptyDir).toEqual({});
    });

    it('includes writable tmp emptyDir volume', () => {
      const pod = buildAgentPodSpec(baseOpts);
      const tmpVolume = pod.spec!.volumes!.find((v: any) => v.name === 'tmp');
      expect(tmpVolume).toBeDefined();
      expect(tmpVolume!.emptyDir).toEqual({});
    });

    it('includes editor-home emptyDir volume', () => {
      const pod = buildAgentPodSpec(baseOpts);
      const editorHomeVolume = pod.spec!.volumes!.find((v: any) => v.name === 'editor-home');
      expect(editorHomeVolume).toBeDefined();
      expect(editorHomeVolume!.emptyDir).toEqual({});
    });

    it('sets security context with non-root UID 1000', () => {
      const pod = buildAgentPodSpec(baseOpts);
      const mainSec = pod.spec!.containers[0].securityContext!;
      expect(mainSec.runAsUser).toBe(1000);
      expect(mainSec.runAsNonRoot).toBe(true);
      expect(mainSec.readOnlyRootFilesystem).toBe(true);
      expect(mainSec.capabilities!.drop).toEqual(['ALL']);
      expect(mainSec.allowPrivilegeEscalation).toBe(false);
    });

    it('sets pod-level seccomp profile', () => {
      const pod = buildAgentPodSpec(baseOpts);
      expect(pod.spec!.securityContext!.seccompProfile).toEqual({ type: 'RuntimeDefault' });
    });

    it('does not set a nodeSelector by default', () => {
      const pod = buildAgentPodSpec(baseOpts);

      expect(pod.spec!.nodeSelector).toBeUndefined();
    });

    it('applies a configured nodeSelector when provided', () => {
      const pod = buildAgentPodSpec({
        ...baseOpts,
        nodeSelector: {
          'app-long': 'deployments-m7i',
        },
      });

      expect(pod.spec!.nodeSelector).toEqual({
        'app-long': 'deployments-m7i',
      });
    });

    it('applies a configured service account when provided', () => {
      const pod = buildAgentPodSpec({
        ...baseOpts,
        serviceAccountName: 'agent-sa',
      });

      expect(pod.spec!.serviceAccountName).toBe('agent-sa');
    });

    it('sets ANTHROPIC_API_KEY from a secret and CLAUDE_MODEL as an env var', () => {
      const pod = buildAgentPodSpec(baseOpts);
      const envVars = pod.spec!.containers[0].env;
      expect(envVars).toEqual(
        expect.arrayContaining([
          {
            name: 'GITHUB_TOKEN',
            valueFrom: {
              secretKeyRef: {
                key: 'GITHUB_TOKEN',
                name: 'agent-secret-abc123',
              },
            },
          },
          {
            name: 'GH_TOKEN',
            valueFrom: {
              secretKeyRef: {
                key: 'GITHUB_TOKEN',
                name: 'agent-secret-abc123',
              },
            },
          },
          {
            name: 'ANTHROPIC_API_KEY',
            valueFrom: {
              secretKeyRef: {
                key: 'ANTHROPIC_API_KEY',
                name: 'agent-secret-abc123',
              },
            },
          },
          { name: 'CLAUDE_MODEL', value: 'claude-sonnet-4-20250514' },
          { name: 'HOME', value: '/home/claude/.claude' },
          { name: 'TMPDIR', value: '/tmp' },
          { name: 'TMP', value: '/tmp' },
          { name: 'TEMP', value: '/tmp' },
          { name: 'NODE_OPTIONS', value: '--max-old-space-size=2048' },
          { name: 'LIFECYCLE_USER_ID', value: 'user-123' },
          { name: 'LIFECYCLE_GITHUB_USERNAME', value: 'sample-user' },
          { name: 'LIFECYCLE_USER_EMAIL', value: 'sample-user@example.com' },
          { name: 'LIFECYCLE_USER_NAME', value: 'Sample User' },
          { name: 'GIT_AUTHOR_NAME', value: 'Sample User' },
          { name: 'GIT_AUTHOR_EMAIL', value: 'sample-user@example.com' },
          { name: 'GIT_COMMITTER_NAME', value: 'Sample User' },
          { name: 'GIT_COMMITTER_EMAIL', value: 'sample-user@example.com' },
        ])
      );
    });

    it('passes user identity env vars to the init container', () => {
      const pod = buildAgentPodSpec(baseOpts);
      expect(getInitContainer(pod, 'init-workspace').env).toEqual(
        expect.arrayContaining([
          {
            name: 'GITHUB_TOKEN',
            valueFrom: {
              secretKeyRef: {
                key: 'GITHUB_TOKEN',
                name: 'agent-secret-abc123',
              },
            },
          },
          {
            name: 'GH_TOKEN',
            valueFrom: {
              secretKeyRef: {
                key: 'GITHUB_TOKEN',
                name: 'agent-secret-abc123',
              },
            },
          },
          { name: 'LIFECYCLE_USER_ID', value: 'user-123' },
          { name: 'GIT_AUTHOR_NAME', value: 'Sample User' },
          { name: 'GIT_AUTHOR_EMAIL', value: 'sample-user@example.com' },
        ])
      );
    });

    it('forwards plain and secret-ref agent env vars into init and agent containers', () => {
      const pod = buildAgentPodSpec({
        ...baseOpts,
        forwardedAgentEnv: {
          PACKAGE_REGISTRY_TOKEN: 'plain-token',
          PRIVATE_REGISTRY_TOKEN: '{{aws:apps/sample:token}}',
        },
        forwardedAgentSecretRefs: [
          {
            envKey: 'PRIVATE_REGISTRY_TOKEN',
            provider: 'aws',
            path: 'apps/sample',
            key: 'token',
          },
        ],
        forwardedAgentSecretServiceName: 'agent-env-abc123',
      });

      expect(getInitContainer(pod, 'init-workspace').env).toEqual(
        expect.arrayContaining([
          {
            name: 'PACKAGE_REGISTRY_TOKEN',
            valueFrom: {
              secretKeyRef: {
                name: 'agent-secret-abc123',
                key: 'PACKAGE_REGISTRY_TOKEN',
              },
            },
          },
          {
            name: 'PRIVATE_REGISTRY_TOKEN',
            valueFrom: {
              secretKeyRef: {
                name: 'agent-env-abc123-aws-secrets',
                key: 'PRIVATE_REGISTRY_TOKEN',
              },
            },
          },
        ])
      );
      expect(pod.spec!.containers[0].env).toEqual(
        expect.arrayContaining([
          {
            name: 'PACKAGE_REGISTRY_TOKEN',
            valueFrom: {
              secretKeyRef: {
                name: 'agent-secret-abc123',
                key: 'PACKAGE_REGISTRY_TOKEN',
              },
            },
          },
          {
            name: 'PRIVATE_REGISTRY_TOKEN',
            valueFrom: {
              secretKeyRef: {
                name: 'agent-env-abc123-aws-secrets',
                key: 'PRIVATE_REGISTRY_TOKEN',
              },
            },
          },
        ])
      );
    });

    it('omits GitHub token secret refs when token forwarding is disabled', () => {
      const pod = buildAgentPodSpec({ ...baseOpts, hasGitHubToken: false });
      const agentEnv = pod.spec!.containers[0].env || [];
      const initEnv = getInitContainer(pod, 'init-workspace').env || [];

      expect(agentEnv.find((env) => env.name === 'GITHUB_TOKEN')).toBeUndefined();
      expect(agentEnv.find((env) => env.name === 'GH_TOKEN')).toBeUndefined();
      expect(initEnv.find((env) => env.name === 'GITHUB_TOKEN')).toBeUndefined();
      expect(initEnv.find((env) => env.name === 'GH_TOKEN')).toBeUndefined();
    });

    it('mounts writable /tmp in both init and main containers', () => {
      const pod = buildAgentPodSpec(baseOpts);
      expect(getInitContainer(pod, 'prepare-workspace').volumeMounts).toEqual(
        expect.arrayContaining([
          { name: 'workspace', mountPath: '/workspace-volume' },
          { name: 'tmp', mountPath: '/tmp' },
        ])
      );
      expect(getInitContainer(pod, 'init-workspace').volumeMounts).toEqual(
        expect.arrayContaining([{ name: 'tmp', mountPath: '/tmp' }])
      );
      expect(pod.spec!.containers[0].volumeMounts).toEqual(
        expect.arrayContaining([{ name: 'tmp', mountPath: '/tmp' }])
      );
      expect(pod.spec!.containers[1].volumeMounts).toEqual(
        expect.arrayContaining([{ name: 'tmp', mountPath: '/tmp' }])
      );
    });

    it('sets default resource requests and limits for init and agent containers', () => {
      const pod = buildAgentPodSpec(baseOpts);
      const expectedResources = {
        requests: {
          cpu: '500m',
          memory: '1Gi',
        },
        limits: {
          cpu: '2',
          memory: '4Gi',
        },
      };

      expect(getInitContainer(pod, 'prepare-workspace').resources).toEqual(expectedResources);
      expect(getInitContainer(pod, 'init-workspace').resources).toEqual(expectedResources);
      expect(pod.spec!.containers[0].resources).toEqual(expectedResources);
      expect(pod.spec!.containers[1].resources).toEqual({
        requests: {
          cpu: '250m',
          memory: '512Mi',
        },
        limits: {
          cpu: '1',
          memory: '1Gi',
        },
      });
    });

    it('allows agent resource and node option overrides through env vars', () => {
      process.env.AGENT_POD_CPU_REQUEST = '750m';
      process.env.AGENT_POD_CPU_LIMIT = '3';
      process.env.AGENT_POD_MEMORY_REQUEST = '2Gi';
      process.env.AGENT_POD_MEMORY_LIMIT = '6Gi';
      process.env.AGENT_NODE_OPTIONS = '--max-old-space-size=3072';

      const pod = buildAgentPodSpec(baseOpts);

      expect(pod.spec!.containers[0].resources).toEqual({
        requests: {
          cpu: '750m',
          memory: '2Gi',
        },
        limits: {
          cpu: '3',
          memory: '6Gi',
        },
      });
      expect(pod.spec!.containers[0].env).toEqual(
        expect.arrayContaining([{ name: 'NODE_OPTIONS', value: '--max-old-space-size=3072' }])
      );
      expect(pod.spec!.containers[1].resources).toEqual({
        requests: {
          cpu: '250m',
          memory: '512Mi',
        },
        limits: {
          cpu: '1',
          memory: '1Gi',
        },
      });
    });

    it('prefers explicit agent-session resource overrides when provided', () => {
      const pod = buildAgentPodSpec({
        ...baseOpts,
        resources: {
          agent: {
            requests: {
              cpu: '1',
              memory: '2Gi',
            },
            limits: {
              cpu: '4',
              memory: '8Gi',
            },
          },
          editor: {
            requests: {
              cpu: '500m',
              memory: '1Gi',
            },
            limits: {
              cpu: '2',
              memory: '2Gi',
            },
          },
        },
      });

      expect(getInitContainer(pod, 'prepare-workspace').resources).toEqual({
        requests: {
          cpu: '1',
          memory: '2Gi',
        },
        limits: {
          cpu: '4',
          memory: '8Gi',
        },
      });
      expect(getInitContainer(pod, 'init-workspace').resources).toEqual({
        requests: {
          cpu: '1',
          memory: '2Gi',
        },
        limits: {
          cpu: '4',
          memory: '8Gi',
        },
      });
      expect(pod.spec!.containers[0].resources).toEqual({
        requests: {
          cpu: '1',
          memory: '2Gi',
        },
        limits: {
          cpu: '4',
          memory: '8Gi',
        },
      });
      expect(pod.spec!.containers[1].resources).toEqual({
        requests: {
          cpu: '500m',
          memory: '1Gi',
        },
        limits: {
          cpu: '2',
          memory: '2Gi',
        },
      });
    });

    it('starts a code-server editor sidecar on the editor port', () => {
      const pod = buildAgentPodSpec(baseOpts);

      expect(pod.spec!.containers[1]).toEqual(
        expect.objectContaining({
          name: 'editor',
          image: 'codercom/code-server:4.98.2',
          args: [
            AGENT_EDITOR_WORKSPACE_FILE,
            '--auth',
            'none',
            '--bind-addr',
            '0.0.0.0:13337',
            '--disable-telemetry',
            '--disable-update-check',
          ],
          ports: [{ containerPort: 13337, name: 'editor' }],
          readinessProbe: expect.objectContaining({
            httpGet: { path: '/healthz', port: 13337 },
          }),
        })
      );
    });

    it('mounts the repo subpath at /workspace for shared workspace containers', () => {
      const pod = buildAgentPodSpec(baseOpts);
      const initWorkspaceMount = getInitContainer(pod, 'init-workspace').volumeMounts!.find(
        (mount) => mount.name === 'workspace'
      );
      const agentWorkspaceMount = pod.spec!.containers[0].volumeMounts!.find((mount) => mount.name === 'workspace');
      const editorWorkspaceMount = pod.spec!.containers[1].volumeMounts!.find((mount) => mount.name === 'workspace');

      expect(initWorkspaceMount).toEqual({
        name: 'workspace',
        mountPath: '/workspace',
        subPath: 'repo',
      });
      expect(agentWorkspaceMount).toEqual({
        name: 'workspace',
        mountPath: '/workspace',
        subPath: 'repo',
      });
      expect(editorWorkspaceMount).toEqual({
        name: 'workspace',
        mountPath: '/workspace',
        subPath: 'repo',
      });
    });

    it('writes a multi-root editor workspace file before code-server starts', () => {
      const pod = buildAgentPodSpec({
        ...baseOpts,
        workspaceRepos: [
          {
            repo: 'org/repo',
            repoUrl: 'https://github.com/org/repo.git',
            branch: 'feature/test',
            revision: null,
            mountPath: '/workspace',
            primary: true,
          },
          {
            repo: 'org/api',
            repoUrl: 'https://github.com/org/api.git',
            branch: 'feature/api',
            revision: null,
            mountPath: '/workspace/repos/org/api',
            primary: false,
          },
        ],
      });

      expect(getInitContainer(pod, 'prepare-editor-workspace')).toEqual(
        expect.objectContaining({
          command: ['sh', '-c', expect.stringContaining(`cat > '${AGENT_EDITOR_WORKSPACE_FILE}' << 'WORKSPACE_EOF'`)],
          volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
        })
      );
      expect(getInitContainer(pod, 'prepare-editor-workspace').command?.[2]).toContain('"name": "org/repo"');
      expect(getInitContainer(pod, 'prepare-editor-workspace').command?.[2]).toContain(
        '"path": "/workspace/repos/org/api"'
      );
    });

    it('still prepares the editor workspace when workspace bootstrap is skipped', () => {
      const pod = buildAgentPodSpec({
        ...baseOpts,
        skipWorkspaceBootstrap: true,
      });

      expect(pod.spec!.initContainers?.map((container) => container.name)).toEqual(['prepare-editor-workspace']);
    });

    it('does not set runtimeClassName when gVisor not requested', () => {
      const pod = buildAgentPodSpec(baseOpts);
      expect(pod.spec!.runtimeClassName).toBeUndefined();
    });

    it('sets runtimeClassName to gvisor when requested', () => {
      const pod = buildAgentPodSpec({ ...baseOpts, useGvisor: true });
      expect(pod.spec!.runtimeClassName).toBe('gvisor');
    });
  });

  describe('createAgentPod', () => {
    it('creates pod via K8s API', async () => {
      mockCreatePod.mockResolvedValue({ body: { metadata: { name: 'agent-abc123' } } });

      await createAgentPod(baseOpts);

      expect(mockCreatePod).toHaveBeenCalledTimes(1);
      const [ns, podBody] = mockCreatePod.mock.calls[0];
      expect(ns).toBe('test-ns');
      expect(podBody.metadata.name).toBe('agent-abc123');
      expect(mockReadPod).toHaveBeenCalledWith('agent-abc123', 'test-ns');
    });

    it('fails fast when pod enters image pull backoff', async () => {
      mockCreatePod.mockResolvedValue({ body: { metadata: { name: 'agent-abc123' } } });
      mockReadPodLog.mockResolvedValue({ body: 'pull failed for test image' });
      mockReadPod.mockResolvedValue({
        body: {
          status: {
            phase: 'Pending',
            initContainerStatuses: [
              {
                name: 'init-workspace',
                state: {
                  waiting: {
                    reason: 'ImagePullBackOff',
                    message: 'image not found',
                  },
                },
              },
            ],
          },
        },
      });

      await expect(createAgentPod(baseOpts)).rejects.toThrow(
        'Agent pod failed to start: init-workspace: ImagePullBackOff - image not found - pull failed for test image'
      );
      expect(mockReadPodLog).toHaveBeenCalledWith(
        'agent-abc123',
        'test-ns',
        'init-workspace',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        200
      );
    });

    it('prefers explicit readiness overrides over process env defaults', async () => {
      mockCreatePod.mockResolvedValue({ body: { metadata: { name: 'agent-abc123' } } });
      mockReadPod.mockResolvedValue({
        body: {
          status: {
            phase: 'Running',
            initContainerStatuses: [
              {
                name: 'prepare-workspace',
                state: {
                  terminated: {
                    reason: 'Completed',
                    exitCode: 0,
                  },
                },
              },
              {
                name: 'init-workspace',
                state: {
                  terminated: {
                    reason: 'Completed',
                    exitCode: 0,
                  },
                },
              },
            ],
            containerStatuses: [
              {
                name: 'agent',
                state: {
                  running: {
                    startedAt: '2026-03-26T00:00:00Z',
                  },
                },
              },
              {
                name: 'editor',
                state: {
                  running: {
                    startedAt: '2026-03-26T00:00:01Z',
                  },
                },
              },
            ],
          },
        },
      });

      await expect(
        createAgentPod({
          ...baseOpts,
          readiness: {
            timeoutMs: 1,
            pollMs: 0,
          },
        })
      ).rejects.toThrow('Agent pod did not become ready within 1ms');
    });
  });

  describe('deleteAgentPod', () => {
    it('deletes pod via K8s API', async () => {
      mockDeletePod.mockResolvedValue({});

      await deleteAgentPod('test-ns', 'agent-abc123');

      expect(mockDeletePod).toHaveBeenCalledWith('agent-abc123', 'test-ns');
    });

    it('ignores 404 errors', async () => {
      const error = new k8s.HttpError({ statusCode: 404 } as any, 'not found', 404);
      mockDeletePod.mockRejectedValue(error);

      await expect(deleteAgentPod('test-ns', 'agent-abc123')).resolves.toBeUndefined();
    });

    it('rethrows non-404 errors', async () => {
      mockDeletePod.mockRejectedValue(new Error('server error'));

      await expect(deleteAgentPod('test-ns', 'agent-abc123')).rejects.toThrow('server error');
    });
  });
});
