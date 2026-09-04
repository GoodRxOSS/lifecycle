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

jest.mock('server/models/AgentSession');
jest.mock('server/models/AgentMessage', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));
jest.mock('server/models/Build');
jest.mock('server/models/Deploy');
jest.mock('server/models/yaml', () => ({
  fetchLifecycleConfig: jest.fn(),
  getDeployingServicesByName: jest.fn(),
}));
jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: { getInstance: jest.fn(() => ({ getLabels: jest.fn().mockResolvedValue({}) })) },
}));
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() })),
}));
jest.mock('../MessageStore', () => ({
  __esModule: true,
  ENVIRONMENT_STATE_METADATA_KIND: 'environment_state',
  default: { upsertCanonicalUiMessagesForThread: jest.fn() },
}));

const mockResolveAgentSessionPromptContext = jest.fn();
const mockResolveAgentSessionTriage = jest.fn();

jest.mock('server/lib/agentSession/systemPrompt', () => {
  const actual = jest.requireActual('server/lib/agentSession/systemPrompt');
  return {
    ...actual,
    resolveAgentSessionPromptContext: (...args: unknown[]) => mockResolveAgentSessionPromptContext(...args),
    resolveAgentSessionTriage: (...args: unknown[]) => mockResolveAgentSessionTriage(...args),
  };
});

import type AgentSession from 'server/models/AgentSession';
import AgentMessage from 'server/models/AgentMessage';
import type { AgentSessionPromptContext } from 'server/lib/agentSession/systemPrompt';
import AgentMessageStore from '../MessageStore';
import EnvironmentStateService, {
  buildDependencyChainLines,
  buildEnvironmentFingerprint,
  buildFailureSignature,
  deterministicEventUuid,
  renderEnvironmentStateBlock,
  renderEnvironmentStateDelta,
} from '../EnvironmentStateService';

const ASOF = '2026-04-30T12:00:00.000Z';
const PREV_ASOF = '2026-04-30T11:00:00.000Z';

function buildContext(overrides: Partial<AgentSessionPromptContext> = {}): AgentSessionPromptContext {
  return {
    namespace: null,
    buildUuid: 'sample-build-1',
    build: {
      uuid: 'sample-build-1',
      status: 'deploy_failed',
      statusMessage: 'web deploy failed',
      namespace: 'env-sample-123456',
      sha: 'abc123',
    },
    pullRequest: {
      fullName: 'example-org/example-repo',
      branchName: 'feature/sample',
      pullRequestNumber: 42,
      url: 'https://github.com/example-org/example-repo/pull/42',
      status: 'open',
      labels: ['lifecycle-deploy'],
      deployOnUpdate: true,
      latestCommit: 'abc123',
    },
    services: [],
    diagnosticServices: [
      {
        name: 'next-web',
        deployUuid: 'next-web-deploy-1',
        active: true,
        status: 'deploy_failed',
        statusMessage: 'CrashLoopBackOff',
        publicUrl: 'https://next-web-sample.lifecycle.dev.example.com',
        repo: 'example-org/example-repo',
        branch: 'feature/sample',
        dockerImage: 'registry.example.test/next-web:abc123',
        buildPipelineId: 'build-pipeline-1',
        deployPipelineId: 'deploy-pipeline-1',
      },
    ],
    ...overrides,
  };
}

function findOneQuery(result: unknown) {
  return { findOne: jest.fn().mockResolvedValue(result) };
}

function latestStateQuery(result: unknown) {
  const builder = {
    where: jest.fn(),
    whereRaw: jest.fn(),
    orderBy: jest.fn(),
    first: jest.fn().mockResolvedValue(result),
  };
  builder.where.mockReturnValue(builder);
  builder.whereRaw.mockReturnValue(builder);
  builder.orderBy.mockReturnValue(builder);
  return builder;
}

function prepareMessageQueries({
  existingEvent = null,
  latestEvent = null,
  insertRace = null,
}: {
  existingEvent?: unknown;
  latestEvent?: unknown;
  insertRace?: unknown;
} = {}) {
  const query = AgentMessage.query as jest.Mock;
  query.mockReset();
  query.mockReturnValueOnce(findOneQuery(existingEvent));
  if (!existingEvent) {
    query.mockReturnValueOnce(latestStateQuery(latestEvent));
    query.mockReturnValueOnce(findOneQuery(insertRace));
  }
}

