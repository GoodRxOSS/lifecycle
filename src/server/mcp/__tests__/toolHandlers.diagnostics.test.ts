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

import {
  deriveDiagnosticTarget,
  type DiagnosticCoreApi,
  type DiagnosticJobLogDependencies,
} from 'server/lib/kubernetes/diagnosticReaders';
import type { TriageEvidence } from 'server/lib/agentSession/triageDossier';
import { BuildKind, BuildStatus, DeployStatus, DeployTypes } from 'shared/constants';
import type { McpJsonObject, McpRuntimePolicy, McpToolInvocationContext } from '../contracts';
import type { McpExecutionErrorEnvelope } from '../errors';
import { McpToolRegistry } from '../registry';
import { createDiagnosticToolDefinitions, type DiagnosticToolDependencies } from '../tools/diagnostics';
import type { LoadedDiagnosticEnvironment } from '../tools/diagnostics';

const UUID = 'candidate-123456';
const ENVIRONMENT_ID = 41;
const NAMESPACE = 'env-candidate-123456';

function diagnosticEnvironment(overrides: Record<string, unknown> = {}): LoadedDiagnosticEnvironment {
  const deploys = [
    {
      uuid: 'deploy-api-uuid',
      active: true,
      status: DeployStatus.READY,
      deployable: { name: 'api', type: DeployTypes.DOCKER },
    },
    {
      uuid: 'deploy-pipe-uuid',
      active: true,
      status: DeployStatus.READY,
      deployable: { name: 'pipe', type: DeployTypes.CODEFRESH },
    },
  ];
  const build = {
    id: ENVIRONMENT_ID,
    uuid: UUID,
    kind: BuildKind.ENVIRONMENT,
    status: BuildStatus.DEPLOYED,
    deployEnabled: true,
    namespace: NAMESPACE,
    deploys,
    ...overrides,
  } as unknown as LoadedDiagnosticEnvironment['build'];
  return {
    build,
    target: deriveDiagnosticTarget({ uuid: UUID, namespace: NAMESPACE }, [
      { name: 'api', deployUuid: 'deploy-api-uuid', provider: 'kubernetes' },
      { name: 'pipe', deployUuid: 'deploy-pipe-uuid', provider: 'codefresh' },
    ]),
  };
}

function runtimePod() {
  return {
    metadata: {
      name: 'api-pod-1',
      labels: { 'app.kubernetes.io/name': 'api' },
      creationTimestamp: '2026-07-25T00:00:00.000Z',
    },
    spec: { containers: [{ name: 'app' }] },
    status: {
      phase: 'Running',
      containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }],
    },
  };
}

function coreApi(overrides: Partial<DiagnosticCoreApi> = {}): DiagnosticCoreApi {
  return {
    listNamespacedPod: jest.fn().mockResolvedValue({ body: { items: [runtimePod()] } }),
    listNamespacedEvent: jest.fn().mockResolvedValue({ body: { items: [] } }),
    readNamespacedPodLog: jest.fn().mockResolvedValue({ body: 'hello' }),
    ...overrides,
  } as DiagnosticCoreApi;
}

function harness(dependencies: DiagnosticToolDependencies) {
  const registry = new McpToolRegistry(
    createDiagnosticToolDefinitions({
      loadEnvironment: () => Promise.reject(new Error('loadEnvironment not stubbed')),
      getCoreApi: () => coreApi(),
      collectEvidence: () => Promise.reject(new Error('collectEvidence not stubbed')),
      ...dependencies,
    }),
    { increment: jest.fn(), timing: jest.fn(), gauge: jest.fn() },
    { record: jest.fn() }
  );
  const context: McpToolInvocationContext = {
    principal: {
      kind: 'user',
      authMethod: 'oauth',
      userId: 'user-1',
      actor: 'user-1',
      roles: ['user'],
      scopes: null,
      tokenId: null,
      repositoryAllowlist: null,
      repositoryAllowlistRepoIds: null,
      identity: null,
    },
    requestId: 'request-1',
    signal: new AbortController().signal,
  };
  const policy: McpRuntimePolicy = { enabled: true, allowChanges: true, sitesAvailable: true };
  return {
    call: async (name: string, input: McpJsonObject) => {
      const result = await registry.callTool(name, input, context, policy);
      if (result.isError) {
        const envelope = JSON.parse((result.content as Array<{ text: string }>)[0].text) as McpExecutionErrorEnvelope;
        return { error: envelope.error as unknown as McpJsonObject };
      }
      return { output: result.structuredContent as McpJsonObject };
    },
  };
}

