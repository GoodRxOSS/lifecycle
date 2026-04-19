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
import { SESSION_POD_MCP_CONFIG_ENV } from 'server/services/ai/mcp/sessionPod';
import { SESSION_WORKSPACE_HOME_VOLUME_NAME, SESSION_WORKSPACE_SHARED_HOME_DIR } from '../configSeeder';
import { SESSION_WORKSPACE_EDITOR_PROJECT_FILE } from '../workspace';

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

import {
  buildSessionWorkspacePodSpec,
  createSessionWorkspacePod,
  deleteSessionWorkspacePod,
  SessionWorkspacePodOptions,
  SESSION_WORKSPACE_GATEWAY_PORT_NAME,
} from '../podFactory';

const baseOpts: SessionWorkspacePodOptions = {
  podName: 'agent-abc123',
  namespace: 'test-ns',
  pvcName: 'agent-pvc-abc123',
  workspaceImage: 'lifecycle-workspace:latest',
  workspaceEditorImage: 'codercom/code-server:4.98.2',
  apiKeySecretName: 'agent-secret-abc123',
  hasGitHubToken: true,
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

function getContainer(pod: k8s.V1Pod, name: string): k8s.V1Container {
  const container = pod.spec!.containers!.find((entry) => entry.name === name);
  if (!container) {
    throw new Error(`Container not found: ${name}`);
  }

  return container;
}

describe('podFactory', () => {
  const originalTimeout = process.env.AGENT_SESSION_WORKSPACE_READY_TIMEOUT_MS;
  const originalPoll = process.env.AGENT_SESSION_WORKSPACE_READY_POLL_MS;
  const originalCpuRequest = process.env.AGENT_SESSION_WORKSPACE_CPU_REQUEST;
  const originalCpuLimit = process.env.AGENT_SESSION_WORKSPACE_CPU_LIMIT;
  const originalMemoryRequest = process.env.AGENT_SESSION_WORKSPACE_MEMORY_REQUEST;
  const originalMemoryLimit = process.env.AGENT_SESSION_WORKSPACE_MEMORY_LIMIT;
  const originalNodeOptions = process.env.AGENT_SESSION_WORKSPACE_GATEWAY_NODE_OPTIONS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AGENT_SESSION_WORKSPACE_READY_TIMEOUT_MS = '10';
    process.env.AGENT_SESSION_WORKSPACE_READY_POLL_MS = '0';
    delete process.env.AGENT_SESSION_WORKSPACE_CPU_REQUEST;
    delete process.env.AGENT_SESSION_WORKSPACE_CPU_LIMIT;
    delete process.env.AGENT_SESSION_WORKSPACE_MEMORY_REQUEST;
    delete process.env.AGENT_SESSION_WORKSPACE_MEMORY_LIMIT;
    delete process.env.AGENT_SESSION_WORKSPACE_GATEWAY_NODE_OPTIONS;
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
    if (originalTimeout === undefined) delete process.env.AGENT_SESSION_WORKSPACE_READY_TIMEOUT_MS;
    else process.env.AGENT_SESSION_WORKSPACE_READY_TIMEOUT_MS = originalTimeout;
    if (originalPoll === undefined) delete process.env.AGENT_SESSION_WORKSPACE_READY_POLL_MS;
    else process.env.AGENT_SESSION_WORKSPACE_READY_POLL_MS = originalPoll;
    if (originalCpuRequest === undefined) delete process.env.AGENT_SESSION_WORKSPACE_CPU_REQUEST;
    else process.env.AGENT_SESSION_WORKSPACE_CPU_REQUEST = originalCpuRequest;
    if (originalCpuLimit === undefined) delete process.env.AGENT_SESSION_WORKSPACE_CPU_LIMIT;
    else process.env.AGENT_SESSION_WORKSPACE_CPU_LIMIT = originalCpuLimit;
    if (originalMemoryRequest === undefined) delete process.env.AGENT_SESSION_WORKSPACE_MEMORY_REQUEST;
    else process.env.AGENT_SESSION_WORKSPACE_MEMORY_REQUEST = originalMemoryRequest;
    if (originalMemoryLimit === undefined) delete process.env.AGENT_SESSION_WORKSPACE_MEMORY_LIMIT;
    else process.env.AGENT_SESSION_WORKSPACE_MEMORY_LIMIT = originalMemoryLimit;
    if (originalNodeOptions === undefined) delete process.env.AGENT_SESSION_WORKSPACE_GATEWAY_NODE_OPTIONS;
    else process.env.AGENT_SESSION_WORKSPACE_GATEWAY_NODE_OPTIONS = originalNodeOptions;
  });

  describe('buildSessionWorkspacePodSpec', () => {
    it('creates a pod with init and main containers', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      expect(pod.spec!.initContainers).toHaveLength(4);
      expect(pod.spec!.containers).toHaveLength(2);
      expect(pod.spec!.initContainers!.map((container) => container.name)).toEqual([
        'prepare-workspace',
        'init-workspace',
        'seed-runtime-config',
        'prepare-editor-workspace',
      ]);
      expect(pod.spec!.containers!.map((container) => container.name)).toEqual(['editor', 'workspace-gateway']);
    });

    it('runs editor and workspace gateway sidecars with IfNotPresent pull policy', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      expect(getContainer(pod, 'editor').imagePullPolicy).toBe('IfNotPresent');
      expect(getContainer(pod, 'workspace-gateway').imagePullPolicy).toBe('IfNotPresent');
      expect(getInitContainer(pod, 'init-workspace').imagePullPolicy).toBe('IfNotPresent');
    });

    it('mounts PVC as workspace volume', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      const workspaceVolume = pod.spec!.volumes!.find((v: any) => v.name === 'workspace');
      expect(workspaceVolume).toBeDefined();
      expect(workspaceVolume!.persistentVolumeClaim!.claimName).toBe('agent-pvc-abc123');
    });

    it('includes session-home emptyDir volume', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      const configVolume = pod.spec!.volumes!.find((v: any) => v.name === SESSION_WORKSPACE_HOME_VOLUME_NAME);
      expect(configVolume).toBeDefined();
      expect(configVolume!.emptyDir).toEqual({});
    });

    it('includes writable tmp emptyDir volume', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      const tmpVolume = pod.spec!.volumes!.find((v: any) => v.name === 'tmp');
      expect(tmpVolume).toBeDefined();
      expect(tmpVolume!.emptyDir).toEqual({});
    });

    it('includes editor-home emptyDir volume', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      const editorHomeVolume = pod.spec!.volumes!.find((v: any) => v.name === 'editor-home');
      expect(editorHomeVolume).toBeDefined();
      expect(editorHomeVolume!.emptyDir).toEqual({});
    });

    it('sets security context with non-root UID 1000', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      const mainSec = getContainer(pod, 'workspace-gateway').securityContext!;
      expect(mainSec.runAsUser).toBe(1000);
      expect(mainSec.runAsNonRoot).toBe(true);
      expect(mainSec.readOnlyRootFilesystem).toBe(true);
      expect(mainSec.capabilities!.drop).toEqual(['ALL']);
      expect(mainSec.allowPrivilegeEscalation).toBe(false);
    });

    it('sets pod-level seccomp profile', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      expect(pod.spec!.securityContext!.seccompProfile).toEqual({ type: 'RuntimeDefault' });
    });

    it('uses OnRootMismatch for fsGroup changes on the workspace PVC', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      expect(pod.spec!.securityContext!.fsGroupChangePolicy).toBe('OnRootMismatch');
    });

    it('does not set a nodeSelector by default', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);

      expect(pod.spec!.nodeSelector).toBeUndefined();
    });

    it('applies a configured nodeSelector when provided', () => {
      const pod = buildSessionWorkspacePodSpec({
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
      const pod = buildSessionWorkspacePodSpec({
        ...baseOpts,
        serviceAccountName: 'agent-sa',
      });

      expect(pod.spec!.serviceAccountName).toBe('agent-sa');
    });

    it('does not inject model provider credentials into the long-lived sidecars', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      const workspaceGatewayEnv = getContainer(pod, 'workspace-gateway').env || [];
      const editorEnv = getContainer(pod, 'editor').env || [];

      for (const envVars of [workspaceGatewayEnv, editorEnv]) {
        expect(envVars.find((env) => env.name === 'ANTHROPIC_API_KEY')).toBeUndefined();
        expect(envVars.find((env) => env.name === 'OPENAI_API_KEY')).toBeUndefined();
        expect(envVars.find((env) => env.name === 'GOOGLE_GENERATIVE_AI_API_KEY')).toBeUndefined();
        expect(envVars.find((env) => env.name === 'GOOGLE_API_KEY')).toBeUndefined();
        expect(envVars.find((env) => env.name === 'CLAUDE_MODEL')).toBeUndefined();
      }
    });

    it('passes user identity env vars to the init container', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
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
      expect(getInitContainer(pod, 'seed-runtime-config').env).toEqual(
        expect.arrayContaining([
          { name: 'HOME', value: SESSION_WORKSPACE_SHARED_HOME_DIR },
          { name: 'LIFECYCLE_USER_ID', value: 'user-123' },
          { name: 'GIT_AUTHOR_NAME', value: 'Sample User' },
          { name: 'GIT_AUTHOR_EMAIL', value: 'sample-user@example.com' },
        ])
      );
    });

    it('forwards plain and secret-ref agent env vars into init and workspace gateway containers', () => {
      const pod = buildSessionWorkspacePodSpec({
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
      expect(getInitContainer(pod, 'seed-runtime-config').env).toEqual(
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
      expect(getContainer(pod, 'workspace-gateway').env).toEqual(
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
      const pod = buildSessionWorkspacePodSpec({ ...baseOpts, hasGitHubToken: false });
      const workspaceGatewayEnv = getContainer(pod, 'workspace-gateway').env || [];
      const initEnv = getInitContainer(pod, 'init-workspace').env || [];

      expect(workspaceGatewayEnv.find((env) => env.name === 'GITHUB_TOKEN')).toBeUndefined();
      expect(workspaceGatewayEnv.find((env) => env.name === 'GH_TOKEN')).toBeUndefined();
      expect(initEnv.find((env) => env.name === 'GITHUB_TOKEN')).toBeUndefined();
      expect(initEnv.find((env) => env.name === 'GH_TOKEN')).toBeUndefined();
      expect(
        (getInitContainer(pod, 'seed-runtime-config').env || []).find((env) => env.name === 'GITHUB_TOKEN')
      ).toBeUndefined();
      expect(
        (getInitContainer(pod, 'seed-runtime-config').env || []).find((env) => env.name === 'GH_TOKEN')
      ).toBeUndefined();
    });

    it('configures git auth before the first workspace clone when GitHub token forwarding is enabled', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      const script = getInitContainer(pod, 'init-workspace').command![2];
      const credentialHelperIndex = script.indexOf(
        'git config --global credential.helper \'!f() { test "$1" = get || exit 0; echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f\''
      );
      const cloneIndex = script.indexOf('git clone --progress --depth 50 --branch "feature/test"');

      expect(credentialHelperIndex).toBeGreaterThan(-1);
      expect(cloneIndex).toBeGreaterThan(-1);
      expect(credentialHelperIndex).toBeLessThan(cloneIndex);
    });

    it('mounts writable /tmp in init and long-lived sidecars', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      expect(getInitContainer(pod, 'prepare-workspace').volumeMounts).toEqual(
        expect.arrayContaining([
          { name: 'workspace', mountPath: '/workspace-volume' },
          { name: 'tmp', mountPath: '/tmp' },
        ])
      );
      expect(getInitContainer(pod, 'init-workspace').volumeMounts).toEqual(
        expect.arrayContaining([{ name: 'tmp', mountPath: '/tmp' }])
      );
      expect(getInitContainer(pod, 'seed-runtime-config').volumeMounts).toEqual(
        expect.arrayContaining([{ name: 'tmp', mountPath: '/tmp' }])
      );
      expect(getContainer(pod, 'editor').volumeMounts).toEqual(
        expect.arrayContaining([{ name: 'tmp', mountPath: '/tmp' }])
      );
      expect(getContainer(pod, 'workspace-gateway').volumeMounts).toEqual(
        expect.arrayContaining([{ name: 'tmp', mountPath: '/tmp' }])
      );
    });

    it('sets default resource requests and limits for init containers and sidecars', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
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
      expect(getInitContainer(pod, 'seed-runtime-config').resources).toEqual(expectedResources);
      expect(getContainer(pod, 'editor').resources).toEqual({
        requests: {
          cpu: '250m',
          memory: '512Mi',
        },
        limits: {
          cpu: '1',
          memory: '1Gi',
        },
      });
      expect(getContainer(pod, 'workspace-gateway').resources).toEqual({
        requests: {
          cpu: '100m',
          memory: '256Mi',
        },
        limits: {
          cpu: '500m',
          memory: '512Mi',
        },
      });
    });

    it('allows workspace bootstrap resource and node option overrides through env vars', () => {
      process.env.AGENT_SESSION_WORKSPACE_CPU_REQUEST = '750m';
      process.env.AGENT_SESSION_WORKSPACE_CPU_LIMIT = '3';
      process.env.AGENT_SESSION_WORKSPACE_MEMORY_REQUEST = '2Gi';
      process.env.AGENT_SESSION_WORKSPACE_MEMORY_LIMIT = '6Gi';
      process.env.AGENT_SESSION_WORKSPACE_GATEWAY_NODE_OPTIONS = '--max-old-space-size=3072';

      const pod = buildSessionWorkspacePodSpec(baseOpts);

      expect(getInitContainer(pod, 'prepare-workspace').resources).toEqual({
        requests: {
          cpu: '750m',
          memory: '2Gi',
        },
        limits: {
          cpu: '3',
          memory: '6Gi',
        },
      });
      expect(getInitContainer(pod, 'init-workspace').resources).toEqual({
        requests: {
          cpu: '750m',
          memory: '2Gi',
        },
        limits: {
          cpu: '3',
          memory: '6Gi',
        },
      });
      expect(getInitContainer(pod, 'seed-runtime-config').resources).toEqual({
        requests: {
          cpu: '750m',
          memory: '2Gi',
        },
        limits: {
          cpu: '3',
          memory: '6Gi',
        },
      });
      expect(getContainer(pod, 'workspace-gateway').env).toEqual(
        expect.arrayContaining([{ name: 'NODE_OPTIONS', value: '--max-old-space-size=3072' }])
      );
      expect(getContainer(pod, 'editor').resources).toEqual({
        requests: {
          cpu: '250m',
          memory: '512Mi',
        },
        limits: {
          cpu: '1',
          memory: '1Gi',
        },
      });
      expect(getContainer(pod, 'workspace-gateway').resources).toEqual({
        requests: {
          cpu: '100m',
          memory: '256Mi',
        },
        limits: {
          cpu: '500m',
          memory: '512Mi',
        },
      });
    });

    it('prefers explicit session workspace resource overrides when provided', () => {
      const pod = buildSessionWorkspacePodSpec({
        ...baseOpts,
        resources: {
          workspace: {
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
      expect(getInitContainer(pod, 'seed-runtime-config').resources).toEqual({
        requests: {
          cpu: '1',
          memory: '2Gi',
        },
        limits: {
          cpu: '4',
          memory: '8Gi',
        },
      });
      expect(getContainer(pod, 'editor').resources).toEqual({
        requests: {
          cpu: '500m',
          memory: '1Gi',
        },
        limits: {
          cpu: '2',
          memory: '2Gi',
        },
      });
      expect(getContainer(pod, 'workspace-gateway').resources).toEqual({
        requests: {
          cpu: '100m',
          memory: '256Mi',
        },
        limits: {
          cpu: '500m',
          memory: '512Mi',
        },
      });
    });

    it('starts a code-server editor sidecar on the editor port', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);

      expect(getContainer(pod, 'editor')).toEqual(
        expect.objectContaining({
          name: 'editor',
          image: 'codercom/code-server:4.98.2',
          args: [
            SESSION_WORKSPACE_EDITOR_PROJECT_FILE,
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

    it('starts a workspace gateway sidecar on the gateway port', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);

      expect(getContainer(pod, 'workspace-gateway')).toEqual(
        expect.objectContaining({
          name: 'workspace-gateway',
          image: 'lifecycle-workspace:latest',
          command: ['node', '/opt/lifecycle-workspace-gateway/index.mjs'],
          ports: [{ containerPort: 13338, name: SESSION_WORKSPACE_GATEWAY_PORT_NAME }],
          readinessProbe: expect.objectContaining({
            httpGet: { path: '/health', port: 13338 },
          }),
        })
      );
    });

    it('uses a Kubernetes-valid gateway port name', () => {
      expect(SESSION_WORKSPACE_GATEWAY_PORT_NAME.length).toBeLessThanOrEqual(15);
    });

    it('passes git identity, github token env, and shared home config into the workspace gateway sidecar', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      const workspaceGateway = getContainer(pod, 'workspace-gateway');

      expect(workspaceGateway.env).toEqual(
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
          { name: 'HOME', value: SESSION_WORKSPACE_SHARED_HOME_DIR },
          { name: 'LIFECYCLE_USER_ID', value: 'user-123' },
          { name: 'LIFECYCLE_GITHUB_USERNAME', value: 'sample-user' },
          { name: 'LIFECYCLE_USER_EMAIL', value: 'sample-user@example.com' },
          { name: 'LIFECYCLE_USER_NAME', value: 'Sample User' },
          { name: 'GIT_AUTHOR_NAME', value: 'Sample User' },
          { name: 'GIT_AUTHOR_EMAIL', value: 'sample-user@example.com' },
          { name: 'GIT_COMMITTER_NAME', value: 'Sample User' },
          { name: 'GIT_COMMITTER_EMAIL', value: 'sample-user@example.com' },
          { name: 'LIFECYCLE_SESSION_PRIMARY_REPO_PATH', value: '/workspace' },
        ])
      );

      expect(workspaceGateway.volumeMounts).toEqual(
        expect.arrayContaining([
          {
            name: SESSION_WORKSPACE_HOME_VOLUME_NAME,
            mountPath: SESSION_WORKSPACE_SHARED_HOME_DIR,
          },
        ])
      );
    });

    it('mounts shared git config into the editor without changing its home directory', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      const editor = getContainer(pod, 'editor');

      expect(editor.env).toEqual(
        expect.arrayContaining([
          { name: 'HOME', value: '/home/coder' },
          { name: 'GIT_CONFIG_GLOBAL', value: '/home/coder/.lifecycle-session/.gitconfig' },
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
          { name: 'GIT_AUTHOR_NAME', value: 'Sample User' },
          { name: 'GIT_AUTHOR_EMAIL', value: 'sample-user@example.com' },
        ])
      );

      expect(editor.volumeMounts).toEqual(
        expect.arrayContaining([
          {
            name: 'editor-home',
            mountPath: '/home/coder',
          },
          {
            name: SESSION_WORKSPACE_HOME_VOLUME_NAME,
            mountPath: '/home/coder/.lifecycle-session',
          },
        ])
      );
    });

    it('passes the session-pod MCP config secret into the workspace gateway sidecar', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      const workspaceGateway = getContainer(pod, 'workspace-gateway');

      expect(workspaceGateway.env).toEqual(
        expect.arrayContaining([
          {
            name: SESSION_POD_MCP_CONFIG_ENV,
            valueFrom: {
              secretKeyRef: {
                key: SESSION_POD_MCP_CONFIG_ENV,
                name: 'agent-secret-abc123',
                optional: true,
              },
            },
          },
        ])
      );
    });

    it('mounts the repo subpath at /workspace for shared workspace containers', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      const initWorkspaceMount = getInitContainer(pod, 'init-workspace').volumeMounts!.find(
        (mount) => mount.name === 'workspace'
      );
      const workspaceGatewayMount = getContainer(pod, 'workspace-gateway').volumeMounts!.find(
        (mount) => mount.name === 'workspace'
      );
      const editorWorkspaceMount = getContainer(pod, 'editor').volumeMounts!.find(
        (mount) => mount.name === 'workspace'
      );

      expect(initWorkspaceMount).toEqual({
        name: 'workspace',
        mountPath: '/workspace',
        subPath: 'repo',
      });
      expect(workspaceGatewayMount).toEqual({
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
      const pod = buildSessionWorkspacePodSpec({
        ...baseOpts,
        workspaceRepos: [
          {
            repo: 'org/repo',
            repoUrl: 'https://github.com/org/repo.git',
            branch: 'feature/test',
            revision: null,
            mountPath: '/workspace/repos/org/repo',
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
          command: [
            'sh',
            '-c',
            expect.stringContaining(`cat > '${SESSION_WORKSPACE_EDITOR_PROJECT_FILE}' << 'WORKSPACE_EOF'`),
          ],
          volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
        })
      );
      expect(getInitContainer(pod, 'prepare-editor-workspace').command?.[2]).toContain('"name": "org/repo"');
      expect(getInitContainer(pod, 'prepare-editor-workspace').command?.[2]).toContain(
        '"path": "/workspace/repos/org/repo"'
      );
      expect(getInitContainer(pod, 'prepare-editor-workspace').command?.[2]).toContain(
        '"path": "/workspace/repos/org/api"'
      );
      expect(getContainer(pod, 'workspace-gateway').env).toEqual(
        expect.arrayContaining([{ name: 'LIFECYCLE_SESSION_PRIMARY_REPO_PATH', value: '/workspace/repos/org/repo' }])
      );
    });

    it('still prepares the editor workspace when workspace bootstrap is skipped', () => {
      const pod = buildSessionWorkspacePodSpec({
        ...baseOpts,
        skipWorkspaceBootstrap: true,
      });

      expect(pod.spec!.initContainers?.map((container) => container.name)).toEqual([
        'seed-runtime-config',
        'prepare-editor-workspace',
      ]);
    });

    it('does not set runtimeClassName when gVisor not requested', () => {
      const pod = buildSessionWorkspacePodSpec(baseOpts);
      expect(pod.spec!.runtimeClassName).toBeUndefined();
    });

    it('sets runtimeClassName to gvisor when requested', () => {
      const pod = buildSessionWorkspacePodSpec({ ...baseOpts, useGvisor: true });
      expect(pod.spec!.runtimeClassName).toBe('gvisor');
    });
  });

  describe('createSessionWorkspacePod', () => {
    it('creates pod via K8s API', async () => {
      mockCreatePod.mockResolvedValue({ body: { metadata: { name: 'agent-abc123' } } });

      await createSessionWorkspacePod(baseOpts);

      expect(mockCreatePod).toHaveBeenCalledTimes(1);
      const [ns, podBody] = mockCreatePod.mock.calls[0];
      expect(ns).toBe('test-ns');
      expect(podBody.metadata.name).toBe('agent-abc123');
      expect(mockReadPod).toHaveBeenCalledWith('agent-abc123', 'test-ns');
    });

    it('surfaces Kubernetes validation failures from pod creation', async () => {
      mockCreatePod.mockRejectedValue(
        new k8s.HttpError(
          { statusCode: 422 } as any,
          {
            message: 'Pod "agent-abc123" is invalid',
            details: {
              causes: [
                {
                  field: 'spec.containers[1].ports[0].name',
                  message: 'must be no more than 15 characters',
                },
              ],
            },
          },
          422
        )
      );

      await expect(createSessionWorkspacePod(baseOpts)).rejects.toThrow(
        'Session workspace pod creation rejected by Kubernetes: Pod "agent-abc123" is invalid; spec.containers[1].ports[0].name: must be no more than 15 characters'
      );
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

      await expect(createSessionWorkspacePod(baseOpts)).rejects.toThrow(
        'Session workspace pod failed to start: init-workspace: ImagePullBackOff - image not found - pull failed for test image'
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
                name: 'seed-runtime-config',
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
                name: 'editor',
                state: {
                  running: {
                    startedAt: '2026-03-26T00:00:00Z',
                  },
                },
              },
              {
                name: 'workspace-gateway',
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
        createSessionWorkspacePod({
          ...baseOpts,
          readiness: {
            timeoutMs: 1,
            pollMs: 0,
          },
        })
      ).rejects.toThrow('Session workspace pod did not become ready within 1ms');
    });
  });

  describe('deleteSessionWorkspacePod', () => {
    it('deletes pod via K8s API', async () => {
      mockDeletePod.mockResolvedValue({});

      await deleteSessionWorkspacePod('test-ns', 'agent-abc123');

      expect(mockDeletePod).toHaveBeenCalledWith('agent-abc123', 'test-ns');
    });

    it('ignores 404 errors', async () => {
      const error = new k8s.HttpError({ statusCode: 404 } as any, 'not found', 404);
      mockDeletePod.mockRejectedValue(error);

      await expect(deleteSessionWorkspacePod('test-ns', 'agent-abc123')).resolves.toBeUndefined();
    });

    it('rethrows non-404 errors', async () => {
      mockDeletePod.mockRejectedValue(new Error('server error'));

      await expect(deleteSessionWorkspacePod('test-ns', 'agent-abc123')).rejects.toThrow('server error');
    });
  });
});
