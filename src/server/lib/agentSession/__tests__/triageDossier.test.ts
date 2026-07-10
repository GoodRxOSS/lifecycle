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

import { buildTriageDossier, classifyDeployPhase, TriageCoreApi } from '../triageDossier';

function fakeCoreApi(overrides: Partial<TriageCoreApi> = {}): TriageCoreApi {
  return {
    listNamespacedPod: jest.fn().mockResolvedValue({ body: { items: [] } }),
    listNamespacedEvent: jest.fn().mockResolvedValue({ body: { items: [] } }),
    readNamespacedPodLog: jest.fn().mockResolvedValue({ body: '' }),
    ...overrides,
  };
}

const healthyBuild = { uuid: 'build-1', status: 'deployed', statusMessage: 'ok', namespace: 'env-build-1' };
const failedBuild = { uuid: 'build-1', status: 'deploy_failed', statusMessage: 'web failed', namespace: 'env-build-1' };

describe('classifyDeployPhase', () => {
  it('classifies statuses into phases', () => {
    expect(classifyDeployPhase({ status: 'build_failed' })).toBe('build');
    expect(classifyDeployPhase({ status: 'deploy_failed', statusMessage: 'helm upgrade failed' })).toBe('deploy');
    expect(
      classifyDeployPhase({ status: 'deploy_failed', statusMessage: 'Pods failed to become ready within timeout' })
    ).toBe('runtime');
    expect(classifyDeployPhase({ status: 'error', statusMessage: 'CI build failed.' })).toBe('build');
    expect(classifyDeployPhase({ status: 'error', statusMessage: 'Aurora restore failed.' })).toBe('deploy');
  });
});