describe('get_logs', () => {
  it('reads and scrubs a runtime tail from the newest service pod', async () => {
    const api = coreApi({
      readNamespacedPodLog: jest.fn().mockResolvedValue({ body: 'starting\nAPI_TOKEN=supersecret123\ndone\n' }),
    });
    const { call } = harness({
      loadEnvironment: async () => diagnosticEnvironment(),
      getCoreApi: () => api,
    });
    const { output } = await call('get_logs', {
      uuid: UUID,
      service: 'api',
      source: { kind: 'runtime' },
      retrieval: { mode: 'tail' },
    });
    expect(output).toMatchObject({
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      service: 'api',
      source: { kind: 'runtime', podName: 'api-pod-1', container: 'app' },
      logSource: 'live',
      untrusted: true,
      lines: { mode: 'tail', totalLines: 3 },
    });
    const lines = output!.lines as McpJsonObject;
    expect(String(lines.content)).toContain('API_TOKEN=[redacted]');
    expect(String(lines.content)).not.toContain('supersecret123');
  });

  it('renders case-insensitive literal search matches with context lines', async () => {
    const api = coreApi({
      readNamespacedPodLog: jest.fn().mockResolvedValue({
        body: 'line one\nline two\nERROR: boom\nline four\nline five\n',
      }),
    });
    const { call } = harness({
      loadEnvironment: async () => diagnosticEnvironment(),
      getCoreApi: () => api,
    });
    const { output } = await call('get_logs', {
      uuid: UUID,
      service: 'api',
      source: { kind: 'runtime' },
      retrieval: { mode: 'search', text: 'error: boom', contextLines: 1 },
    });
    const lines = output!.lines as McpJsonObject;
    expect(lines).toMatchObject({ mode: 'search', matchCount: 1, totalLines: 5, truncated: false });
    expect(String(lines.content)).toContain('ERROR: boom');
    expect(String(lines.content)).toContain('line two');
    expect(String(lines.content)).toContain('line four');
    expect(String(lines.content)).not.toContain('line five');
  });

  it('renders a numbered line window bounded to the requested range', async () => {
    const api = coreApi({
      readNamespacedPodLog: jest.fn().mockResolvedValue({ body: 'alpha\nbeta\ngamma\ndelta\n' }),
    });
    const { call } = harness({
      loadEnvironment: async () => diagnosticEnvironment(),
      getCoreApi: () => api,
    });
    const { output } = await call('get_logs', {
      uuid: UUID,
      service: 'api',
      source: { kind: 'runtime' },
      retrieval: { mode: 'window', startLine: 2, maxLines: 2 },
    });
    const lines = output!.lines as McpJsonObject;
    expect(lines).toMatchObject({ mode: 'window', startLine: 2, endLine: 3, totalLines: 4, truncated: false });
    expect(String(lines.content)).toBe('2: beta\n3: gamma');
  });

  it('refuses a previous-instance read when the container never restarted', async () => {
    const { call } = harness({ loadEnvironment: async () => diagnosticEnvironment() });
    const { error } = await call('get_logs', {
      uuid: UUID,
      service: 'api',
      source: { kind: 'runtime', previous: true },
      retrieval: { mode: 'tail' },
    });
    expect(error).toMatchObject({ code: 'logs_not_found' });
  });

  it('rejects log sources for Codefresh services', async () => {
    const { call } = harness({ loadEnvironment: async () => diagnosticEnvironment() });
    const { error } = await call('get_logs', {
      uuid: UUID,
      service: 'pipe',
      source: { kind: 'runtime' },
      retrieval: { mode: 'tail' },
    });
    expect(error).toMatchObject({ code: 'unsupported_log_source' });
  });

  it('names the valid services when the service is unknown', async () => {
    const { call } = harness({ loadEnvironment: async () => diagnosticEnvironment() });
    const { error } = await call('get_logs', {
      uuid: UUID,
      service: 'ghost',
      source: { kind: 'runtime' },
      retrieval: { mode: 'tail' },
    });
    expect(error).toMatchObject({
      code: 'service_not_found',
      details: { validServices: ['api', 'pipe'] },
    });
  });

  function jobLogDependencies(overrides: Partial<DiagnosticJobLogDependencies>): DiagnosticJobLogDependencies {
    return {
      listJobs: async () => [{ jobName: 'build-job-1', status: 'Complete', podName: 'pod-b' }],
      readLiveLog: async () => 'live build output',
      readArchivedLog: async () => null,
      ...overrides,
    };
  }

  it('serves a build job log from the live pod', async () => {
    const { call } = harness({
      loadEnvironment: async () => diagnosticEnvironment(),
      getJobLogDependencies: () => jobLogDependencies({}),
    });
    const { output } = await call('get_logs', {
      uuid: UUID,
      service: 'api',
      source: { kind: 'build' },
      retrieval: { mode: 'tail' },
    });
    expect(output).toMatchObject({
      source: { kind: 'build', jobName: 'build-job-1', jobStatus: 'Complete' },
      logSource: 'live',
    });
  });

  it('reports an unknown job name with the available jobs', async () => {
    const { call } = harness({
      loadEnvironment: async () => diagnosticEnvironment(),
      getJobLogDependencies: () => jobLogDependencies({}),
    });
    const { error } = await call('get_logs', {
      uuid: UUID,
      service: 'api',
      source: { kind: 'build', jobName: 'missing-job' },
      retrieval: { mode: 'tail' },
    });
    expect(error).toMatchObject({
      code: 'job_not_found',
      details: { availableJobs: ['build-job-1'] },
    });
  });

  it('falls back to the archive when the live pod is gone', async () => {
    const { call } = harness({
      loadEnvironment: async () => diagnosticEnvironment(),
      getJobLogDependencies: () =>
        jobLogDependencies({
          readLiveLog: async () => null,
          readArchivedLog: async () => ({ logs: 'archived output', truncated: false }),
        }),
    });
    const { output } = await call('get_logs', {
      uuid: UUID,
      service: 'api',
      source: { kind: 'deploy' },
      retrieval: { mode: 'tail' },
    });
    expect(output).toMatchObject({ logSource: 'archived' });
    expect(String((output!.lines as McpJsonObject).content)).toBe('archived output');
  });

  it('reports missing logs when neither live nor archived output exists', async () => {
    const { call } = harness({
      loadEnvironment: async () => diagnosticEnvironment(),
      getJobLogDependencies: () => jobLogDependencies({ readLiveLog: async () => null }),
    });
    const { error } = await call('get_logs', {
      uuid: UUID,
      service: 'api',
      source: { kind: 'build' },
      retrieval: { mode: 'tail' },
    });
    expect(error).toMatchObject({ code: 'logs_not_found' });
  });
});

