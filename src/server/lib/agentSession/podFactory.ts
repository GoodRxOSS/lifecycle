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
import { getLogger } from 'server/lib/logger';
import {
  SESSION_WORKSPACE_HOME_VOLUME_NAME,
  SESSION_WORKSPACE_SHARED_HOME_DIR,
  generateInitScript,
  generateRuntimeSeedScript,
  InitScriptOpts,
} from './configSeeder';
import { generateSkillBootstrapCommand } from './skillBootstrap';
import { buildLifecycleLabels } from 'server/lib/kubernetes/labels';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { buildPodEnvWithSecrets } from 'server/lib/secretEnvBuilder';
import type { SecretRefWithEnvKey } from 'server/lib/secretRefs';
import { SESSION_POD_MCP_CONFIG_ENV, SESSION_POD_MCP_CONFIG_SECRET_KEY } from 'server/services/ai/mcp/sessionPod';
import {
  SESSION_WORKSPACE_EDITOR_PROJECT_FILE,
  SESSION_WORKSPACE_SUBPATH,
  buildSessionWorkspaceEditorContents,
  normalizeSessionWorkspaceRepo,
  repoNameFromRepoUrl,
  type AgentSessionWorkspaceRepo,
} from './workspace';
import type { AgentSessionSkillPlan } from './skillPlan';

export const SESSION_WORKSPACE_EDITOR_CONTAINER_NAME = 'editor';
export const SESSION_WORKSPACE_GATEWAY_CONTAINER_NAME = 'workspace-gateway';
export const SESSION_WORKSPACE_GATEWAY_PORT_NAME = 'ws-gateway';
export const SESSION_WORKSPACE_EDITOR_PORT = parseInt(process.env.AGENT_SESSION_WORKSPACE_EDITOR_PORT || '13337', 10);
export const SESSION_WORKSPACE_GATEWAY_PORT = parseInt(process.env.AGENT_SESSION_WORKSPACE_GATEWAY_PORT || '13338', 10);
const SESSION_WORKSPACE_VOLUME_ROOT = '/workspace-volume';
const SESSION_WORKSPACE_EDITOR_SHARED_SESSION_HOME_DIR = '/home/coder/.lifecycle-session';
const SESSION_WORKSPACE_EDITOR_GIT_CONFIG_PATH = `${SESSION_WORKSPACE_EDITOR_SHARED_SESSION_HOME_DIR}/.gitconfig`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
}

function getPodStartupFailure(pod: k8s.V1Pod): string | null {
  const statuses = [...(pod.status?.initContainerStatuses || []), ...(pod.status?.containerStatuses || [])];

  for (const status of statuses) {
    const waiting = status.state?.waiting;
    if (
      waiting?.reason &&
      [
        'ErrImagePull',
        'ImagePullBackOff',
        'CrashLoopBackOff',
        'CreateContainerConfigError',
        'RunContainerError',
      ].includes(waiting.reason)
    ) {
      return `${status.name}: ${waiting.reason}${waiting.message ? ` - ${waiting.message}` : ''}`;
    }

    const terminated = status.state?.terminated;
    if (terminated?.reason && terminated.exitCode !== 0) {
      return `${status.name}: ${terminated.reason}${terminated.message ? ` - ${terminated.message}` : ''}`;
    }
  }

  if (pod.status?.phase === 'Failed') {
    return pod.status?.message || 'pod failed';
  }

  return null;
}

function isPodReady(pod: k8s.V1Pod): boolean {
  return (pod.status?.conditions || []).some((condition) => condition.type === 'Ready' && condition.status === 'True');
}

function summarizePodState(pod: k8s.V1Pod): string {
  const initStates = (pod.status?.initContainerStatuses || [])
    .map(
      (status) =>
        status.state?.waiting?.reason ||
        status.state?.terminated?.reason ||
        status.state?.running?.startedAt ||
        'unknown'
    )
    .join(',');
  const mainStates = (pod.status?.containerStatuses || [])
    .map(
      (status) =>
        status.state?.waiting?.reason ||
        status.state?.terminated?.reason ||
        status.state?.running?.startedAt ||
        'unknown'
    )
    .join(',');

  return `phase=${pod.status?.phase || 'Unknown'} init=[${initStates}] containers=[${mainStates}]`;
}