describe('renderEnvironmentStateBlock', () => {
  it('renders a timestamped, trigger-attributed block with current-state labels', () => {
    const block = renderEnvironmentStateBlock(
      buildContext({ triage: '## next-web — phase=deploy status=deploy_failed' }),
      {
        asOf: ASOF,
        trigger: 'run_start',
      }
    );

    expect(block).toContain(`Environment state — as of ${ASOF} (run start)`);
    // Falls back to build.namespace so build-context chats still emit the namespace line.
    expect(block).toContain('- namespace: env-sample-123456');
    expect(block).toContain(
      '- build=sample-build-1: status=deploy_failed, statusMessage=web deploy failed, namespace=env-sample-123456, sha=abc123'
    );
    expect(block).toContain('Pull request:');
    expect(block).toContain('latestCommit=abc123');
    expect(block).toContain('DEPLOYS — roster:');
    expect(block).toContain(
      '- next-web: deployUuid=next-web-deploy-1, active=true, status=deploy_failed, statusMessage=CrashLoopBackOff'
    );
    expect(block).toContain('Triage evidence (collected automatically):');
    // Volatile observedAt/source lines and *AtStart labels are gone.
    expect(block).not.toContain('observedAt');
    expect(block).not.toContain('AtStart');
    expect(block).not.toContain('Initial Lifecycle snapshot');
  });

  it('caps healthy roster services and points at query_database for the rest', () => {
    const healthy = Array.from({ length: 7 }, (_, index) => ({
      name: `svc-${index}`,
      status: 'deployed',
    }));
    const block = renderEnvironmentStateBlock(
      buildContext({
        diagnosticServices: [{ name: 'broken', status: 'build_failed', statusMessage: 'boom' }, ...healthy],
      }),
      { asOf: ASOF, trigger: 'run_start' }
    );

    expect(block).toContain('- broken:');
    expect(block).toContain('- svc-4:');
    expect(block).not.toContain('- svc-5:');
    expect(block).toContain('(+2 more services with status=deployed — use query_database for the full list)');
  });

  it('renders the selected deploy with full detail once', () => {
    const selected = {
      name: 'sample-service',
      deployUuid: 'deploy-1',
      active: false,
      status: 'build_failed',
      statusMessage: 'Dockerfile not found',
      serviceSha: 'service-sha-1',
      dockerfilePath: 'services/sample/Dockerfile',
      deployableType: 'docker',
    };
    const block = renderEnvironmentStateBlock(
      buildContext({ diagnosticServices: [], services: [selected], selectedDeploy: selected }),
      { asOf: ASOF, trigger: 'run_start' }
    );

    expect(block).toContain('DEPLOYS — selected:');
    expect(block).toContain(
      '- sample-service: deployUuid=deploy-1, active=false, status=build_failed, statusMessage=Dockerfile not found, serviceSha=service-sha-1, dockerfilePath=services/sample/Dockerfile, type=docker'
    );
    expect(block.match(/deployUuid=deploy-1/g)).toHaveLength(1);
    expect(block).not.toContain('Selected services:');
  });

  it('renders lifecycle config and alphabetized explicitly selected services under a caller headline', () => {
    const block = renderEnvironmentStateBlock(
      buildContext({
        namespace: 'explicit-namespace',
        build: undefined,
        pullRequest: undefined,
        lifecycleConfig: {
          status: 'loaded',
          path: '.lifecycle.yml',
          declaredServices: ['api', 'web'],
        } as any,
        services: [
          { name: 'web', status: 'deployed' },
          { name: 'api', status: 'building' },
        ],
        diagnosticServices: undefined,
        userSelectedServices: true,
      }),
      { asOf: ASOF, trigger: 'rebuild_watch', headline: 'Repair commit observed.' }
    );

    expect(block).toContain(`Environment state — as of ${ASOF} (rebuild watch)`);
    expect(block).toContain('Repair commit observed.');
    expect(block).toContain('- lifecycleConfig: loaded (.lifecycle.yml)');
    expect(block).toContain('- declaredServices: api, web');
    expect(block.indexOf('- api:')).toBeLessThan(block.indexOf('- web:'));
    expect(block).toContain('Selected services:');
  });
});

