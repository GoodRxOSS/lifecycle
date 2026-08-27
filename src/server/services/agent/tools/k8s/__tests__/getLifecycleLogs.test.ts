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

import { GetLifecycleLogsTool } from '../getLifecycleLogs';

function createK8sClient() {
  return {
    coreApi: {
      listNamespacedPod: jest.fn(),
      readNamespacedPodLog: jest.fn(),
    },
  } as any;
}

function pods(...names: Array<string | null>) {
  return {
    body: {
      items: names.map((name) => (name == null ? { metadata: {} } : { metadata: { name } })),
    },
  };
}

describe('GetLifecycleLogsTool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('publishes the lifecycle log tool contract', () => {
    const tool = new GetLifecycleLogsTool(createK8sClient());

    expect(tool.name).toBe('get_lifecycle_logs');
    expect(tool.description).toContain('LAST RESORT');
    expect(tool.parameters.properties?.service_type.enum).toEqual(['worker', 'web', 'all']);
  });

  it('returns cancellation before resolving build scope or calling Kubernetes', async () => {
    const client = createK8sClient();
    const tool = new GetLifecycleLogsTool(client);

    const result = await tool.execute({}, { aborted: true } as AbortSignal);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: { code: 'CANCELLED', message: 'Operation cancelled' },
      })
    );
    expect(client.coreApi.listNamespacedPod).not.toHaveBeenCalled();
  });

  it('requires a build UUID when the tool has no environment scope', async () => {
    const client = createK8sClient();
    const tool = new GetLifecycleLogsTool(client);

    const result = await tool.execute({ build_uuid: '   ' });

    expect(result.success).toBe(false);
    expect(result.error).toEqual({ code: 'BUILD_NOT_ALLOWED', message: 'build_uuid is required' });
    expect(client.coreApi.listNamespacedPod).not.toHaveBeenCalled();
  });

  it('rejects a requested UUID outside the configured build and accepts a trimmed matching UUID', async () => {
    const client = createK8sClient();
    const tool = new GetLifecycleLogsTool(client);
    tool.setAllowedBuildUuid('  build-1  ');

    const rejected = await tool.execute({ build_uuid: 'build-2' });

    expect(rejected.success).toBe(false);
    expect(rejected.error).toEqual({
      code: 'BUILD_NOT_ALLOWED',
      message: `build_uuid "build-2" is outside this environment's build "build-1" and cannot be accessed.`,
    });

    client.coreApi.listNamespacedPod.mockResolvedValue(pods());
    const accepted = await tool.execute({ build_uuid: ' build-1 ' });
    expect(accepted.success).toBe(true);
    expect(client.coreApi.listNamespacedPod).toHaveBeenCalledTimes(1);
  });

  it('allows an explicit UUID without configured scope and defaults to configured scope when omitted', async () => {
    const client = createK8sClient();
    client.coreApi.listNamespacedPod.mockResolvedValue({ body: { items: [] } });
    const unscoped = new GetLifecycleLogsTool(client);

    const explicit = await unscoped.execute({ build_uuid: ' build-explicit ' });
    expect(explicit.success).toBe(true);
    expect(explicit.agentContent).toContain('warnings: No pods found for worker');

    const scoped = new GetLifecycleLogsTool(client);
    scoped.setAllowedBuildUuid('build-default');
    const defaulted = await scoped.execute({});
    expect(defaulted.agentContent).toContain('build build-default');
  });

  it('returns a concise no-log result when pods have no matching lines', async () => {
    const client = createK8sClient();
    client.coreApi.listNamespacedPod.mockResolvedValue(pods('worker-1'));
    client.coreApi.readNamespacedPodLog.mockResolvedValue({ body: 'unrelated line\nanother line' });
    const tool = new GetLifecycleLogsTool(client);
    tool.setAllowedBuildUuid('build-1');

    const result = await tool.execute({});

    expect(result.success).toBe(true);
    expect(result.agentContent).toBe(
      'No control-plane logs found for build UUID build-1 in worker service(s) over the last 30 minutes.'
    );
    expect(result.displayContent).toEqual({ type: 'text', content: 'No logs found for build-1' });
    expect(client.coreApi.listNamespacedPod).toHaveBeenCalledWith(
      'lifecycle-app',
      undefined,
      undefined,
      undefined,
      undefined,
      'app.kubernetes.io/instance=lifecycle,app.kubernetes.io/component=worker'
    );
    expect(client.coreApi.readNamespacedPodLog).toHaveBeenCalledWith(
      'worker-1',
      'lifecycle-app',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      30 * 60,
      200
    );
  });

  it('caps the lookback, fetches worker and web pods, skips nameless pods, and honors tail lines', async () => {
    const client = createK8sClient();
    client.coreApi.listNamespacedPod.mockResolvedValueOnce(pods('worker-1', null)).mockResolvedValueOnce(pods('web-1'));
    client.coreApi.readNamespacedPodLog
      .mockResolvedValueOnce({ body: '[build-1] worker line' })
      .mockResolvedValueOnce({ body: '[DEPLOY build-1] web line' });
    const tool = new GetLifecycleLogsTool(client);
    tool.setAllowedBuildUuid('build-1');

    const result = await tool.execute({ service_type: 'all', since_minutes: 90, tail_lines: 25 });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('(all, last 60 minutes): 2 matching lines from 2 pod(s)');
    expect(result.agentContent).toContain('[worker/worker-1] [build-1] worker line');
    expect(result.agentContent).toContain('[web/web-1] [DEPLOY build-1] web line');
    expect(client.coreApi.readNamespacedPodLog).toHaveBeenCalledTimes(2);
    expect(client.coreApi.readNamespacedPodLog.mock.calls[0].slice(-2)).toEqual([60 * 60, 25]);
  });

  it('fetches only web logs when requested and uses the default numeric values for zeroes', async () => {
    const client = createK8sClient();
    client.coreApi.listNamespacedPod.mockResolvedValue(pods('web-1'));
    client.coreApi.readNamespacedPodLog.mockResolvedValue({ body: '[BUILD build-1] web line' });
    const tool = new GetLifecycleLogsTool(client);
    tool.setAllowedBuildUuid('build-1');

    const result = await tool.execute({ service_type: 'web', since_minutes: 0, tail_lines: 0 });

    expect(result.success).toBe(true);
    expect(client.coreApi.listNamespacedPod).toHaveBeenCalledTimes(1);
    expect(client.coreApi.listNamespacedPod.mock.calls[0][5]).toContain('component=web');
    expect(client.coreApi.readNamespacedPodLog.mock.calls[0].slice(-2)).toEqual([30 * 60, 200]);
  });

  it('expands build-matched JSON logs by discovered correlation ID and deduplicates clean output', async () => {
    const client = createK8sClient();
    const correlated = '{"build":"build-1","correlationId":"corr-1","message":"start"}';
    client.coreApi.listNamespacedPod.mockResolvedValue(pods('worker-1'));
    client.coreApi.readNamespacedPodLog.mockResolvedValue({
      body: [
        correlated,
        '\u001b[31mcorr-1 follow-up\u001b[0m',
        '\u001b[31mcorr-1 follow-up\u001b[0m',
        '[BUILD build-1] excluded after correlation expansion',
      ].join('\n'),
    });
    const tool = new GetLifecycleLogsTool(client);
    tool.setAllowedBuildUuid('build-1');

    const result = await tool.execute({});

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('correlationIds=corr-1 expandedByCorrelation=true');
    expect(result.agentContent).toContain('[worker/worker-1] [repeated 2x] corr-1 follow-up');
    expect(result.agentContent).not.toContain('\u001b[31m');
    expect(result.agentContent.match(/corr-1 follow-up/g)).toHaveLength(1);
    expect(result.agentContent).not.toContain('excluded after correlation expansion');
    expect(result.displayContent).toEqual({ type: 'text', content: 'Lifecycle logs: 3 lines from 1 pods' });
  });

  it('discovers correlation IDs from non-JSON log text and ignores the unknown sentinel', async () => {
    const client = createK8sClient();
    client.coreApi.listNamespacedPod.mockResolvedValue(pods('worker-1'));
    client.coreApi.readNamespacedPodLog.mockResolvedValue({
      body: [
        'not-json build-1 "correlationId": "corr-text"',
        'corr-text continuation',
        '{"build":"build-1","correlationId":"unknown"}',
      ].join('\n'),
    });
    const tool = new GetLifecycleLogsTool(client);
    tool.setAllowedBuildUuid('build-1');

    const result = await tool.execute({});

    expect(result.agentContent).toContain('correlationIds=corr-text expandedByCorrelation=true');
    expect(result.agentContent).toContain('corr-text continuation');
    expect(result.agentContent).not.toContain('correlationIds=corr-text,unknown');
  });

  it('uses a supplied correlation ID even when no line contains the build UUID', async () => {
    const client = createK8sClient();
    client.coreApi.listNamespacedPod.mockResolvedValue(pods('worker-1'));
    client.coreApi.readNamespacedPodLog.mockResolvedValue({ body: 'corr-direct scheduling line\nunrelated' });
    const tool = new GetLifecycleLogsTool(client);
    tool.setAllowedBuildUuid('build-1');

    const result = await tool.execute({ correlation_id: 'corr-direct' });

    expect(result.agentContent).toContain('correlationIds=corr-direct expandedByCorrelation=true');
    expect(result.agentContent).toContain('corr-direct scheduling line');
  });

  it('reports pod-discovery and pod-log failures as warnings while preserving successful logs', async () => {
    const client = createK8sClient();
    client.coreApi.listNamespacedPod
      .mockRejectedValueOnce(new Error('worker API unavailable'))
      .mockResolvedValueOnce(pods('web-broken', 'web-empty', 'web-good'));
    client.coreApi.readNamespacedPodLog
      .mockRejectedValueOnce(new Error('log stream denied'))
      .mockResolvedValueOnce({ body: '' })
      .mockResolvedValueOnce({ body: '[build-1] recovered line' });
    const tool = new GetLifecycleLogsTool(client);
    tool.setAllowedBuildUuid('build-1');

    const result = await tool.execute({ service_type: 'all' });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('warnings: Failed to process deployment worker: worker API unavailable');
    expect(result.agentContent).toContain('Failed to get logs from pod web-broken: log stream denied');
    expect(result.agentContent).toContain('[web/web-good] [build-1] recovered line');
  });

  it('returns warning-only output when Kubernetes has no pods and handles an unsupported service selector', async () => {
    const client = createK8sClient();
    client.coreApi.listNamespacedPod.mockResolvedValue({ body: { items: [] } });
    const tool = new GetLifecycleLogsTool(client);
    tool.setAllowedBuildUuid('build-1');

    const noPods = await tool.execute({ service_type: 'worker' });
    expect(noPods.success).toBe(true);
    expect(noPods.agentContent).toContain('warnings: No pods found for worker');
    expect(noPods.displayContent).toEqual({ type: 'text', content: 'Lifecycle logs: 0 lines from 0 pods' });

    client.coreApi.listNamespacedPod.mockClear();
    const unsupported = await tool.execute({ service_type: 'database' });
    expect(unsupported.agentContent).toContain(
      'No control-plane logs found for build UUID build-1 in database service(s)'
    );
    expect(client.coreApi.listNamespacedPod).not.toHaveBeenCalled();
  });
});