function describePodCreateError(error: unknown): string | null {
  if (!(error instanceof k8s.HttpError)) {
    return null;
  }

  if (typeof error.body === 'string' && error.body.trim()) {
    return error.body.trim();
  }

  const body =
    error.body && typeof error.body === 'object'
      ? (error.body as {
          message?: unknown;
          details?: {
            causes?: Array<{
              field?: unknown;
              message?: unknown;
            }>;
          };
        })
      : null;

  const summary = typeof body?.message === 'string' ? body.message.trim() : '';
  const causeList = body?.details?.causes;
  const causes = Array.isArray(causeList)
    ? causeList
        .map((cause) => {
          const field = typeof cause.field === 'string' ? cause.field.trim() : '';
          const message = typeof cause.message === 'string' ? cause.message.trim() : '';
          if (field && message) {
            return `${field}: ${message}`;
          }
          return message || field;
        })
        .filter(Boolean)
    : [];

  const details = [summary, ...causes].filter(Boolean);
  return details.length > 0 ? details.join('; ') : error.message;
}

export interface SessionWorkspacePodOptions {
  podName: string;
  namespace: string;
  pvcName: string;
  workspaceImage?: string;
  workspaceEditorImage?: string;
  workspaceGatewayImage?: string;
  apiKeySecretName: string;
  hasGitHubToken?: boolean;
  repoUrl?: string;
  branch?: string;
  revision?: string;
  workspacePath: string;
  workspaceRepos?: AgentSessionWorkspaceRepo[];
  skillPlan?: AgentSessionSkillPlan;
  installCommand?: string;
  forwardedAgentEnv?: Record<string, string>;
  forwardedAgentSecretRefs?: SecretRefWithEnvKey[];
  forwardedAgentSecretServiceName?: string;
  useGvisor?: boolean;
  buildUuid?: string;
  userIdentity?: RequestUserIdentity;
  nodeSelector?: Record<string, string>;
  serviceAccountName?: string;
  readiness?: {
    timeoutMs: number;
    pollMs: number;
  };
  skipWorkspaceBootstrap?: boolean;
  resources?: {
    workspace?: k8s.V1ResourceRequirements;
    editor?: k8s.V1ResourceRequirements;
    workspaceGateway?: k8s.V1ResourceRequirements;
  };
}

function buildWorkspaceBootstrapResources(): k8s.V1ResourceRequirements {
  return {
    requests: {
      cpu: process.env.AGENT_SESSION_WORKSPACE_CPU_REQUEST || '500m',
      memory: process.env.AGENT_SESSION_WORKSPACE_MEMORY_REQUEST || '1Gi',
    },
    limits: {
      cpu: process.env.AGENT_SESSION_WORKSPACE_CPU_LIMIT || '2',
      memory: process.env.AGENT_SESSION_WORKSPACE_MEMORY_LIMIT || '4Gi',
    },
  };
}

function buildEditorResources(): k8s.V1ResourceRequirements {
  return {
    requests: {
      cpu: process.env.AGENT_SESSION_WORKSPACE_EDITOR_CPU_REQUEST || '250m',
      memory: process.env.AGENT_SESSION_WORKSPACE_EDITOR_MEMORY_REQUEST || '512Mi',
    },
    limits: {
      cpu: process.env.AGENT_SESSION_WORKSPACE_EDITOR_CPU_LIMIT || '1',
      memory: process.env.AGENT_SESSION_WORKSPACE_EDITOR_MEMORY_LIMIT || '1Gi',
    },
  };
}

function buildWorkspaceGatewayResources(): k8s.V1ResourceRequirements {
  return {
    requests: {
      cpu: process.env.AGENT_SESSION_WORKSPACE_GATEWAY_CPU_REQUEST || '100m',
      memory: process.env.AGENT_SESSION_WORKSPACE_GATEWAY_MEMORY_REQUEST || '256Mi',
    },
    limits: {
      cpu: process.env.AGENT_SESSION_WORKSPACE_GATEWAY_CPU_LIMIT || '500m',
      memory: process.env.AGENT_SESSION_WORKSPACE_GATEWAY_MEMORY_LIMIT || '512Mi',
    },
  };
}