describe('renderEnvironmentStateDelta', () => {
  it('reports transitions, keeps unchanged services to one line, and includes fresh triage on a new failure', () => {
    const previous = {
      fingerprint: buildEnvironmentFingerprint(
        buildContext({
          build: { uuid: 'sample-build-1', status: 'building', statusMessage: undefined, sha: 'abc123' },
          diagnosticServices: [
            { name: 'next-web', status: 'building' },
            { name: 'api', status: 'deployed' },
          ],
        })
      ),
      occurredAt: PREV_ASOF,
    };
    const context = buildContext({
      triage: '## next-web — phase=deploy status=deploy_failed',
      diagnosticServices: [
        { name: 'next-web', status: 'deploy_failed', statusMessage: 'CrashLoopBackOff' },
        { name: 'api', status: 'deployed' },
      ],
    });
    const delta = renderEnvironmentStateDelta(
      previous,
      { fingerprint: buildEnvironmentFingerprint(context), context },
      { asOf: ASOF, trigger: 'run_start' }
    );

    expect(delta.changed).toBe(true);
    expect(delta.failureSignatureChanged).toBe(true);
    expect(delta.summary).toBe('build: building → deploy_failed (+1 more)');
    expect(delta.text).toContain(`Changed since ${PREV_ASOF}:`);
    expect(delta.text).toContain('- build: building → deploy_failed');
    expect(delta.text).toContain('- next-web: building → deploy_failed');
    expect(delta.text).toContain('- unchanged: api');
    expect(delta.text).toContain('Triage evidence (collected automatically):');
  });

  it('collapses an unchanged environment into a one-line confirmation', () => {
    const context = buildContext();
    const fingerprint = buildEnvironmentFingerprint(context);
    const delta = renderEnvironmentStateDelta(
      { fingerprint, occurredAt: PREV_ASOF },
      { fingerprint, context },
      { asOf: ASOF, trigger: 'run_start' }
    );

    expect(delta.changed).toBe(false);
    expect(delta.summary).toBe('no changes');
    expect(delta.text).toBe(`Environment state — as of ${ASOF} (run start): no changes since ${PREV_ASOF}.`);
  });

  it('notes unchanged failure evidence instead of re-collecting when the failure signature is stable', () => {
    const previousContext = buildContext();
    const nextContext = buildContext({
      // Same failure, new image tag: the failure signature must not change.
      diagnosticServices: previousContext.diagnosticServices!.map((service) => ({
        ...service,
        dockerImage: 'registry.example.test/next-web:def456',
      })),
    });
    const delta = renderEnvironmentStateDelta(
      { fingerprint: buildEnvironmentFingerprint(previousContext), occurredAt: PREV_ASOF },
      { fingerprint: buildEnvironmentFingerprint(nextContext), context: nextContext },
      { asOf: ASOF, trigger: 'rebuild_watch', headline: 'Rebuild started after the repair commit.' }
    );

    expect(delta.failureSignatureChanged).toBe(false);
    expect(delta.summary).toBe('next-web: image: registry.example.test/next-web:def456');
    expect(delta.text).toContain('Rebuild started after the repair commit.');
    expect(delta.text).toContain('- next-web: image: registry.example.test/next-web:def456');
    expect(delta.text).toContain('- failure evidence: unchanged since the last state event');
  });

  it('reports metadata-only build and roster changes, bounds unchanged names, and calls out missing fresh evidence', () => {
    const unchanged = Array.from({ length: 10 }, (_, index) => ({ name: `stable-${index}`, status: 'deployed' }));
    const previous = {
      fingerprint: {
        build: { status: 'deploying', statusMessage: 'old message', sha: 'old-sha' },
        pr: { latestCommit: 'old-commit' },
        deploys: [
          { name: 'changing', active: true, status: 'deploy_failed', statusMessage: 'old failure', dockerImage: 'old' },
          { name: 'removed', status: 'deployed' },
          ...unchanged,
        ],
      },
      occurredAt: PREV_ASOF,
    };
    const nextFingerprint = {
      build: { status: 'deploying', statusMessage: 'new message', sha: 'new-sha' },
      pr: { latestCommit: 'new-commit' },
      deploys: [
        {
          name: 'changing',
          active: false,
          status: 'deploy_failed',
          statusMessage: 'new failure',
          dockerImage: 'new',
        },
        { name: 'added' },
        ...unchanged,
      ],
    };
    const context = buildContext({
      triage: undefined,
      diagnosticServices: nextFingerprint.deploys,
    });
    const delta = renderEnvironmentStateDelta(
      previous,
      { fingerprint: nextFingerprint, context },
      { asOf: ASOF, trigger: 'rebuild_watch' }
    );

    expect(delta.failureSignatureChanged).toBe(true);
    expect(delta.text).toContain('- build statusMessage: new message');
    expect(delta.text).toContain('- build sha: old-sha → new-sha');
    expect(delta.text).toContain('- pull request: new commit new-commit (was old-commit)');
    expect(delta.text).toContain('- added: added (status=<unknown>)');
    expect(delta.text).toContain('- changing: statusMessage: new failure, image: new, active=false');
    expect(delta.text).toContain('- removed: removed from roster');
    expect(delta.text).toContain(
      '- unchanged: stable-0, stable-1, stable-2, stable-3, stable-4, stable-5, stable-6, stable-7, +2 more'
    );
    expect(delta.text).toContain('- failure evidence: not collected — call get_environment_status for fresh evidence');
  });
});

