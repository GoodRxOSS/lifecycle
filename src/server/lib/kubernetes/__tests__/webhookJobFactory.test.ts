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

jest.mock('server/lib/random', () => ({
  randomAlphanumeric: jest.fn(() => 'Ab9Z'),
}));

import { createWebhookJob, WebhookJobConfig } from '../webhookJobFactory';

function config(overrides: Partial<WebhookJobConfig> = {}): WebhookJobConfig {
  return {
    name: 'webhook-request',
    namespace: 'env-build',
    serviceAccount: 'lifecycle-tools',
    buildUuid: 'build-uuid',
    buildId: '42',
    buildSha: 'abcdef0123456789',
    webhookName: 'Release Hook',
    webhookType: 'docker',
    image: 'example.invalid/hooks/release:v1',
    command: ['/hooks/run'],
    args: ['--release'],
    env: { API_URL: 'https://api.example.invalid', RELEASE: 'stable' },
    ...overrides,
  };
}

describe('createWebhookJob', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-27T18:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates a bounded Docker webhook job with identity, timeout, resources, and environment intact', () => {
    const job = createWebhookJob(config());

    expect(job.metadata).toEqual({
      name: 'wh-release-hook-build-uuid-ab9z-abcdef0',
      namespace: 'env-build',
      labels: {
        'app.kubernetes.io/managed-by': 'lifecycle',
        'app.kubernetes.io/name': 'webhook',
        'app.kubernetes.io/component': 'build',
        lc_uuid: 'build-uuid',
        'lfc/uuid': 'build-uuid',
        'lfc/build_id': '42',
        'lfc/webhook_name': 'release-hook',
        'lfc/webhook_type': 'docker',
      },
      annotations: {
        'lfc/triggered-at': '2026-08-27T18:00:00.000Z',
        'lfc/webhook_name': 'Release Hook',
        'lfc/webhook_type': 'docker',
      },
    });
    expect(job.spec).toEqual({
      backoffLimit: 0,
      activeDeadlineSeconds: 1800,
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'webhook',
            'app.kubernetes.io/component': 'build',
          },
        },
        spec: {
          serviceAccountName: 'lifecycle-tools',
          restartPolicy: 'Never',
          terminationGracePeriodSeconds: 30,
          hostNetwork: false,
          hostPID: false,
          hostIPC: false,
          containers: [
            {
              name: 'webhook-executor',
              image: 'example.invalid/hooks/release:v1',
              command: ['/hooks/run'],
              args: ['--release'],
              env: [
                { name: 'API_URL', value: 'https://api.example.invalid' },
                { name: 'RELEASE', value: 'stable' },
              ],
              resources: {
                requests: { cpu: '200m', memory: '1Gi' },
                limits: { cpu: '200m', memory: '1Gi' },
              },
            },
          ],
        },
      },
    });
  });

  it('wraps command webhooks in a shell and honors the requested timeout and missing SHA fallback', () => {
    const job = createWebhookJob(
      config({
        webhookName: '',
        webhookType: 'command',
        buildSha: undefined,
        timeout: 45,
        command: undefined,
        args: undefined,
        script: 'printf "release complete\\n"',
        env: { RELEASE_ID: '42' },
      })
    );

    expect(job.metadata?.name).toBe('wh-webhook-build-uuid-ab9z-unknown');
    expect(job.metadata?.labels).toMatchObject({
      'lfc/webhook_name': 'webhook',
      'lfc/webhook_type': 'command',
    });
    expect(job.metadata?.annotations).toMatchObject({
      'lfc/webhook_name': '',
      'lfc/webhook_type': 'command',
    });
    expect(job.spec?.activeDeadlineSeconds).toBe(45);
    expect(job.spec?.template.spec?.containers).toEqual([
      {
        name: 'webhook-executor',
        image: 'example.invalid/hooks/release:v1',
        command: ['/bin/sh', '-c'],
        args: ['printf "release complete\\n"'],
        env: [{ name: 'RELEASE_ID', value: '42' }],
        resources: {
          requests: { cpu: '200m', memory: '1Gi' },
          limits: { cpu: '200m', memory: '1Gi' },
        },
      },
    ]);
  });

  it('removes a trailing hyphen when a long generated name is truncated at the Kubernetes limit', () => {
    const job = createWebhookJob(config({ webhookName: 'hook', buildUuid: 'a'.repeat(54) }));
    const name = job.metadata?.name || '';

    expect(name).toHaveLength(62);
    expect(name).toBe(`wh-hook-${'a'.repeat(54)}`);
    expect(name).not.toMatch(/-$/);
  });
});
