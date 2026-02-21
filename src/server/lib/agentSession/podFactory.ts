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
import { generateInitScript, InitScriptOpts } from './configSeeder';
import { buildLifecycleLabels } from 'server/lib/kubernetes/labels';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { buildPodEnvWithSecrets } from 'server/lib/secretEnvBuilder';
import type { SecretRefWithEnvKey } from 'server/lib/secretRefs';

export const AGENT_EDITOR_PORT = parseInt(process.env.AGENT_EDITOR_PORT || '13337', 10);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

export interface AgentPodOpts {
  podName: string;
  namespace: string;
  pvcName: string;
  image: string;
  editorImage: string;
  apiKeySecretName: string;
  hasGitHubToken?: boolean;
  model: string;
  repoUrl: string;
  branch: string;
  revision?: string;
  workspacePath: string;
  installCommand?: string;
  claudeMdContent?: string;
  claudePermissions?: {
    allow: string[];
    deny: string[];
  };
  claudeCommitAttribution?: string;
  claudePrAttribution?: string;
  forwardedAgentEnv?: Record<string, string>;
  forwardedAgentSecretRefs?: SecretRefWithEnvKey[];
  forwardedAgentSecretServiceName?: string;
  useGvisor?: boolean;
  buildUuid?: string;
  userIdentity?: RequestUserIdentity;
}

function buildAgentResources(): k8s.V1ResourceRequirements {
  return {
    requests: {
      cpu: process.env.AGENT_POD_CPU_REQUEST || '500m',
      memory: process.env.AGENT_POD_MEMORY_REQUEST || '1Gi',
    },
    limits: {
      cpu: process.env.AGENT_POD_CPU_LIMIT || '2',
      memory: process.env.AGENT_POD_MEMORY_LIMIT || '4Gi',
    },
  };
}

function buildEditorResources(): k8s.V1ResourceRequirements {
  return {
    requests: {
      cpu: process.env.AGENT_EDITOR_CPU_REQUEST || '250m',
      memory: process.env.AGENT_EDITOR_MEMORY_REQUEST || '512Mi',
    },
    limits: {
      cpu: process.env.AGENT_EDITOR_CPU_LIMIT || '1',
      memory: process.env.AGENT_EDITOR_MEMORY_LIMIT || '1Gi',
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
          key: 'GH_TOKEN',
        },
      },
    },
  ];
}