describe('diagnose_environment', () => {
  it('summarizes failing services with redacted, untrusted evidence and follow-up calls', async () => {
    const evidence: TriageEvidence = {
      buildStatus: 'error',
      failingServices: [
        {
          name: 'api',
          phase: 'runtime',
          status: 'error',
          statusMessage: 'Pod crash detected',
          detailed: true,
          runtime: {
            stateNote: 'CrashLoopBackOff',
            podSummaries: ['api-pod-1 restarts=5'],
            omittedFailingPods: 0,
            warningEvents: ['Back-off restarting failed container'],
            previousLog: { podName: 'api-pod-1', content: 'boom API_TOKEN=supersecret123' },
          },
          logTail: 'ignored when a previous log exists',
        },
      ],
      blockedServices: [{ name: 'pipe', blocker: 'api' }],
    };
    const { call } = harness({
      loadEnvironment: async () => diagnosticEnvironment({ status: BuildStatus.ERROR }),
      collectEvidence: async () => evidence,
    });
    const { output } = await call('diagnose_environment', { uuid: UUID });
    expect(output).toMatchObject({
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      phase: 'failed',
      verdict: '2 of 2 services failing',
      config: { status: 'valid' },
      healthyServices: [],
    });
    const failing = output!.failingServices as McpJsonObject[];
    expect(failing[0]).toMatchObject({
      name: 'api',
      failurePhase: 'runtime',
      evidence: {
        untrusted: true,
        warningEvents: ['Back-off restarting failed container'],
      },
      suggested: [
        {
          tool: 'get_logs',
          args: {
            uuid: UUID,
            service: 'api',
            source: { kind: 'runtime', previous: true },
            retrieval: { mode: 'tail', tailLines: 200 },
          },
        },
      ],
    });
    expect(String((failing[0].evidence as McpJsonObject).logTail)).toContain('API_TOKEN=[redacted]');
    expect(failing[1]).toMatchObject({ name: 'pipe', failurePhase: 'blocked' });
  });

  it('reports invalid configuration as the verdict when no service evidence exists', async () => {
    const evidence: TriageEvidence = {
      buildStatus: 'config_error',
      config: { status: 'config_error', statusMessage: 'services[0].name is required' },
      failingServices: [],
      blockedServices: [],
    };
    const { call } = harness({
      loadEnvironment: async () => diagnosticEnvironment({ status: BuildStatus.CONFIG_ERROR }),
      collectEvidence: async () => evidence,
    });
    const { output } = await call('diagnose_environment', { uuid: UUID });
    expect(output).toMatchObject({
      verdict: 'Lifecycle configuration is invalid',
      config: { status: 'invalid', message: 'services[0].name is required' },
    });
  });

  it('reports a generic build error as an orchestration failure with an unknown config state', async () => {
    const evidence: TriageEvidence = {
      buildStatus: 'error',
      failingServices: [],
      blockedServices: [],
      fallback: { phase: 'orchestration', statusMessage: 'worker orchestration timed out' },
    };
    const { call } = harness({
      loadEnvironment: async () =>
        diagnosticEnvironment({ status: BuildStatus.ERROR, statusMessage: 'worker orchestration timed out' }),
      collectEvidence: async () => evidence,
    });

    const { output } = await call('diagnose_environment', { uuid: UUID });

    expect(output).toMatchObject({
      phase: 'failed',
      verdict: 'Environment orchestration failed: worker orchestration timed out',
      config: { status: 'unknown' },
      failingServices: [],
      healthyServices: [],
    });
    expect(String(output!.verdict)).not.toContain('configuration');
  });

  it('does not claim unassessed services are healthy outside a terminal failure', async () => {
    const { call } = harness({
      loadEnvironment: async () => diagnosticEnvironment({ status: BuildStatus.DEPLOYING }),
      collectEvidence: async () => null,
    });

    const { output } = await call('diagnose_environment', { uuid: UUID });

    expect(output).toMatchObject({
      phase: 'in_progress',
      verdict: 'No terminal failure evidence detected',
      config: { status: 'unknown' },
      healthyServices: [],
    });
    expect((output!.notes as string[]).join(' ')).toContain('get_kubernetes_state');
  });
});