function buildUserIdentityEnv(userIdentity?: RequestUserIdentity): k8s.V1EnvVar[] {
  if (!userIdentity) {
    return [];
  }

  const envVars: k8s.V1EnvVar[] = [
    { name: 'LIFECYCLE_USER_ID', value: userIdentity.userId },
    { name: 'LIFECYCLE_USER_NAME', value: userIdentity.displayName },
    { name: 'GIT_AUTHOR_NAME', value: userIdentity.gitUserName },
    { name: 'GIT_AUTHOR_EMAIL', value: userIdentity.gitUserEmail },
    { name: 'GIT_COMMITTER_NAME', value: userIdentity.gitUserName },
    { name: 'GIT_COMMITTER_EMAIL', value: userIdentity.gitUserEmail },
  ];

  if (userIdentity.githubUsername) {
    envVars.push({ name: 'LIFECYCLE_GITHUB_USERNAME', value: userIdentity.githubUsername });
  }

  if (userIdentity.email) {
    envVars.push({ name: 'LIFECYCLE_USER_EMAIL', value: userIdentity.email });
  }

  return envVars;
}

function buildGitHubTokenEnv(secretName: string, enabled?: boolean): k8s.V1EnvVar[] {
  if (!enabled) {
    return [];
  }

  return [
    {
      name: 'GITHUB_TOKEN',
      valueFrom: {
        secretKeyRef: {
          name: secretName,
          key: 'GITHUB_TOKEN',
        },
      },
    },
    {
      name: 'GH_TOKEN',
      valueFrom: {
        secretKeyRef: {
          name: secretName,
          key: 'GITHUB_TOKEN',
        },
      },
    },
  ];
}

function buildWorkspaceVolumeMount(workspacePath: string): k8s.V1VolumeMount {
  return {
    name: 'workspace',
    mountPath: workspacePath,
    subPath: SESSION_WORKSPACE_SUBPATH,
  };
}

