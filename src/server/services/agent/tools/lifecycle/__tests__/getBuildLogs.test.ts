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

const mockListNamespacedPod = jest.fn();
const mockReadNamespacedPodLog = jest.fn();

jest.mock('server/models/Deploy', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('../../shared/k8sClient', () => ({
  K8sClient: jest.fn().mockImplementation(() => ({
    coreApi: {
      listNamespacedPod: mockListNamespacedPod,
      readNamespacedPodLog: mockReadNamespacedPodLog,
    },
  })),
}));

import Deploy from 'server/models/Deploy';
import { GetBuildLogsTool } from '../getBuildLogs';

function mockDeployLookup(row: unknown) {
  const withGraphFetched = jest.fn().mockResolvedValue(row);
  const findOne = jest.fn().mockReturnValue({ withGraphFetched });
  (Deploy.query as jest.Mock).mockReturnValue({ findOne });
  return { findOne, withGraphFetched };
}

describe('GetBuildLogsTool', () => {
  let tool: GetBuildLogsTool;

  beforeEach(() => {
    jest.clearAllMocks();
    tool = new GetBuildLogsTool();
    tool.setAllowedBuildUuid('sample-build-1');
  });

  it('rejects execution without a session build', async () => {
    tool.setAllowedBuildUuid(null);
    const result = await tool.execute({ service_name: 'web' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('BUILD_NOT_ALLOWED');
  });

  it('requires service_name', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ARGS');
  });

  it('reports a missing deploy by its derived uuid', async () => {
    const { findOne } = mockDeployLookup(undefined);
    const result = await tool.execute({ service_name: 'web' });

    expect(findOne).toHaveBeenCalledWith({ uuid: 'web-sample-build-1' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DEPLOY_NOT_FOUND');
  });

  it('returns the persisted buildOutput tail as plain text', async () => {
    mockDeployLookup({
      uuid: 'web-sample-build-1',
      status: 'build_failed',
      buildOutput: 'step 1\nstep 2\nERROR: missing Dockerfile',
      build: { namespace: 'env-sample-build-1' },
    });

    const result = await tool.execute({ service_name: 'web' });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('Persisted build/deploy logs for web (status=build_failed');
    expect(result.agentContent).toContain('```\nstep 1\nstep 2\nERROR: missing Dockerfile\n```');
    expect(mockListNamespacedPod).not.toHaveBeenCalled();
  });

  it('keeps the end of oversized persisted logs', async () => {
    const buildOutput = `${'x'.repeat(20000)}\nERROR: at the very end`;
    mockDeployLookup({
      uuid: 'web-sample-build-1',
      status: 'build_failed',
      buildOutput,
      build: { namespace: 'env-sample-build-1' },
    });

    const result = await tool.execute({ service_name: 'web' });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('[... truncated, showing last 15000 of');
    expect(result.agentContent).toContain('ERROR: at the very end');
    expect((result.agentContent as string).length).toBeLessThan(16000);
  });

  it('falls back to live job pod logs when buildOutput is empty', async () => {
    mockDeployLookup({
      uuid: 'web-sample-build-1',
      status: 'building',
      buildOutput: null,
      build: { namespace: 'env-sample-build-1' },
    });
    mockListNamespacedPod.mockResolvedValue({
      body: {
        items: [
          { metadata: { name: 'web-sample-build-1-7f9', creationTimestamp: '2026-06-01T00:00:00Z' } },
          { metadata: { name: 'web-sample-build-1-build-abc-x1', creationTimestamp: '2026-06-01T00:01:00Z' } },
        ],
      },
    });
    mockReadNamespacedPodLog.mockResolvedValue({ body: 'npm install\nERROR: lockfile mismatch' });

    const result = await tool.execute({ service_name: 'web', phase: 'build' });

    expect(mockListNamespacedPod).toHaveBeenCalledWith(
      'env-sample-build-1',
      undefined,
      undefined,
      undefined,
      undefined,
      'deploy_uuid=web-sample-build-1'
    );
    expect(mockReadNamespacedPodLog).toHaveBeenCalledWith('web-sample-build-1-build-abc-x1', 'env-sample-build-1');
    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('Live build job logs from pod web-sample-build-1-build-abc-x1');
    expect(result.agentContent).toContain('ERROR: lockfile mismatch');
  });

  it('says plainly when neither persisted nor live logs exist', async () => {
    mockDeployLookup({
      uuid: 'web-sample-build-1',
      status: 'deploy_failed',
      buildOutput: '',
      build: { namespace: 'env-sample-build-1' },
    });
    mockListNamespacedPod.mockResolvedValue({ body: { items: [] } });

    const result = await tool.execute({ service_name: 'web' });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('No logs available for web');
    expect(result.agentContent).toContain('buildOutput is empty');
  });

  it('says plainly when the k8s fallback errors', async () => {
    mockDeployLookup({
      uuid: 'web-sample-build-1',
      status: 'deploy_failed',
      buildOutput: '',
      build: { namespace: 'env-sample-build-1' },
    });
    mockListNamespacedPod.mockRejectedValue(new Error('forbidden'));

    const result = await tool.execute({ service_name: 'web' });

    expect(result.success).toBe(true);
    expect(result.agentContent).toContain('No logs available for web');
  });
});
