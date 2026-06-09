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
jest.mock('server/models/AgentMessage');
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

import type { AgentSessionPromptContext } from 'server/lib/agentSession/systemPrompt';
import {
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
    expect(delta.text).toContain('Rebuild started after the repair commit.');
    expect(delta.text).toContain('- next-web: image: registry.example.test/next-web:def456');
    expect(delta.text).toContain('- failure evidence: unchanged since the last state event');
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
});