function escapeSingleQuotedShell(value: string): string {
  return value.replace(/'/g, `'"'"'`);
}

function resolveEditorWorkspaceRepos(opts: SessionWorkspacePodOptions): AgentSessionWorkspaceRepo[] {
  if (opts.workspaceRepos?.length) {
    return opts.workspaceRepos;
  }

  const repo = repoNameFromRepoUrl(opts.repoUrl);
  if (!repo || !opts.branch) {
    return [];
  }

  return [
    {
      ...normalizeSessionWorkspaceRepo(
        {
          repo,
          repoUrl: opts.repoUrl!,
          branch: opts.branch,
          revision: opts.revision || null,
        },
        true
      ),
      mountPath: opts.workspacePath,
    },
  ];
}

function generateEditorWorkspaceInitScript(workspaceRepos: AgentSessionWorkspaceRepo[]): string {
  const workspaceJson = buildSessionWorkspaceEditorContents(workspaceRepos);

  return [
    '#!/bin/sh',
    'set -e',
    `cat > '${escapeSingleQuotedShell(SESSION_WORKSPACE_EDITOR_PROJECT_FILE)}' << 'WORKSPACE_EOF'`,
    workspaceJson,
    'WORKSPACE_EOF',
    '',
  ].join('\n');
}

export function buildSessionWorkspacePodSpec(opts: SessionWorkspacePodOptions): k8s.V1Pod {
  const {
    podName,
    namespace,
    pvcName,
    workspaceImage,
    workspaceEditorImage,
    workspaceGatewayImage,
    apiKeySecretName,
    hasGitHubToken,
    repoUrl,
    branch,
    revision,
    workspacePath,
    installCommand,
    useGvisor,
    userIdentity,
    skipWorkspaceBootstrap,
  } = opts;
  const resolvedWorkspaceGatewayImage = workspaceGatewayImage ?? workspaceImage;

  const initScriptOpts: InitScriptOpts = {
    repoUrl,
    branch,
    revision,
    workspacePath,
    workspaceRepos: opts.workspaceRepos,
    installCommand,
    gitUserName: userIdentity?.gitUserName,
    gitUserEmail: userIdentity?.gitUserEmail,
    githubUsername: userIdentity?.githubUsername || undefined,
    useGitHubToken: hasGitHubToken,
  };

  const initScript = generateInitScript(initScriptOpts);
  const skillBootstrapCommand = generateSkillBootstrapCommand(opts.skillPlan, {
    useGitHubToken: hasGitHubToken,
  });
  const runtimeSeedScript = generateRuntimeSeedScript(initScriptOpts);
  if (!workspaceImage || !workspaceEditorImage) {
    throw new Error('Session workspace pod requires workspaceImage and workspaceEditorImage');
  }

  const resources = opts.resources?.workspace || buildWorkspaceBootstrapResources();
  const editorResources = opts.resources?.editor || buildEditorResources();
  const workspaceGatewayResources = opts.resources?.workspaceGateway || buildWorkspaceGatewayResources();
  const userEnv = buildUserIdentityEnv(userIdentity);
  const githubTokenEnv = buildGitHubTokenEnv(apiKeySecretName, hasGitHubToken);
  const workspaceVolumeMount = buildWorkspaceVolumeMount(workspacePath);
  const sessionHomeVolumeMount: k8s.V1VolumeMount = {
    name: SESSION_WORKSPACE_HOME_VOLUME_NAME,
    mountPath: SESSION_WORKSPACE_SHARED_HOME_DIR,
  };
  const editorWorkspaceRepos = resolveEditorWorkspaceRepos(opts);
  const editorWorkspaceInitScript = generateEditorWorkspaceInitScript(editorWorkspaceRepos);
  const forwardedAgentEnv = opts.forwardedAgentEnv || {};
  const forwardedAgentSecretEnv = buildPodEnvWithSecrets(
    forwardedAgentEnv,
    opts.forwardedAgentSecretRefs || [],
    opts.forwardedAgentSecretServiceName || podName,
    apiKeySecretName
  );
  const primaryWorkspaceRepo = editorWorkspaceRepos.find((repo) => repo.primary) || editorWorkspaceRepos[0];
  const sessionPodMcpConfigEnv: k8s.V1EnvVar = {
    name: SESSION_POD_MCP_CONFIG_ENV,
    valueFrom: {
      secretKeyRef: {
        name: apiKeySecretName,
        key: SESSION_POD_MCP_CONFIG_SECRET_KEY,
        optional: true,
      },
    },
  };

  const securityContext: k8s.V1SecurityContext = {
    runAsUser: 1000,
    runAsGroup: 1000,
    runAsNonRoot: true,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: {
      drop: ['ALL'],
    },
  };

  const initContainers: k8s.V1Container[] = [];

  if (!skipWorkspaceBootstrap) {
    initContainers.push(
      {
        name: 'prepare-workspace',
        image: workspaceImage,
        imagePullPolicy: 'IfNotPresent',
        command: ['sh', '-c', `mkdir -p "${SESSION_WORKSPACE_VOLUME_ROOT}/${SESSION_WORKSPACE_SUBPATH}"`],
        resources,
        securityContext: {
          ...securityContext,
          readOnlyRootFilesystem: false,
        },
        volumeMounts: [
          {
            name: 'workspace',
            mountPath: SESSION_WORKSPACE_VOLUME_ROOT,
          },
          {
            name: 'tmp',
            mountPath: '/tmp',
          },
        ],
        env: [
          { name: 'TMPDIR', value: '/tmp' },
          { name: 'TMP', value: '/tmp' },
          { name: 'TEMP', value: '/tmp' },
        ],
      },
      {
        name: 'init-workspace',
        image: workspaceImage,
        imagePullPolicy: 'IfNotPresent',
        command: ['sh', '-c', initScript],
        resources,
        securityContext: {
          ...securityContext,
          readOnlyRootFilesystem: false,
        },
        volumeMounts: [
          workspaceVolumeMount,
          sessionHomeVolumeMount,
          {
            name: 'tmp',
            mountPath: '/tmp',
          },
        ],
        env: [
          { name: 'HOME', value: SESSION_WORKSPACE_SHARED_HOME_DIR },
          { name: 'TMPDIR', value: '/tmp' },
          { name: 'TMP', value: '/tmp' },
          { name: 'TEMP', value: '/tmp' },
          ...forwardedAgentSecretEnv,
          ...githubTokenEnv,
          ...userEnv,
        ],
      }
    );
  }

  if ((opts.skillPlan?.skills || []).length > 0) {
    initContainers.push({
      name: 'init-skills',
      image: resolvedWorkspaceGatewayImage,
      imagePullPolicy: 'IfNotPresent',
      command: ['sh', '-c', skillBootstrapCommand],
      resources: workspaceGatewayResources,
      securityContext: {
        ...securityContext,
        readOnlyRootFilesystem: false,
      },
      volumeMounts: [
        workspaceVolumeMount,
        sessionHomeVolumeMount,
        {
          name: 'tmp',
          mountPath: '/tmp',
        },
      ],
      env: [
        { name: 'LIFECYCLE_SESSION_HOME', value: SESSION_WORKSPACE_SHARED_HOME_DIR },
        { name: 'HOME', value: SESSION_WORKSPACE_SHARED_HOME_DIR },
        { name: 'TMPDIR', value: '/tmp' },
        { name: 'TMP', value: '/tmp' },
        { name: 'TEMP', value: '/tmp' },
        ...githubTokenEnv,
      ],
    });
  }

  initContainers.push({
    name: 'seed-runtime-config',
    image: workspaceImage,
    imagePullPolicy: 'IfNotPresent',
    command: ['sh', '-c', runtimeSeedScript],
    resources,
    securityContext: {
      ...securityContext,
      readOnlyRootFilesystem: false,
    },
    volumeMounts: [
      workspaceVolumeMount,
      sessionHomeVolumeMount,
      {
        name: 'tmp',
        mountPath: '/tmp',
      },
    ],
    env: [
      { name: 'HOME', value: SESSION_WORKSPACE_SHARED_HOME_DIR },
      { name: 'TMPDIR', value: '/tmp' },
      { name: 'TMP', value: '/tmp' },
      { name: 'TEMP', value: '/tmp' },
      ...forwardedAgentSecretEnv,
      ...githubTokenEnv,
      ...userEnv,
    ],
  });

  initContainers.push({
    name: 'prepare-editor-workspace',
    image: workspaceImage,
    imagePullPolicy: 'IfNotPresent',
    command: ['sh', '-c', editorWorkspaceInitScript],
    resources,
    securityContext: {
      ...securityContext,
      readOnlyRootFilesystem: false,
    },
    volumeMounts: [
      {
        name: 'tmp',
        mountPath: '/tmp',
      },
    ],
    env: [
      { name: 'TMPDIR', value: '/tmp' },
      { name: 'TMP', value: '/tmp' },
      { name: 'TEMP', value: '/tmp' },
    ],
  });

  const pod: k8s.V1Pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace,
      labels: {
        ...buildLifecycleLabels({ buildUuid: opts.buildUuid }),
        'app.kubernetes.io/component': 'agent-session',
        'app.kubernetes.io/name': podName,
      },
    },
    spec: {
      ...(useGvisor ? { runtimeClassName: 'gvisor' } : {}),
      ...(opts.nodeSelector ? { nodeSelector: opts.nodeSelector } : {}),
      ...(opts.serviceAccountName ? { serviceAccountName: opts.serviceAccountName } : {}),
      securityContext: {
        runAsUser: 1000,
        runAsGroup: 1000,
        runAsNonRoot: true,
        fsGroup: 1000,
        fsGroupChangePolicy: 'OnRootMismatch',
        seccompProfile: {
          type: 'RuntimeDefault',
        },
      },
      initContainers,
      containers: [
        {
          name: SESSION_WORKSPACE_EDITOR_CONTAINER_NAME,
          image: workspaceEditorImage,
          imagePullPolicy: 'IfNotPresent',
          args: [
            SESSION_WORKSPACE_EDITOR_PROJECT_FILE,
            '--auth',
            'none',
            '--bind-addr',
            `0.0.0.0:${SESSION_WORKSPACE_EDITOR_PORT}`,
            '--disable-telemetry',
            '--disable-update-check',
          ],
          ports: [{ containerPort: SESSION_WORKSPACE_EDITOR_PORT, name: SESSION_WORKSPACE_EDITOR_CONTAINER_NAME }],
          resources: editorResources,
          securityContext,
          env: [
            { name: 'HOME', value: '/home/coder' },
            { name: 'GIT_CONFIG_GLOBAL', value: SESSION_WORKSPACE_EDITOR_GIT_CONFIG_PATH },
            { name: 'TMPDIR', value: '/tmp' },
            { name: 'TMP', value: '/tmp' },
            { name: 'TEMP', value: '/tmp' },
            ...githubTokenEnv,
            ...userEnv,
          ],
          readinessProbe: {
            httpGet: {
              path: '/healthz',
              port: SESSION_WORKSPACE_EDITOR_PORT,
            },
            initialDelaySeconds: 1,
            periodSeconds: 2,
          },
          volumeMounts: [
            workspaceVolumeMount,
            {
              name: 'editor-home',
              mountPath: '/home/coder',
            },
            {
              name: SESSION_WORKSPACE_HOME_VOLUME_NAME,
              mountPath: SESSION_WORKSPACE_EDITOR_SHARED_SESSION_HOME_DIR,
            },
            {
              name: 'tmp',
              mountPath: '/tmp',
            },
          ],
        },
        {
          name: SESSION_WORKSPACE_GATEWAY_CONTAINER_NAME,
          image: resolvedWorkspaceGatewayImage,
          imagePullPolicy: 'IfNotPresent',
          command: ['node', '/opt/lifecycle-workspace-gateway/index.mjs'],
          ports: [{ containerPort: SESSION_WORKSPACE_GATEWAY_PORT, name: SESSION_WORKSPACE_GATEWAY_PORT_NAME }],
          resources: workspaceGatewayResources,
          securityContext,
          env: [
            { name: 'LIFECYCLE_SESSION_WORKSPACE', value: workspacePath },
            { name: 'LIFECYCLE_SESSION_HOME', value: SESSION_WORKSPACE_SHARED_HOME_DIR },
            { name: 'LIFECYCLE_SESSION_PRIMARY_REPO_PATH', value: primaryWorkspaceRepo?.mountPath || workspacePath },
            { name: 'MCP_PORT', value: String(SESSION_WORKSPACE_GATEWAY_PORT) },
            { name: 'HOME', value: SESSION_WORKSPACE_SHARED_HOME_DIR },
            { name: 'TMPDIR', value: '/tmp' },
            { name: 'TMP', value: '/tmp' },
            { name: 'TEMP', value: '/tmp' },
            {
              name: 'NODE_OPTIONS',
              value: process.env.AGENT_SESSION_WORKSPACE_GATEWAY_NODE_OPTIONS || '--max-old-space-size=2048',
            },
            sessionPodMcpConfigEnv,
            ...forwardedAgentSecretEnv,
            ...githubTokenEnv,
            ...userEnv,
          ],
          readinessProbe: {
            httpGet: {
              path: '/health',
              port: SESSION_WORKSPACE_GATEWAY_PORT,
            },
            initialDelaySeconds: 1,
            periodSeconds: 2,
          },
          volumeMounts: [
            workspaceVolumeMount,
            sessionHomeVolumeMount,
            {
              name: 'tmp',
              mountPath: '/tmp',
            },
          ],
        },
      ],
      volumes: [
        {
          name: 'workspace',
          persistentVolumeClaim: {
            claimName: pvcName,
          },
        },
        {
          name: SESSION_WORKSPACE_HOME_VOLUME_NAME,
          emptyDir: {},
        },
        {
          name: 'editor-home',
          emptyDir: {},
        },
        {
          name: 'tmp',
          emptyDir: {},
        },
      ],
      restartPolicy: 'Never',
    },
  };

  return pod;
}