describe('buildDependencyChainLines', () => {
  it('names everything a failed service transitively blocks', () => {
    const lines = buildDependencyChainLines([
      { name: 'db', status: 'deploy_failed' },
      { name: 'api', status: 'queued', dependsOn: ['db'] },
      { name: 'web', status: 'queued', dependsOn: ['api'] },
      { name: 'docs', status: 'deployed' },
    ]);

    expect(lines).toEqual(['Dependency chains:', '- db (deploy_failed) blocks: api, web']);
  });

  it('stays silent when nothing failed or no edges exist', () => {
    expect(
      buildDependencyChainLines([
        { name: 'db', status: 'deployed' },
        { name: 'api', status: 'deployed', dependsOn: ['db'] },
      ])
    ).toEqual([]);
    expect(buildDependencyChainLines([{ name: 'db', status: 'deploy_failed' }])).toEqual([]);
  });

  it('renders dependency edges and chains in the state block for non-healthy services', () => {
    const block = renderEnvironmentStateBlock(
      buildContext({
        diagnosticServices: [
          { name: 'db', status: 'deploy_failed', statusMessage: 'CrashLoopBackOff' },
          { name: 'api', status: 'queued', dependsOn: ['db'] },
          { name: 'docs', status: 'deployed', dependsOn: ['api'] },
        ],
      }),
      { asOf: ASOF, trigger: 'run_start' }
    );

    expect(block).toContain('- api: status=queued, statusMessage=<none>, dependsOn=db');
    // Healthy roster lines stay lean — no edges.
    expect(block).toContain('- docs: status=deployed');
    expect(block).not.toContain('- docs: status=deployed, statusMessage=<none>, dependsOn=api');
    expect(block).toContain('Dependency chains:');
    expect(block).toContain('- db (deploy_failed) blocks: api, docs');
  });
});

describe('fingerprints and event ids', () => {
  it('ignores evidence-neutral fields in the failure signature', () => {
    const base = buildEnvironmentFingerprint(buildContext());
    const differentImage = buildEnvironmentFingerprint(
      buildContext({
        build: { uuid: 'sample-build-1', status: 'deploy_failed', statusMessage: 'web deploy failed', sha: 'zzz999' },
        diagnosticServices: [
          {
            name: 'next-web',
            status: 'deploy_failed',
            statusMessage: 'CrashLoopBackOff',
            dockerImage: 'registry.example.test/next-web:zzz999',
          },
        ],
      })
    );

    expect(buildFailureSignature(base)).toBe(buildFailureSignature(differentImage));
  });

  it('derives stable, uuid-shaped event ids from seeds', () => {
    const first = deterministicEventUuid('run:run-123');
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicEventUuid('run:run-123')).toBe(first);
    expect(deterministicEventUuid('run:run-124')).not.toBe(first);
  });

  it('uses selected-service fallbacks, compacts long messages, and excludes inactive failures from signatures', () => {
    const longMessage = `  ${'failure '.repeat(40)}  `;
    const fingerprint = buildEnvironmentFingerprint(
      buildContext({
        build: { uuid: 'build-1', status: 'error', statusMessage: longMessage },
        diagnosticServices: [],
        services: [
          { name: 'zeta', active: false, status: 'deploy_failed', statusMessage: longMessage },
          { name: 'alpha', active: true, status: 'deployed' },
        ],
        pullRequest: undefined,
      })
    );

    expect(fingerprint.deploys.map((deploy) => deploy.name)).toEqual(['alpha', 'zeta']);
    expect(fingerprint.build?.statusMessage).toHaveLength(201);
    expect(fingerprint.build?.statusMessage?.endsWith('…')).toBe(true);
    expect(fingerprint).not.toHaveProperty('pr');
    expect(JSON.parse(buildFailureSignature(fingerprint)).deploys).toEqual([{ name: 'alpha', status: 'deployed' }]);
  });
});