describe('get_kubernetes_state', () => {
  it('returns namespace events as untrusted data', async () => {
    const api = coreApi({
      listNamespacedEvent: jest.fn().mockResolvedValue({
        body: {
          items: [
            {
              type: 'Warning',
              reason: 'FailedScheduling',
              message: '0/3 nodes are available',
              count: 2,
              involvedObject: { kind: 'Pod', name: 'api-pod-1' },
              lastTimestamp: '2026-07-25T00:00:00.000Z',
            },
          ],
        },
      }),
    });
    const { call } = harness({
      loadEnvironment: async () => diagnosticEnvironment(),
      getCoreApi: () => api,
    });
    const { output } = await call('get_kubernetes_state', { uuid: UUID, view: 'events' });
    expect(output).toMatchObject({
      uuid: UUID,
      environmentId: ENVIRONMENT_ID,
      untrusted: true,
      result: {
        view: 'events',
        truncated: false,
        events: [
          {
            type: 'Warning',
            reason: 'FailedScheduling',
            object: 'Pod/api-pod-1',
            message: '0/3 nodes are available',
            count: 2,
            lastSeen: '2026-07-25T00:00:00.000Z',
          },
        ],
      },
    });
  });

  it('returns pod state for the environment', async () => {
    const { call } = harness({ loadEnvironment: async () => diagnosticEnvironment() });
    const { output } = await call('get_kubernetes_state', { uuid: UUID, view: 'pods' });
    const result = output!.result as McpJsonObject;
    const pods = result.pods as McpJsonObject[];
    expect(result.view).toBe('pods');
    expect(result.truncated).toBe(false);
    expect(pods[0]).toMatchObject({
      name: 'api-pod-1',
      service: 'api',
      containers: [{ name: 'app', state: 'running', restarts: 0 }],
    });
  });

  it('refuses Kubernetes state for Codefresh services', async () => {
    const { call } = harness({ loadEnvironment: async () => diagnosticEnvironment() });
    const { error } = await call('get_kubernetes_state', { uuid: UUID, view: 'pods', service: 'pipe' });
    expect(error).toMatchObject({ code: 'upstream_unavailable' });
  });
});