function getCoreApi(): k8s.CoreV1Api {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}

async function getContainerLogs(
  coreApi: k8s.CoreV1Api,
  namespace: string,
  podName: string,
  containerName: string,
  tailLines = 200
): Promise<string | null> {
  try {
    const { body } = await coreApi.readNamespacedPodLog(
      podName,
      namespace,
      containerName,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      tailLines
    );
    return typeof body === 'string' ? body.trim() : null;
  } catch (error) {
    getLogger().debug(
      { error, namespace, podName, containerName },
      `Session: logs fetch failed containerName=${containerName} namespace=${namespace} podName=${podName}`
    );
    return null;
  }
}

function summarizeLogLine(logs: string | null): string | null {
  if (!logs) {
    return null;
  }

  const firstLine = logs
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  return firstLine || null;
}

async function waitForSessionWorkspacePodReady(
  coreApi: k8s.CoreV1Api,
  namespace: string,
  podName: string,
  readiness?: SessionWorkspacePodOptions['readiness']
): Promise<k8s.V1Pod> {
  const readyTimeoutMs =
    normalizeNonNegativeInteger(readiness?.timeoutMs) ??
    normalizeNonNegativeInteger(process.env.AGENT_SESSION_WORKSPACE_READY_TIMEOUT_MS) ??
    60000;
  const readyPollMs =
    normalizeNonNegativeInteger(readiness?.pollMs) ??
    normalizeNonNegativeInteger(process.env.AGENT_SESSION_WORKSPACE_READY_POLL_MS) ??
    2000;
  const deadline = Date.now() + readyTimeoutMs;
  let lastObservedState = 'pending';
  let lastPod: k8s.V1Pod | null = null;

  while (Date.now() < deadline) {
    const { body: pod } = await coreApi.readNamespacedPod(podName, namespace);
    lastPod = pod;
    const failure = getPodStartupFailure(pod);
    if (failure) {
      const failingContainer =
        [...(pod.status?.initContainerStatuses || []), ...(pod.status?.containerStatuses || [])].find((status) => {
          const waiting = status.state?.waiting;
          if (
            waiting?.reason &&
            [
              'ErrImagePull',
              'ImagePullBackOff',
              'CrashLoopBackOff',
              'CreateContainerConfigError',
              'RunContainerError',
            ].includes(waiting.reason)
          ) {
            return true;
          }

          const terminated = status.state?.terminated;
          return !!(terminated?.reason && terminated.exitCode !== 0);
        })?.name || null;

      const containerLogs = failingContainer
        ? await getContainerLogs(coreApi, namespace, podName, failingContainer)
        : null;
      if (containerLogs) {
        getLogger().error(
          { namespace, podName, containerName: failingContainer, logs: containerLogs },
          `Session: startup logs captured containerName=${failingContainer} namespace=${namespace} podName=${podName}`
        );
      }

      const logSummary = summarizeLogLine(containerLogs);
      throw new Error(`Session workspace pod failed to start: ${failure}${logSummary ? ` - ${logSummary}` : ''}`);
    }

    if (isPodReady(pod)) {
      return pod;
    }

    lastObservedState = summarizePodState(pod);
    await sleep(readyPollMs);
  }

  const timeoutContainer =
    (lastPod?.status?.initContainerStatuses || []).find((status) => !status.state?.terminated)?.name ||
    'init-workspace';
  const timeoutLogs = await getContainerLogs(coreApi, namespace, podName, timeoutContainer);
  if (timeoutLogs) {
    getLogger().error(
      { namespace, podName, containerName: timeoutContainer, logs: timeoutLogs },
      `Session: timeout logs captured containerName=${timeoutContainer} namespace=${namespace} podName=${podName}`
    );
  }

  const timeoutSummary = summarizeLogLine(timeoutLogs);
  throw new Error(
    `Session workspace pod did not become ready within ${readyTimeoutMs}ms: ${lastObservedState}${
      timeoutSummary ? ` - ${timeoutSummary}` : ''
    }`
  );
}