describe('ensureRunStartStateEvent gating', () => {
  const upsert = AgentMessageStore.upsertCanonicalUiMessagesForThread as jest.Mock;

  beforeEach(() => {
    upsert.mockClear();
  });

  it('does not emit for a freeform chat session (workspace namespace, no build)', async () => {
    await EnvironmentStateService.ensureRunStartStateEvent({
      session: { id: 1, namespace: 'chat-827ef316', buildUuid: null } as unknown as AgentSession,
      thread: { id: 10 },
      runUuid: 'run-1',
    });

    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not emit on an approval-resume dispatch', async () => {
    await EnvironmentStateService.ensureRunStartStateEvent({
      session: { id: 1, namespace: 'env-sample', buildUuid: 'build-1' } as unknown as AgentSession,
      thread: { id: 10 },
      runUuid: 'run-1',
      dispatchReason: 'approval_resolved',
    });

    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('persisted environment-state events', () => {
  const query = AgentMessage.query as jest.Mock;
  const upsert = AgentMessageStore.upsertCanonicalUiMessagesForThread as jest.Mock;
  const session = {
    id: 7,
    namespace: 'env-sample-123456',
    buildUuid: 'sample-build-1',
  } as unknown as AgentSession;

  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date(ASOF));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    query.mockReset();
    upsert.mockReset();
    upsert.mockResolvedValue(undefined);
    mockResolveAgentSessionPromptContext.mockReset();
    mockResolveAgentSessionTriage.mockReset();
  });

  it('persists the first run snapshot with fresh triage and run attribution', async () => {
    prepareMessageQueries();
    mockResolveAgentSessionPromptContext.mockResolvedValue(buildContext());
    mockResolveAgentSessionTriage.mockResolvedValue('fresh deploy evidence');

    await EnvironmentStateService.ensureRunStartStateEvent({
      session,
      thread: { id: 41 },
      runUuid: 'run-first',
      runId: 91,
    });

    expect(mockResolveAgentSessionPromptContext).toHaveBeenCalledWith({
      sessionDbId: 7,
      namespace: 'env-sample-123456',
      buildUuid: 'sample-build-1',
      includeTriage: false,
    });
    expect(mockResolveAgentSessionTriage).toHaveBeenCalledWith('sample-build-1');
    expect(upsert).toHaveBeenCalledTimes(1);
    const [thread, messages, options] = upsert.mock.calls[0];
    expect(thread).toEqual({ id: 41 });
    expect(options).toEqual({ runId: 91 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: deterministicEventUuid('run:run-first'),
      role: 'system',
      metadata: {
        kind: 'environment_state',
        trigger: 'run_start',
        occurredAt: ASOF,
        summary: 'initial snapshot',
        buildUuid: 'sample-build-1',
        runUuid: 'run-first',
      },
    });
    expect(JSON.parse(messages[0].metadata.fingerprint)).toEqual(buildEnvironmentFingerprint(buildContext()));
    expect(messages[0].parts[0].text).toContain('fresh deploy evidence');
  });

  it('skips context collection when the deterministic run event already exists', async () => {
    prepareMessageQueries({ existingEvent: { id: 1 } });

    await EnvironmentStateService.ensureRunStartStateEvent({
      session,
      thread: { id: 41 },
      runUuid: 'run-existing',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(mockResolveAgentSessionPromptContext).not.toHaveBeenCalled();
    expect(mockResolveAgentSessionTriage).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('emits a no-change run event without re-querying live triage for the same failure', async () => {
    const context = buildContext();
    prepareMessageQueries({
      latestEvent: {
        metadata: {
          fingerprint: JSON.stringify(buildEnvironmentFingerprint(context)),
          occurredAt: PREV_ASOF,
        },
      },
    });
    mockResolveAgentSessionPromptContext.mockResolvedValue(context);

    await EnvironmentStateService.ensureRunStartStateEvent({
      session,
      thread: { id: 41 },
      runUuid: 'run-unchanged',
    });

    expect(mockResolveAgentSessionTriage).not.toHaveBeenCalled();
    const message = upsert.mock.calls[0][1][0];
    expect(message.metadata.summary).toBe('no changes');
    expect(message.parts[0].text).toBe(`Environment state — as of ${ASOF} (run start): no changes since ${PREV_ASOF}.`);
    expect(upsert.mock.calls[0][2]).toEqual({ runId: null });
  });

  it('does not overwrite an event inserted concurrently after context collection', async () => {
    prepareMessageQueries({ insertRace: { id: 99 } });
    mockResolveAgentSessionPromptContext.mockResolvedValue(buildContext());
    mockResolveAgentSessionTriage.mockResolvedValue(null);

    await EnvironmentStateService.ensureRunStartStateEvent({
      session,
      thread: { id: 41 },
      runUuid: 'run-race',
    });

    expect(mockResolveAgentSessionPromptContext).toHaveBeenCalledTimes(1);
    expect(mockResolveAgentSessionTriage).toHaveBeenCalledTimes(1);
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{not-json', ASOF],
    ['a non-fingerprint JSON value', JSON.stringify({ deploys: 'not-an-array' }), ASOF],
    ['a missing timestamp', JSON.stringify({ deploys: [] }), undefined],
    ['an empty fingerprint', '', ASOF],
  ])('treats persisted metadata with %s as no usable previous snapshot', async (_label, fingerprint, occurredAt) => {
    prepareMessageQueries({ latestEvent: { metadata: { fingerprint, occurredAt } } });
    mockResolveAgentSessionPromptContext.mockResolvedValue(buildContext());

    await EnvironmentStateService.postWatchStateEvent({
      session,
      thread: { id: 41 },
      uuidSeed: `invalid-${_label}`,
      headline: 'Watch observed activity.',
      includeTriage: false,
    });

    const message = upsert.mock.calls[0][1][0];
    expect(message.metadata.summary).toBe('Watch observed activity.');
    expect(message.parts[0].text).toContain('DEPLOYS — roster:');
  });

  it('persists an unavailable marker when run context lookup fails', async () => {
    prepareMessageQueries();
    mockResolveAgentSessionPromptContext.mockRejectedValue(new Error('database unavailable'));

    await expect(
      EnvironmentStateService.ensureRunStartStateEvent({
        session,
        thread: { id: 41 },
        runUuid: 'run-unavailable',
      })
    ).resolves.toBeUndefined();

    const message = upsert.mock.calls[0][1][0];
    expect(message).toMatchObject({
      id: deterministicEventUuid('run:run-unavailable'),
      metadata: {
        summary: 'state unavailable',
        fingerprint: '',
        buildUuid: 'sample-build-1',
        runUuid: 'run-unavailable',
      },
    });
    expect(message.parts[0].text).toContain('UNAVAILABLE (context lookup failed)');
  });

  it('keeps the never-throws contract when even the unavailable marker cannot be inserted', async () => {
    prepareMessageQueries();
    mockResolveAgentSessionPromptContext.mockRejectedValue(new Error('database unavailable'));
    upsert.mockRejectedValue(new Error('write unavailable'));

    await expect(
      EnvironmentStateService.ensureRunStartStateEvent({
        session,
        thread: { id: 41 },
        runUuid: 'run-double-failure',
      })
    ).resolves.toBeUndefined();

    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('persists the first watch snapshot with its headline, commit, and requested triage mode', async () => {
    prepareMessageQueries();
    mockResolveAgentSessionPromptContext.mockResolvedValue(buildContext());

    await EnvironmentStateService.postWatchStateEvent({
      session,
      thread: { id: 41 },
      uuidSeed: 'watch-first',
      headline: 'Repair commit observed.',
      includeTriage: true,
      commitUrl: 'https://github.test/commit/abc123',
    });

    expect(mockResolveAgentSessionPromptContext).toHaveBeenCalledWith({
      sessionDbId: 7,
      namespace: 'env-sample-123456',
      buildUuid: 'sample-build-1',
      includeTriage: true,
    });
    const message = upsert.mock.calls[0][1][0];
    expect(message).toMatchObject({
      id: deterministicEventUuid('watch:watch-first'),
      metadata: {
        trigger: 'rebuild_watch',
        summary: 'Repair commit observed.',
        buildUuid: 'sample-build-1',
        commitUrl: 'https://github.test/commit/abc123',
      },
    });
    expect(message.parts[0].text).toContain('Repair commit observed.');
    expect(upsert.mock.calls[0][2]).toEqual({ runId: null });
  });

  it('summarizes a changed watch delta and omits absent optional metadata', async () => {
    const previousContext = buildContext({
      build: { uuid: 'sample-build-1', status: 'building', sha: 'old-sha' },
      diagnosticServices: [{ name: 'next-web', status: 'building' }],
    });
    prepareMessageQueries({
      latestEvent: {
        metadata: {
          fingerprint: JSON.stringify(buildEnvironmentFingerprint(previousContext)),
          occurredAt: PREV_ASOF,
        },
      },
    });
    mockResolveAgentSessionPromptContext.mockResolvedValue(buildContext());

    await EnvironmentStateService.postWatchStateEvent({
      session: { id: 7, namespace: null, buildUuid: null } as Pick<AgentSession, 'id' | 'namespace' | 'buildUuid'>,
      thread: { id: 41 },
      uuidSeed: 'watch-changed',
      headline: 'Rebuild completed.',
      includeTriage: false,
      commitUrl: null,
    });

    const message = upsert.mock.calls[0][1][0];
    expect(message.metadata.summary).toMatch(/^Rebuild completed\. \(build:/);
    expect(message.metadata).not.toHaveProperty('buildUuid');
    expect(message.metadata).not.toHaveProperty('commitUrl');
    expect(message.parts[0].text).toContain(`Changed since ${PREV_ASOF}:`);
    expect(mockResolveAgentSessionPromptContext).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: null, buildUuid: null })
    );
  });

  it('uses only the watch headline when the persisted fingerprint has not changed', async () => {
    const context = buildContext();
    prepareMessageQueries({
      latestEvent: {
        metadata: {
          fingerprint: JSON.stringify(buildEnvironmentFingerprint(context)),
          occurredAt: PREV_ASOF,
        },
      },
    });
    mockResolveAgentSessionPromptContext.mockResolvedValue(context);

    await EnvironmentStateService.postWatchStateEvent({
      session,
      thread: { id: 41 },
      uuidSeed: 'watch-unchanged',
      headline: 'Still waiting.',
      includeTriage: false,
    });

    const message = upsert.mock.calls[0][1][0];
    expect(message.metadata.summary).toBe('Still waiting.');
    expect(message.parts[0].text).toContain(`no changes since ${PREV_ASOF}.`);
    expect(message.parts[0].text).toContain('Still waiting.');
  });

  it('short-circuits duplicate watch events before context lookup', async () => {
    prepareMessageQueries({ existingEvent: { id: 2 } });

    await EnvironmentStateService.postWatchStateEvent({
      session,
      thread: { id: 41 },
      uuidSeed: 'watch-existing',
      headline: 'Duplicate.',
      includeTriage: false,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(mockResolveAgentSessionPromptContext).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('keeps watch processing non-fatal when context lookup fails', async () => {
    prepareMessageQueries();
    mockResolveAgentSessionPromptContext.mockRejectedValue(new Error('lookup failed'));

    await expect(
      EnvironmentStateService.postWatchStateEvent({
        session,
        thread: { id: 41 },
        uuidSeed: 'watch-failure',
        headline: 'Watch failed.',
        includeTriage: true,
      })
    ).resolves.toBeUndefined();

    expect(upsert).not.toHaveBeenCalled();
  });

  it('renders the current live state with normalized nullable inputs and triage enabled', async () => {
    mockResolveAgentSessionPromptContext.mockResolvedValue(buildContext());

    const rendered = await EnvironmentStateService.renderCurrentState({
      sessionDbId: 7,
      namespace: undefined,
      buildUuid: undefined,
    });

    expect(mockResolveAgentSessionPromptContext).toHaveBeenCalledWith({
      sessionDbId: 7,
      namespace: null,
      buildUuid: null,
      includeTriage: true,
    });
    expect(rendered).toContain(`Environment state — as of ${ASOF} (run start)`);
    expect(rendered).toContain('DEPLOYS — roster:');
  });
});
