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
import { createKubernetesJob, JobConfig } from './jobFactory';
import { randomAlphanumeric } from 'server/lib/random';

export interface WebhookJobConfig {
  name: string;
  namespace: string;
  serviceAccount: string;
  buildUuid: string;
  buildId: string;
  buildSha?: string;
  webhookName: string;
  webhookType: 'docker' | 'command';
  image: string;
  command?: string[];
  args?: string[];
  script?: string;
  env: Record<string, string>;
  timeout?: number;
}

const DEFAULT_WEBHOOK_TIMEOUT = 1800; // 30 minutes
const DEFAULT_RESOURCES = {
  requests: { cpu: '200m', memory: '1Gi' },
  limits: { cpu: '200m', memory: '1Gi' },
};

export function createWebhookJob(config: WebhookJobConfig): V1Job {
  const jobId = randomAlphanumeric(4).toLowerCase();
  const sanitizedWebhookName =
    config.webhookName
      ?.toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .substring(0, 20) || 'webhook';

  const shortSha = config.buildSha ? config.buildSha.substring(0, 7) : 'unknown';

  let jobName = `wh-${sanitizedWebhookName}-${config.buildUuid}-${jobId}-${shortSha}`.substring(0, 63);
  if (jobName.endsWith('-')) {
    jobName = jobName.slice(0, -1);
  }

  const timeout = config.timeout || DEFAULT_WEBHOOK_TIMEOUT;
  const ttl = 86400; // 24 hours

  // Create container configuration based on webhook type
  let container: any;
  if (config.webhookType === 'docker') {
    container = {
      name: 'webhook-executor',
      image: config.image,
      command: config.command,
      args: config.args,
      env: Object.entries(config.env).map(([name, value]) => ({ name, value })),
      resources: DEFAULT_RESOURCES,
    };
  } else if (config.webhookType === 'command') {
    // For command type, we wrap the script in a shell command
    container = {
      name: 'webhook-executor',
      image: config.image,
      command: ['/bin/sh', '-c'],
      args: [config.script],
      env: Object.entries(config.env).map(([name, value]) => ({ name, value })),
      resources: DEFAULT_RESOURCES,
    };
  }

  const jobConfig: JobConfig = {
    name: jobName,
    namespace: config.namespace,
    appName: 'webhook',
    component: 'build',
    serviceAccount: config.serviceAccount,
    timeout,
    ttl,
    labels: {
      lc_uuid: config.buildUuid,
      'lfc/uuid': config.buildUuid,
      'lfc/build_id': String(config.buildId),
      'lfc/webhook_name': sanitizedWebhookName,
      'lfc/webhook_type': config.webhookType,
    },
    annotations: {
      'lfc/webhook_name': config.webhookName,
      'lfc/webhook_type': config.webhookType,
    },
    containers: [container],
  };

  return createKubernetesJob(jobConfig);
}