export function buildAgentPodSpec(opts: AgentPodOpts): k8s.V1Pod {
  const {
    podName,
    namespace,
    pvcName,
    image,
    editorImage,
    apiKeySecretName,
    hasGitHubToken,
    model,
    repoUrl,
    branch,
    revision,
    workspacePath,
    installCommand,
    claudeMdContent,
    claudePermissions,
    claudeCommitAttribution,
    claudePrAttribution,
    useGvisor,
    userIdentity,
  } = opts;

  const initScriptOpts: InitScriptOpts = {
    repoUrl,
    branch,
    revision,
    workspacePath,
    installCommand,
    claudeMdContent,
    claudePermissions,
    claudeCommitAttribution,
    claudePrAttribution,
    gitUserName: userIdentity?.gitUserName,
    gitUserEmail: userIdentity?.gitUserEmail,
    githubUsername: userIdentity?.githubUsername || undefined,
    useGitHubToken: hasGitHubToken,
  };

  const initScript = generateInitScript(initScriptOpts);
  const resources = buildAgentResources();
  const editorResources = buildEditorResources();
  const userEnv = buildUserIdentityEnv(userIdentity);
  const githubTokenEnv = buildGitHubTokenEnv(apiKeySecretName, hasGitHubToken);
  const forwardedAgentEnv = opts.forwardedAgentEnv || {};
  const forwardedAgentSecretEnv = buildPodEnvWithSecrets(
    forwardedAgentEnv,
    opts.forwardedAgentSecretRefs || [],
    opts.forwardedAgentSecretServiceName || podName
  );

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
      securityContext: {
        runAsUser: 1000,
        runAsGroup: 1000,
        runAsNonRoot: true,
        fsGroup: 1000,
        seccompProfile: {
          type: 'RuntimeDefault',
        },
      },
      initContainers: [
        {
          name: 'init-workspace',
          image,
          imagePullPolicy: 'IfNotPresent',
          command: ['sh', '-c', initScript],
          resources,
          securityContext: {
            ...securityContext,
            readOnlyRootFilesystem: false,
          },
          volumeMounts: [
            {
              name: 'workspace',
              mountPath: workspacePath,
            },
            {
              name: 'claude-config',
              mountPath: '/home/claude/.claude',
            },
            {
              name: 'tmp',
              mountPath: '/tmp',
            },
          ],
          env: [
            { name: 'HOME', value: '/home/claude/.claude' },
            { name: 'TMPDIR', value: '/tmp' },
            { name: 'TMP', value: '/tmp' },
            { name: 'TEMP', value: '/tmp' },
            ...forwardedAgentSecretEnv,
            ...githubTokenEnv,
            ...userEnv,
          ],
        },
      ],
      containers: [
        {
          name: 'agent',
          image,
          imagePullPolicy: 'IfNotPresent',
          command: ['sleep', 'infinity'],
          resources,
          securityContext,
          env: [
            {
              name: 'ANTHROPIC_API_KEY',
              valueFrom: {
                secretKeyRef: {
                  name: apiKeySecretName,
                  key: 'ANTHROPIC_API_KEY',
                },
              },
            },
            { name: 'CLAUDE_MODEL', value: model },
            { name: 'HOME', value: '/home/claude/.claude' },
            { name: 'TMPDIR', value: '/tmp' },
            { name: 'TMP', value: '/tmp' },
            { name: 'TEMP', value: '/tmp' },
            { name: 'NODE_OPTIONS', value: process.env.AGENT_NODE_OPTIONS || '--max-old-space-size=2048' },
            ...forwardedAgentSecretEnv,
            ...githubTokenEnv,
            ...userEnv,
          ],
          volumeMounts: [
            {
              name: 'workspace',
              mountPath: workspacePath,
            },
            {
              name: 'claude-config',
              mountPath: '/home/claude/.claude',
            },
            {
              name: 'tmp',
              mountPath: '/tmp',
            },
          ],
        },
        {
          name: 'editor',
          image: editorImage,
          imagePullPolicy: 'IfNotPresent',
          args: [
            workspacePath,
            '--auth',
            'none',
            '--bind-addr',
            `0.0.0.0:${AGENT_EDITOR_PORT}`,
            '--disable-telemetry',
            '--disable-update-check',
          ],
          ports: [{ containerPort: AGENT_EDITOR_PORT, name: 'editor' }],
          resources: editorResources,
          securityContext,
          env: [
            { name: 'HOME', value: '/home/coder' },
            { name: 'TMPDIR', value: '/tmp' },
            { name: 'TMP', value: '/tmp' },
            { name: 'TEMP', value: '/tmp' },
          ],
          readinessProbe: {
            httpGet: {
              path: '/healthz',
              port: AGENT_EDITOR_PORT,
            },
            initialDelaySeconds: 2,
            periodSeconds: 5,
          },
          volumeMounts: [
            {
              name: 'workspace',
              mountPath: workspacePath,
            },
            {
              name: 'editor-home',
              mountPath: '/home/coder',
            },
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
          name: 'claude-config',
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
      `podFactory: unable to fetch logs for container name=${containerName} namespace=${namespace}`
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

async function waitForAgentPodReady(coreApi: k8s.CoreV1Api, namespace: string, podName: string): Promise<k8s.V1Pod> {
  const readyTimeoutMs = parseInt(process.env.AGENT_POD_READY_TIMEOUT_MS || '60000', 10);
  const readyPollMs = parseInt(process.env.AGENT_POD_READY_POLL_MS || '2000', 10);
  const deadline = Date.now() + readyTimeoutMs;
  let lastObservedState = 'pending';

  while (Date.now() < deadline) {
    const { body: pod } = await coreApi.readNamespacedPod(podName, namespace);
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
          `podFactory: startup logs for failing container name=${failingContainer} namespace=${namespace}`
        );
      }

      const logSummary = summarizeLogLine(containerLogs);
      throw new Error(`Agent pod failed to start: ${failure}${logSummary ? ` - ${logSummary}` : ''}`);
    }

    if (isPodReady(pod)) {
      return pod;
    }

    lastObservedState = summarizePodState(pod);
    await sleep(readyPollMs);
  }

  const timeoutLogs = await getContainerLogs(coreApi, namespace, podName, 'init-workspace');
  if (timeoutLogs) {
    getLogger().error(
      { namespace, podName, containerName: 'init-workspace', logs: timeoutLogs },
      `podFactory: init-workspace logs after startup timeout namespace=${namespace}`
    );
  }

  const timeoutSummary = summarizeLogLine(timeoutLogs);
  throw new Error(
    `Agent pod did not become ready within ${readyTimeoutMs}ms: ${lastObservedState}${
      timeoutSummary ? ` - ${timeoutSummary}` : ''
    }`
  );
}

export async function createAgentPod(opts: AgentPodOpts): Promise<k8s.V1Pod> {
  const logger = getLogger();
  const coreApi = getCoreApi();
  const pod = buildAgentPodSpec(opts);

  await coreApi.createNamespacedPod(opts.namespace, pod);
  const result = await waitForAgentPodReady(coreApi, opts.namespace, opts.podName);
  logger.info(`podFactory: created pod name=${opts.podName} namespace=${opts.namespace}`);
  return result;
}

export async function deleteAgentPod(namespace: string, podName: string): Promise<void> {
  const logger = getLogger();
  const coreApi = getCoreApi();

  try {
    await coreApi.deleteNamespacedPod(podName, namespace);
    logger.info(`podFactory: deleted pod name=${podName} namespace=${namespace}`);
  } catch (error: any) {
    if (error instanceof k8s.HttpError && error.response?.statusCode === 404) {
      logger.info(`podFactory: pod not found (already deleted) name=${podName} namespace=${namespace}`);
      return;
    }
    throw error;
  }
}