describe('buildTriageDossier', () => {
  it('returns null when nothing is failing', async () => {
    await expect(
      buildTriageDossier(healthyBuild, [{ uuid: 'web-build-1', status: 'ready', deployable: { name: 'web' } }])
    ).resolves.toBeNull();
  });

  it('returns null for queued deploys when nothing failed', async () => {
    await expect(
      buildTriageDossier({ ...healthyBuild, status: 'deploying' }, [
        { uuid: 'web-build-1', status: 'queued', deployable: { name: 'web' } },
      ])
    ).resolves.toBeNull();
  });

  it('renders a config block from the build statusMessage for config_error', async () => {
    const dossier = await buildTriageDossier(
      { uuid: 'build-1', status: 'config_error', statusMessage: 'lifecycle.yaml: services[0].name is required' },
      []
    );

    expect(dossier).toContain('## environment — phase=config status=config_error');
    expect(dossier).toContain('- buildStatusMessage: lifecycle.yaml: services[0].name is required');
  });

  it('renders build-phase evidence from persisted buildOutput and notes when it is missing', async () => {
    const dossier = await buildTriageDossier(failedBuild, [
      {
        uuid: 'web-build-1',
        status: 'build_failed',
        statusMessage: 'Build failed',
        buildOutput: 'step 1 ok\nstep 2 ok\nERROR: missing Dockerfile at services/web/Dockerfile',
        deployable: { name: 'web' },
      },
      {
        uuid: 'api-build-1',
        status: 'build_failed',
        statusMessage: 'Build failed',
        deployable: { name: 'api' },
      },
    ]);

    expect(dossier).toContain('## web — phase=build status=build_failed');
    expect(dossier).toContain('ERROR: missing Dockerfile at services/web/Dockerfile');
    expect(dossier).toContain('```log');
    expect(dossier).toContain('## api — phase=build status=build_failed');
    expect(dossier).toContain('- build logs unavailable (no persisted buildOutput)');
  });

  it('collects runtime evidence from k8s for pod-not-ready failures', async () => {
    const coreApi = fakeCoreApi({
      listNamespacedPod: jest.fn().mockResolvedValue({
        body: {
          items: [
            { metadata: { name: 'web-build-1-deploy-abc' } },
            {
              metadata: { name: 'web-build-1-7f9' },
              status: {
                phase: 'Running',
                conditions: [{ type: 'Ready', status: 'False' }],
                initContainerStatuses: [
                  { name: 'init-db', restartCount: 2, state: { terminated: { reason: 'Error', exitCode: 1 } } },
                ],
                containerStatuses: [
                  {
                    name: 'web',
                    restartCount: 7,
                    state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m restarting' } },
                  },
                ],
              },
            },
          ],
        },
      }),
      listNamespacedEvent: jest.fn().mockResolvedValue({
        body: {
          items: [
            { type: 'Normal', reason: 'Pulled', message: 'ok', involvedObject: { name: 'web-build-1-7f9' } },
            {
              type: 'Warning',
              reason: 'BackOff',
              message: 'Back-off restarting failed container',
              count: 42,
              involvedObject: { name: 'web-build-1-7f9' },
            },
          ],
        },
      }),
      readNamespacedPodLog: jest.fn().mockResolvedValue({ body: 'Error: connect ECONNREFUSED redis:6379' }),
    });

    const dossier = await buildTriageDossier(
      failedBuild,
      [
        {
          uuid: 'web-build-1',
          status: 'deploy_failed',
          statusMessage: 'Pods failed to become ready within timeout',
          deployable: { name: 'web' },
        },
      ],
      { coreApi }
    );

    expect(dossier).toContain('## web — phase=runtime status=deploy_failed');
    expect(dossier).toContain(
      '- pod web-build-1-7f9: init init-db terminated=Error exit=1 restarts=2; web waiting=CrashLoopBackOff (back-off 5m restarting) restarts=7'
    );
    expect(dossier).toContain('- event: BackOff Back-off restarting failed container (x42)');
    expect(dossier).toContain('- previous logs (web-build-1-7f9):');
    expect(dossier).toContain('Error: connect ECONNREFUSED redis:6379');
    expect(coreApi.readNamespacedPodLog).toHaveBeenCalledWith(
      'web-build-1-7f9',
      'env-build-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      40
    );
  });

  it('degrades to a one-line note when k8s reads fail', async () => {
    const coreApi = fakeCoreApi({
      listNamespacedPod: jest.fn().mockRejectedValue(new Error('connect ETIMEDOUT 10.0.0.1:443')),
    });

    const dossier = await buildTriageDossier(
      failedBuild,
      [
        {
          uuid: 'web-build-1',
          status: 'deploy_failed',
          statusMessage: 'Pods failed to become ready within timeout',
          deployable: { name: 'web' },
        },
      ],
      { coreApi }
    );

    expect(dossier).toContain('- k8s evidence unavailable: connect ETIMEDOUT 10.0.0.1:443');
  });

  it('notes a missing namespace instead of calling k8s', async () => {
    const dossier = await buildTriageDossier({ uuid: 'build-1', status: 'deploy_failed' }, [
      {
        uuid: 'web-build-1',
        status: 'deploy_failed',
        statusMessage: 'Pods failed to become ready within timeout',
        deployable: { name: 'web' },
      },
    ]);

    expect(dossier).toContain('- k8s evidence unavailable: build namespace unknown');
  });

  it('marks queued deploys blocked, naming the failing dependency', async () => {
    const dossier = await buildTriageDossier(failedBuild, [
      {
        uuid: 'web-build-1',
        status: 'build_failed',
        buildOutput: 'ERROR: build broke',
        deployable: { name: 'web' },
      },
      {
        uuid: 'worker-build-1',
        status: 'queued',
        deployable: { name: 'worker', deploymentDependsOn: ['web'] },
      },
      {
        uuid: 'other-build-1',
        status: 'queued',
        deployable: { name: 'other' },
      },
    ]);

    expect(dossier).toContain('## worker — phase=blocked status=queued\n- blocked: waiting on failed deploy web');
    expect(dossier).toContain('## other — phase=blocked status=queued\n- blocked: waiting on failed deploy web');
  });

  it('ignores inactive deploys', async () => {
    await expect(
      buildTriageDossier(healthyBuild, [
        { uuid: 'old-build-1', status: 'build_failed', active: false, deployable: { name: 'old' } },
      ])
    ).resolves.toBeNull();
  });

  it('caps per-deploy evidence, detailed deploy count, and total size', async () => {
    const hugeLog = `start\n${'filler line with no signal\n'.repeat(2000)}ERROR: the actual cause`;
    const failing = Array.from({ length: 6 }, (_, i) => ({
      uuid: `svc${i}-build-1`,
      status: 'build_failed',
      statusMessage: `svc${i} build failed`,
      buildOutput: hugeLog,
      deployable: { name: `svc${i}` },
    }));

    const dossier = (await buildTriageDossier(failedBuild, failing)) as string;

    expect(dossier.length).toBeLessThanOrEqual(12200);
    const blocks = dossier.split('\n## ');
    const detailed = blocks.filter((block) => block.includes('```log'));
    expect(detailed.length).toBeLessThanOrEqual(4);
    for (const block of blocks) {
      expect(block.length).toBeLessThanOrEqual(3700);
    }
    expect(dossier).toContain('ERROR: the actual cause');
    expect(dossier).toContain('phase=build status=build_failed (evidence omitted: svc4 build failed)');
  });

  it('falls back to a build-level block when the build failed with no failing deploys', async () => {
    const dossier = await buildTriageDossier(
      { uuid: 'build-1', status: 'build_failed', statusMessage: 'something broke upstream' },
      []
    );

    expect(dossier).toContain('## environment — phase=build status=build_failed');
    expect(dossier).toContain('- buildStatusMessage: something broke upstream');
  });
});
