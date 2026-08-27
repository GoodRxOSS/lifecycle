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

var mockKubeConfig: jest.Mock;
var mockLoadFromDefault: jest.Mock;
var mockMakeApiClient: jest.Mock;

jest.mock('@kubernetes/client-node', () => {
  mockLoadFromDefault = jest.fn();
  mockMakeApiClient = jest.fn();
  mockKubeConfig = jest.fn(() => ({
    loadFromDefault: mockLoadFromDefault,
    makeApiClient: mockMakeApiClient,
  }));
  return {
    KubeConfig: mockKubeConfig,
    CoreV1Api: class CoreV1Api {},
  };
});

import {
  buildTriageDossier,
  classifyDeployPhase,
  collectTriageEvidence,
  renderTriageEvidence,
  TriageCoreApi,
} from '../triageDossier';

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

beforeEach(() => {
  jest.clearAllMocks();
});

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

  it('renders generic build errors as orchestration failures rather than invalid configuration', async () => {
    const dossier = await buildTriageDossier(
      { uuid: 'build-1', status: 'error', statusMessage: 'worker orchestration timed out' },
      []
    );

    expect(dossier).toContain('## environment — phase=orchestration status=error');
    expect(dossier).toContain('- buildStatusMessage: worker orchestration timed out');
    expect(dossier).not.toContain('phase=config');
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

  it('keeps the existing rendered dossier byte-for-byte over structured evidence', async () => {
    const deploys = [
      {
        uuid: 'web-build-1',
        status: 'build_failed',
        statusMessage: 'Build failed',
        buildOutput: 'step 1 ok\nERROR: missing Dockerfile',
        deployable: { name: 'web' },
      },
      {
        uuid: 'worker-build-1',
        status: 'queued',
        deployable: { name: 'worker', deploymentDependsOn: ['web'] },
      },
    ];
    const expected =
      '## web — phase=build status=build_failed\n' +
      '- statusMessage: Build failed\n' +
      '- build logs (tail):\n' +
      '```log\n' +
      'step 1 ok\n' +
      'ERROR: missing Dockerfile\n' +
      '```\n' +
      '## worker — phase=blocked status=queued\n' +
      '- blocked: waiting on failed deploy web';

    const evidence = await collectTriageEvidence(failedBuild, deploys);

    expect(evidence).not.toBeNull();
    expect(renderTriageEvidence(evidence!)).toBe(expected);
    await expect(buildTriageDossier(failedBuild, deploys)).resolves.toBe(expected);
  });

  it('redacts secret canaries before either structured or rendered evidence leaves the helper', async () => {
    const secret = 'supersecretvalue123';
    const deploys = [
      {
        uuid: 'web-build-1',
        status: 'build_failed',
        statusMessage: `PASSWORD=${secret}`,
        buildOutput: `API_KEY=${secret}`,
        deployable: { name: 'web' },
      },
    ];

    const evidence = await collectTriageEvidence(failedBuild, deploys);
    const rendered = await buildTriageDossier(failedBuild, deploys);

    expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain('[redacted]');
  });

  it('pins requested services and states Codefresh limits', async () => {
    const deploys = [
      {
        uuid: 'first-build-1',
        status: 'build_failed',
        buildOutput: 'first evidence',
        deployable: { name: 'first' },
      },
      {
        uuid: 'second-build-1',
        status: 'build_failed',
        buildOutput: 'second evidence',
        deployable: { name: 'second' },
      },
      {
        uuid: 'third-build-1',
        status: 'build_failed',
        buildOutput: 'third evidence',
        deployable: { name: 'third' },
      },
      {
        uuid: 'fourth-build-1',
        status: 'build_failed',
        buildOutput: 'fourth evidence',
        deployable: { name: 'fourth' },
      },
      {
        uuid: 'fifth-build-1',
        status: 'build_failed',
        buildOutput: 'fifth evidence',
        deployable: { name: 'fifth' },
      },
      {
        uuid: 'pipeline-build-1',
        status: 'build_failed',
        provider: 'codefresh' as const,
        deployable: { name: 'pipeline' },
      },
    ];

    const evidence = await collectTriageEvidence(failedBuild, deploys, {
      pinnedServices: ['fifth', 'pipeline'],
    });

    expect(evidence?.failingServices.find((service) => service.name === 'fifth')).toMatchObject({
      detailed: true,
      logTail: expect.stringContaining('fifth evidence'),
    });
    expect(evidence?.failingServices.find((service) => service.name === 'pipeline')).toMatchObject({
      detailed: true,
      unsupportedProvider: 'codefresh',
    });
    expect(renderTriageEvidence(evidence!)).toContain(
      'diagnostic evidence unavailable: Codefresh pipelines are unsupported by this surface'
    );
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
      'web',
      undefined,
      undefined,
      64 * 1024,
      undefined,
      true,
      undefined,
      40
    );
  });

  it('reads previous logs from a restarting init container when app containers have not started', async () => {
    const coreApi = fakeCoreApi({
      listNamespacedPod: jest.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: { name: 'web-build-1-init' },
              status: {
                phase: 'Pending',
                conditions: [{ type: 'Ready', status: 'False' }],
                initContainerStatuses: [
                  {
                    name: 'init-db',
                    restartCount: 3,
                    state: { waiting: { reason: 'CrashLoopBackOff' } },
                    lastState: { terminated: { reason: 'Error', exitCode: 1 } },
                  },
                ],
                containerStatuses: [
                  { name: 'web', restartCount: 0, state: { waiting: { reason: 'PodInitializing' } } },
                ],
              },
            },
          ],
        },
      }),
      readNamespacedPodLog: jest.fn().mockResolvedValue({ body: 'migration failed' }),
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

    expect(dossier).toContain('migration failed');
    expect(coreApi.readNamespacedPodLog).toHaveBeenCalledWith(
      'web-build-1-init',
      'env-build-1',
      'init-db',
      undefined,
      undefined,
      64 * 1024,
      undefined,
      true,
      undefined,
      40
    );
  });

  it.each([
    ['no pods found for this deploy', []],
    [
      'all pods currently Ready (failure may be stale)',
      [
        {
          metadata: { name: 'web-build-1-ready' },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
        },
      ],
    ],
  ])('records the runtime state note %p', async (expectedNote, items) => {
    const coreApi = fakeCoreApi({
      listNamespacedPod: jest.fn().mockResolvedValue({ body: { items } }),
    });

    const dossier = await buildTriageDossier(
      failedBuild,
      [
        {
          uuid: 'web-build-1',
          status: 'deploy_failed',
          statusMessage: 'Pods failed to become ready',
          deployable: { name: 'web' },
        },
      ],
      { coreApi }
    );

    expect(dossier).toContain(`- ${expectedNote}`);
    expect(coreApi.listNamespacedEvent).not.toHaveBeenCalled();
    expect(coreApi.readNamespacedPodLog).not.toHaveBeenCalled();
  });

  it('summarizes restart-only containers, falls back to pod phase, and bounds failing pods', async () => {
    const items = [
      {
        metadata: { name: 'restart-only' },
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'False' }],
          containerStatuses: [
            {
              name: 'app',
              restartCount: 2,
              state: { waiting: { reason: 'ContainerCreating' } },
            },
          ],
        },
      },
      {
        metadata: { name: 'phase-only' },
        status: {
          phase: 'Pending',
          conditions: [{ type: 'Ready', status: 'False' }],
          containerStatuses: [{ name: 'app', restartCount: 0 }],
        },
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        metadata: { name: `extra-${index}` },
        status: { phase: 'Failed', conditions: [{ type: 'Ready', status: 'False' }] },
      })),
    ];
    const coreApi = fakeCoreApi({ listNamespacedPod: jest.fn().mockResolvedValue({ body: { items } }) });

    const dossier = await buildTriageDossier(
      failedBuild,
      [
        {
          uuid: 'web-build-1',
          status: 'deploy_failed',
          statusMessage: 'Pods failed to become ready',
          deployable: { name: 'web' },
        },
      ],
      { coreApi }
    );

    expect(dossier).toContain('- pod restart-only: app restarts=2');
    expect(dossier).toContain('- pod phase-only: phase=Pending');
    expect(dossier).toContain('- (+2 more failing pods)');
  });

  it('keeps pod summaries when events fail and reports the contained event error', async () => {
    const eventError = new Error('events forbidden');
    const coreApi = fakeCoreApi({
      listNamespacedPod: jest.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: { name: 'web-build-1-pod' },
              status: { phase: 'Pending', conditions: [{ type: 'Ready', status: 'False' }] },
            },
          ],
        },
      }),
      listNamespacedEvent: jest.fn().mockRejectedValue(eventError),
    });

    const dossier = await buildTriageDossier(
      failedBuild,
      [
        {
          uuid: 'web-build-1',
          status: 'deploy_failed',
          statusMessage: 'Pods failed to become ready',
          deployable: { name: 'web' },
        },
      ],
      { coreApi }
    );

    expect(dossier).toContain('- pod web-build-1-pod: phase=Pending');
    expect(dossier).toContain('- events unavailable: events forbidden');
  });

  it('reports a failed previous-log read without discarding other runtime evidence', async () => {
    const coreApi = fakeCoreApi({
      listNamespacedPod: jest.fn().mockResolvedValue({
        body: {
          items: [
            {
              metadata: { name: 'web-build-1-crashing' },
              status: {
                phase: 'Running',
                conditions: [{ type: 'Ready', status: 'False' }],
                containerStatuses: [
                  {
                    name: 'web',
                    restartCount: 1,
                    state: { waiting: { reason: 'CrashLoopBackOff' } },
                    lastState: { terminated: { reason: 'Error' } },
                  },
                ],
              },
            },
          ],
        },
      }),
      readNamespacedPodLog: jest.fn().mockRejectedValue(new Error('previous log expired')),
    });

    const dossier = await buildTriageDossier(
      failedBuild,
      [
        {
          uuid: 'web-build-1',
          status: 'deploy_failed',
          statusMessage: 'Pods failed to become ready',
          deployable: { name: 'web' },
        },
      ],
      { coreApi }
    );

    expect(dossier).toContain('- pod web-build-1-crashing: web waiting=CrashLoopBackOff restarts=1');
    expect(dossier).toContain('- previous logs unavailable for web-build-1-crashing');
  });

  it('constructs the default Kubernetes client only for detailed runtime evidence', async () => {
    const coreApi = fakeCoreApi();
    mockMakeApiClient.mockReturnValue(coreApi);

    const dossier = await buildTriageDossier(failedBuild, [
      {
        uuid: 'web-build-1',
        status: 'deploy_failed',
        statusMessage: 'Pods failed to become ready',
        deployable: { name: 'web' },
      },
    ]);

    expect(dossier).toContain('- no pods found for this deploy');
    expect(mockKubeConfig).toHaveBeenCalledTimes(1);
    expect(mockLoadFromDefault).toHaveBeenCalledTimes(1);
    expect(mockMakeApiClient).toHaveBeenCalledTimes(1);
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

  it('bounds a stalled Kubernetes diagnostic read by the dossier timebox', async () => {
    jest.useFakeTimers();
    try {
      const coreApi = fakeCoreApi({
        listNamespacedPod: jest.fn(() => new Promise(() => undefined)),
      });
      const pending = buildTriageDossier(
        failedBuild,
        [
          {
            uuid: 'web-build-1',
            status: 'deploy_failed',
            statusMessage: 'Pods failed to become ready',
            deployable: { name: 'web' },
          },
        ],
        { coreApi }
      );

      await Promise.resolve();
      jest.advanceTimersByTime(4_000);

      await expect(pending).resolves.toContain('- k8s evidence unavailable: diagnostic read timed out');
    } finally {
      jest.useRealTimers();
    }
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

  it('uses a generic blocker when the build failed before any deploy failed', async () => {
    const dossier = await buildTriageDossier(
      { uuid: 'build-1', status: 'error', statusMessage: 'orchestration stopped' },
      [{ status: 'queued', deployable: { name: 'worker' } }]
    );

    expect(dossier).toContain(
      '## worker — phase=blocked status=queued\n- blocked: waiting on failed deploy an earlier deploy'
    );
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

  it('enforces the total size cap when rendering pre-collected evidence', () => {
    const rendered = renderTriageEvidence({
      buildStatus: 'build_failed',
      failingServices: Array.from({ length: 5 }, (_, index) => ({
        name: `service-${index}`,
        phase: 'build' as const,
        status: 'build_failed',
        detailed: true,
        logTail: `${index}${'x'.repeat(3_400)}`,
      })),
      blockedServices: [],
    });

    expect(rendered.length).toBeLessThanOrEqual(12_200);
    expect(rendered).toContain('- (further evidence omitted: dossier size cap reached)');
    expect(rendered).not.toContain('## service-4');
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
