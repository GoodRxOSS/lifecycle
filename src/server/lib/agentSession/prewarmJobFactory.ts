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

import * as k8s from '@kubernetes/client-node';
import { getLogger } from 'server/lib/logger';
import { generateInitScript, InitScriptOpts } from './configSeeder';
import { buildLifecycleLabels } from 'server/lib/kubernetes/labels';
import { buildPodEnvWithSecrets } from 'server/lib/secretEnvBuilder';
import type { SecretRefWithEnvKey } from 'server/lib/secretRefs';
import { AGENT_WORKSPACE_SUBPATH, type AgentSessionWorkspaceRepo } from './workspace';
import { JobMonitor } from 'server/lib/kubernetes/JobMonitor';

const AGENT_WORKSPACE_VOLUME_ROOT = '/workspace-volume';
const DEFAULT_PREWARM_TIMEOUT_SECONDS = 30 * 60;

export interface AgentPrewarmJobOpts {
  jobName: string;
  namespace: string;
  pvcName: string;
  image: string;
  apiKeySecretName: string;
  hasGitHubToken?: boolean;
  repoUrl?: string;
  branch?: string;
  revision?: string;
  workspacePath: string;
  workspaceRepos?: AgentSessionWorkspaceRepo[];
  installCommand?: string;
  forwardedAgentEnv?: Record<string, string>;
  forwardedAgentSecretRefs?: SecretRefWithEnvKey[];
  forwardedAgentSecretServiceName?: string;
  buildUuid?: string;
  nodeSelector?: Record<string, string>;
  serviceAccountName?: string;
  resources?: k8s.V1ResourceRequirements;
  timeoutSeconds?: number;
}

function buildWorkspaceVolumeMount(workspacePath: string): k8s.V1VolumeMount {
  return {
    name: 'workspace',
    mountPath: workspacePath,
    subPath: AGENT_WORKSPACE_SUBPATH,
  };
}

function getBatchApi(): k8s.BatchV1Api {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.BatchV1Api);
}

export function buildAgentPrewarmJobSpec(opts: AgentPrewarmJobOpts): k8s.V1Job {
  const initScriptOpts: InitScriptOpts = {
    repoUrl: opts.repoUrl,
    branch: opts.branch,
    revision: opts.revision,
    workspacePath: opts.workspacePath,
    workspaceRepos: opts.workspaceRepos,
    installCommand: opts.installCommand,
    useGitHubToken: opts.hasGitHubToken,
  };

  const workspaceVolumeMount = buildWorkspaceVolumeMount(opts.workspacePath);
  const forwardedAgentEnv = opts.forwardedAgentEnv || {};
  const forwardedAgentSecretEnv = buildPodEnvWithSecrets(
    forwardedAgentEnv,
    opts.forwardedAgentSecretRefs || [],
    opts.forwardedAgentSecretServiceName || opts.jobName,
    opts.apiKeySecretName
  );
  const githubTokenEnv: k8s.V1EnvVar[] = opts.hasGitHubToken
    ? [
        {
          name: 'GITHUB_TOKEN',
          valueFrom: {
            secretKeyRef: {
              name: opts.apiKeySecretName,
              key: 'GITHUB_TOKEN',
            },
          },
        },
        {
          name: 'GH_TOKEN',
          valueFrom: {
            secretKeyRef: {
              name: opts.apiKeySecretName,
              key: 'GITHUB_TOKEN',
            },
          },
        },
      ]
    : [];

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

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: opts.jobName,
      namespace: opts.namespace,
      labels: {
        ...buildLifecycleLabels({ buildUuid: opts.buildUuid }),
        'app.kubernetes.io/component': 'agent-session-prewarm',
        'app.kubernetes.io/name': opts.jobName,
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 24 * 60 * 60,
      activeDeadlineSeconds: opts.timeoutSeconds || DEFAULT_PREWARM_TIMEOUT_SECONDS,
      template: {
        metadata: {
          labels: {
            ...buildLifecycleLabels({ buildUuid: opts.buildUuid }),
            'app.kubernetes.io/component': 'agent-session-prewarm',
            'job-name': opts.jobName,
          },
        },
        spec: {
          ...(opts.nodeSelector ? { nodeSelector: opts.nodeSelector } : {}),
          ...(opts.serviceAccountName ? { serviceAccountName: opts.serviceAccountName } : {}),
          restartPolicy: 'Never',
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
              name: 'prepare-workspace',
              image: opts.image,
              imagePullPolicy: 'IfNotPresent',
              command: ['sh', '-c', `mkdir -p "${AGENT_WORKSPACE_VOLUME_ROOT}/${AGENT_WORKSPACE_SUBPATH}"`],
              resources: opts.resources,
              securityContext: {
                ...securityContext,
                readOnlyRootFilesystem: false,
              },
              volumeMounts: [
                {
                  name: 'workspace',
                  mountPath: AGENT_WORKSPACE_VOLUME_ROOT,
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
              image: opts.image,
              imagePullPolicy: 'IfNotPresent',
              command: ['sh', '-c', generateInitScript(initScriptOpts)],
              resources: opts.resources,
              securityContext: {
                ...securityContext,
                readOnlyRootFilesystem: false,
              },
              volumeMounts: [
                workspaceVolumeMount,
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
              ],
            },
          ],
          containers: [
            {
              name: 'complete',
              image: opts.image,
              imagePullPolicy: 'IfNotPresent',
              command: ['sh', '-c', 'echo "agent prewarm complete"'],
              resources: opts.resources,
              securityContext,
              env: [
                { name: 'TMPDIR', value: '/tmp' },
                { name: 'TMP', value: '/tmp' },
                { name: 'TEMP', value: '/tmp' },
              ],
              volumeMounts: [
                workspaceVolumeMount,
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
                claimName: opts.pvcName,
              },
            },
            {
              name: 'claude-config',
              emptyDir: {},
            },
            {
              name: 'tmp',
              emptyDir: {},
            },
          ],
        },
      },
    },
  };
}

export async function createAgentPrewarmJob(opts: AgentPrewarmJobOpts): Promise<k8s.V1Job> {
  const batchApi = getBatchApi();
  const job = buildAgentPrewarmJobSpec(opts);
  const { body } = await batchApi.createNamespacedJob(opts.namespace, job);
  getLogger().info(`Prewarm: job started jobName=${opts.jobName} namespace=${opts.namespace}`);
  return body;
}

export async function monitorAgentPrewarmJob(jobName: string, namespace: string, timeoutSeconds?: number) {
  const monitor = new JobMonitor(jobName, namespace);
  return monitor.waitForCompletion({
    timeoutSeconds: timeoutSeconds || DEFAULT_PREWARM_TIMEOUT_SECONDS,
    containerFilters: ['complete'],
    logPrefix: 'agent-prewarm',
  });
}
