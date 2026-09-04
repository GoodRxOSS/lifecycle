/**
 * Copyright 2026 Lifecycle contributors
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

const mockYamlDump = jest.fn();
const mockMkdir = jest.fn();
const mockWriteFile = jest.fn();
const mockCreateWebhookJob = jest.fn();
const mockShellPromise = jest.fn();
const mockWaitForJobAndGetLogs = jest.fn();
const mockEnsureServiceAccountForJob = jest.fn();
const mockLogger = { error: jest.fn(), info: jest.fn() };

jest.mock('js-yaml', () => ({
  __esModule: true,
  default: { dump: (value: unknown) => mockYamlDump(value) },
}));

jest.mock('fs', () => ({
  __esModule: true,
  default: {
    promises: {
      mkdir: (...args: unknown[]) => mockMkdir(...args),
      writeFile: (...args: unknown[]) => mockWriteFile(...args),
    },
  },
}));

jest.mock('server/lib/kubernetes/webhookJobFactory', () => ({
  createWebhookJob: (config: unknown) => mockCreateWebhookJob(config),
}));

jest.mock('server/lib/shell', () => ({
  shellPromise: (command: string) => mockShellPromise(command),
}));

jest.mock('server/lib/nativeBuild/utils', () => ({
  waitForJobAndGetLogs: (...args: unknown[]) => mockWaitForJobAndGetLogs(...args),
}));

jest.mock('server/lib/kubernetes/common/serviceAccount', () => ({
  ensureServiceAccountForJob: (...args: unknown[]) => mockEnsureServiceAccountForJob(...args),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => mockLogger),
}));

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'execution-id'),
}));

import { executeCommandWebhook, executeDockerWebhook } from './index';

const build = {
  id: 42,
  uuid: 'build-uuid',
  sha: 'commit-sha',
  namespace: 'env-build-uuid',
};

describe('webhook job execution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureServiceAccountForJob.mockResolvedValue('webhook-service-account');
    mockCreateWebhookJob.mockReturnValue({ metadata: { name: 'webhook-job' } });
    mockYamlDump.mockReturnValue('apiVersion: batch/v1');
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockShellPromise.mockResolvedValue(undefined);
    mockWaitForJobAndGetLogs.mockResolvedValue({
      success: true,
      status: 'complete',
      logs: 'job output',
    });
  });

  it('rejects a Docker webhook without Docker configuration', async () => {
    await expect(executeDockerWebhook({ type: 'docker' } as any, build as any, {})).rejects.toThrow(
      'Docker webhook configuration is missing'
    );
    expect(mockEnsureServiceAccountForJob).not.toHaveBeenCalled();
  });

  it('rejects a command webhook without command configuration', async () => {
    await expect(executeCommandWebhook({ type: 'command' } as any, build as any, {})).rejects.toThrow(
      'Command webhook configuration is missing'
    );
    expect(mockEnsureServiceAccountForJob).not.toHaveBeenCalled();
  });

  it('creates, applies, waits for, and returns a Docker webhook job', async () => {
    const webhook = {
      name: 'purge-cache',
      type: 'docker',
      docker: {
        image: 'alpine:3',
        command: ['sh'],
        args: ['-c', 'echo done'],
        timeout: 90,
      },
    };
    const env = { BUILD_UUID: 'build-uuid' };

    await expect(executeDockerWebhook(webhook as any, build as any, env)).resolves.toEqual({
      success: true,
      jobName: 'webhook-job',
      logs: 'job output',
      status: 'complete',
      metadata: {},
    });

    expect(mockEnsureServiceAccountForJob).toHaveBeenCalledWith('env-build-uuid', 'webhook');
    expect(mockCreateWebhookJob).toHaveBeenCalledWith({
      name: 'purge-cache',
      namespace: 'env-build-uuid',
      serviceAccount: 'webhook-service-account',
      buildUuid: 'build-uuid',
      buildId: '42',
      buildSha: 'commit-sha',
      webhookName: 'purge-cache',
      webhookType: 'docker',
      image: 'alpine:3',
      command: ['sh'],
      args: ['-c', 'echo done'],
      env,
      timeout: 90,
    });
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/lifecycle/manifests/webhooks', { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/tmp/lifecycle/manifests/webhooks/webhook-job-execution-id.yaml',
      'apiVersion: batch/v1',
      'utf8'
    );
    expect(mockShellPromise).toHaveBeenCalledWith(
      'kubectl apply -f /tmp/lifecycle/manifests/webhooks/webhook-job-execution-id.yaml'
    );
    expect(mockWaitForJobAndGetLogs).toHaveBeenCalledWith('webhook-job', 'env-build-uuid', '[WEBHOOK build-uuid]');
  });

  it('uses command defaults and maps a successful result without status to succeeded', async () => {
    mockWaitForJobAndGetLogs.mockResolvedValue({ success: true, status: '', logs: 'done' });
    const webhook = { type: 'command', command: { image: 'alpine:3', script: 'echo done' } };

    const result = await executeCommandWebhook(webhook as any, build as any, { VALUE: 'one' });

    expect(mockCreateWebhookJob).toHaveBeenCalledWith({
      name: 'command-webhook',
      namespace: 'env-build-uuid',
      serviceAccount: 'webhook-service-account',
      buildUuid: 'build-uuid',
      buildId: '42',
      buildSha: 'commit-sha',
      webhookName: 'command-webhook',
      webhookType: 'command',
      image: 'alpine:3',
      script: 'echo done',
      env: { VALUE: 'one' },
      timeout: undefined,
    });
    expect(result.status).toBe('succeeded');
  });

  it('uses Docker defaults and maps an unsuccessful result without status to failed', async () => {
    mockWaitForJobAndGetLogs.mockResolvedValue({ success: false, status: null, logs: 'failed output' });
    const webhook = { type: 'docker', docker: { image: 'alpine:3' } };

    const result = await executeDockerWebhook(webhook as any, build as any, {});

    expect(mockCreateWebhookJob).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'docker-webhook',
        webhookName: 'docker-webhook',
      })
    );
    expect(result).toMatchObject({ success: false, status: 'failed', logs: 'failed output' });
  });

  it.each([
    ['an Error', new Error('kubectl unavailable'), 'kubectl unavailable'],
    ['a non-Error rejection', 'plain failure', 'plain failure'],
  ])('returns a failed execution result for %s', async (_name, failure, expectedMessage) => {
    mockShellPromise.mockRejectedValue(failure);

    await expect(
      executeCommandWebhook(
        { name: 'notify', type: 'command', command: { image: 'alpine', script: 'echo done' } } as any,
        build as any,
        {}
      )
    ).resolves.toEqual({
      success: false,
      jobName: '',
      logs: expectedMessage,
      status: 'failed',
      metadata: { error: expectedMessage },
    });
    expect(mockLogger.error).toHaveBeenCalledWith({ error: failure }, 'Webhook: execution failed name=notify');
  });
});
