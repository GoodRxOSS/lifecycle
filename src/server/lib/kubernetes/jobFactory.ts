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

import { V1Job } from '@kubernetes/client-node';
import { normalizeKubernetesLabelValue } from './utils';

export interface JobConfig {
  name: string;
  namespace: string;
  appName: string;
  component: 'build' | 'deployment';
  serviceAccount: string;
  timeout: number;
  ttl?: number;
  labels: Record<string, string>;
  annotations?: Record<string, string>;
  initContainers?: any[];
  containers: any[];
  volumes?: any[];
  tolerations?: any[];
  nodeSelector?: Record<string, string>;
  terminationGracePeriodSeconds?: number;
}

export function createKubernetesJob(config: JobConfig): V1Job {
  const {
    name,
    namespace,
    appName,
    component,
    serviceAccount,
    timeout,
    ttl,
    labels,
    annotations = {},
    initContainers = [],
    containers,
    volumes = [],
    tolerations = [],
    nodeSelector,
    terminationGracePeriodSeconds = 30,
  } = config;

  const job: V1Job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace,
      labels: {
        'app.kubernetes.io/name': appName,
        'app.kubernetes.io/component': component,
        'app.kubernetes.io/managed-by': 'lifecycle',
        ...labels,
      },
      annotations: {
        'lifecycle.io/triggered-at': new Date().toISOString(),
        ...annotations,
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: timeout,
      ...(ttl !== undefined && { ttlSecondsAfterFinished: ttl }),
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': appName,
            'app.kubernetes.io/component': component,
            ...(labels['lc-service'] && { 'lc-service': labels['lc-service'] }),
          },
        },
        spec: {
          serviceAccountName: serviceAccount,
          restartPolicy: 'Never',
          terminationGracePeriodSeconds,
          ...(initContainers.length > 0 && { initContainers }),
          containers,
          ...(volumes.length > 0 && { volumes }),
          ...(tolerations.length > 0 && { tolerations }),
          ...(nodeSelector && { nodeSelector }),
        },
      },
    },
  };

  return job;
}

export interface BuildJobConfig {
  jobName: string;
  namespace: string;
  serviceAccount: string;
  serviceName: string;
  deployUuid: string;
  buildId: string;
  shortSha: string;
  branch: string;
  engine: 'buildkit' | 'kaniko';
  dockerfilePath: string;
  ecrRepo: string;
  jobTimeout: number;
  isStatic: boolean;
  initContainers: any[];
  containers: any[];
  volumes?: any[];
}

export function createBuildJob(config: BuildJobConfig): V1Job {
  const ttl = config.isStatic ? 86400 : undefined;

  return createKubernetesJob({
    name: config.jobName,
    namespace: config.namespace,
    appName: 'native-build',
    component: 'build',
    serviceAccount: config.serviceAccount,
    timeout: config.jobTimeout,
    ttl,
    labels: {
      'lc-service': config.serviceName,
      'lc-deploy-uuid': config.deployUuid,
      'lc-build-id': String(config.buildId),
      'git-sha': config.shortSha,
      'git-branch': normalizeKubernetesLabelValue(config.branch),
      'builder-engine': config.engine,
      'build-method': 'native',
    },
    annotations: {
      'lifecycle.io/dockerfile': config.dockerfilePath,
      'lifecycle.io/ecr-repo': config.ecrRepo,
    },
    initContainers: config.initContainers,
    containers: config.containers,
    volumes: config.volumes || [{ name: 'workspace', emptyDir: {} }],
  });
}

export interface HelmJobConfig {
  name: string;
  namespace: string;
  serviceAccount: string;
  serviceName: string;
  buildUUID: string;
  isStatic: boolean;
  timeout?: number;
  gitUsername?: string;
  gitToken?: string;
  cloneScript?: string;
  containers: any[];
  volumes?: any[];
  deployMetadata?: {
    sha: string;
    branch: string;
    deployId?: string;
    deployableId: string;
  };
  includeGitClone?: boolean;
}

export function createHelmJob(config: HelmJobConfig): V1Job {
  const ttl = config.isStatic ? 86400 : undefined;
  const timeout = config.timeout || 1800; // 30 minutes default

  const labels: Record<string, string> = {
    'lc-uuid': config.buildUUID,
    service: config.serviceName,
  };

  if (config.deployMetadata) {
    labels['git-sha'] = config.deployMetadata.sha;
    labels['git-branch'] = normalizeKubernetesLabelValue(config.deployMetadata.branch);
    labels['deploy-id'] = config.deployMetadata.deployId || '';
    labels['deployable-id'] = config.deployMetadata.deployableId;
  }

  const initContainers: any[] = [];
  if (config.includeGitClone && config.cloneScript) {
    initContainers.push({
      name: 'clone-repo',
      image: 'alpine/git:latest',
      env: [
        { name: 'GIT_USERNAME', value: config.gitUsername || 'x-access-token' },
        { name: 'GIT_PASSWORD', value: config.gitToken || '' },
      ],
      command: ['/bin/sh', '-c'],
      args: [config.cloneScript],
      resources: {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { cpu: '500m', memory: '512Mi' },
      },
      volumeMounts: [{ name: 'helm-workspace', mountPath: '/workspace' }],
    });
  }

  const containers = config.containers.map((container) => ({
    ...container,
    resources: container.resources || {
      requests: { cpu: '200m', memory: '256Mi' },
      limits: { cpu: '1000m', memory: '1Gi' },
    },
  }));

  return createKubernetesJob({
    name: config.name,
    namespace: config.namespace,
    appName: 'native-helm',
    component: 'deployment',
    serviceAccount: config.serviceAccount,
    timeout,
    ttl,
    labels,
    initContainers,
    containers,
    volumes: config.volumes || [{ name: 'helm-workspace', emptyDir: {} }],
    tolerations: [
      {
        key: 'builder',
        operator: 'Equal',
        value: 'yes',
        effect: 'NoSchedule',
      },
    ],
    terminationGracePeriodSeconds: 300,
  });
}