export async function createSessionWorkspacePod(opts: SessionWorkspacePodOptions): Promise<k8s.V1Pod> {
  const logger = getLogger();
  const coreApi = getCoreApi();
  const pod = buildSessionWorkspacePodSpec(opts);

  try {
    await coreApi.createNamespacedPod(opts.namespace, pod);
  } catch (error) {
    const detail = describePodCreateError(error);
    logger.error(
      { error, namespace: opts.namespace, podName: opts.podName, pod },
      `Session: workspace pod create failed podName=${opts.podName} namespace=${opts.namespace}${
        detail ? ` detail=${detail}` : ''
      }`
    );

    if (detail) {
      throw new Error(`Session workspace pod creation rejected by Kubernetes: ${detail}`);
    }

    throw error;
  }

  const result = await waitForSessionWorkspacePodReady(coreApi, opts.namespace, opts.podName, opts.readiness);
  logger.info(`Session: workspace pod ready podName=${opts.podName} namespace=${opts.namespace}`);
  return result;
}

export async function deleteSessionWorkspacePod(namespace: string, podName: string): Promise<void> {
  const logger = getLogger();
  const coreApi = getCoreApi();

  try {
    await coreApi.deleteNamespacedPod(podName, namespace);
    logger.info(`Session: workspace pod cleaned podName=${podName} namespace=${namespace}`);
  } catch (error: any) {
    if (error instanceof k8s.HttpError && error.response?.statusCode === 404) {
      logger.info(`Session: workspace pod cleanup skipped reason=not_found podName=${podName} namespace=${namespace}`);
      return;
    }
    throw error;
  }
}
