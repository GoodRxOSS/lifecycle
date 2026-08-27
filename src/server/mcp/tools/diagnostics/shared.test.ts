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

const mockDeployQuery = jest.fn();
const mockCollectTriageEvidence = jest.fn();
const mockCreateJobLogDependencies = jest.fn();
const mockDeriveDiagnosticTarget = jest.fn();
const mockLoadKubeConfig = jest.fn();
const mockResolveNamedEnvironmentRead = jest.fn();
const mockIsEnvironmentBuild = jest.fn();

jest.mock('server/models/Deploy', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockDeployQuery(...args),
  },
}));

jest.mock('server/lib/agentSession/triageDossier', () => ({
  collectTriageEvidence: (...args: unknown[]) => mockCollectTriageEvidence(...args),
}));

jest.mock('server/lib/kubernetes/diagnosticReaders', () => {
  const actual = jest.requireActual('server/lib/kubernetes/diagnosticReaders');
  return {
    ...actual,
    createDiagnosticJobLogDependencies: (...args: unknown[]) => mockCreateJobLogDependencies(...args),
    deriveDiagnosticTarget: (...args: unknown[]) => mockDeriveDiagnosticTarget(...args),
  };
});

jest.mock('server/lib/kubernetes/getDeploymentPods', () => ({
  loadKubeConfig: (...args: unknown[]) => mockLoadKubeConfig(...args),
}));

jest.mock('../core/getEnvironment', () => ({
  isEnvironmentBuild: (...args: unknown[]) => mockIsEnvironmentBuild(...args),
  resolveNamedEnvironmentRead: (...args: unknown[]) => mockResolveNamedEnvironmentRead(...args),
}));

import * as k8s from '@kubernetes/client-node';
import { DiagnosticReadError } from 'server/lib/kubernetes/diagnosticReaders';
import { DeployTypes } from 'shared/constants';
import type { McpToolContext } from '../../contracts';
import { McpExecutionError } from '../../errors';
import {
  mapDiagnosticError,
  requireDiagnosticEnvironment,
  resolveDiagnosticToolDependencies,
  type LoadedDiagnosticEnvironment,
  type ResolvedDiagnosticToolDependencies,
} from './shared';

function diagnosticContext(signal = new AbortController().signal): McpToolContext {
  return { signal } as McpToolContext;
}

function loadedEnvironment(): LoadedDiagnosticEnvironment {
  return {
    build: { id: 7, uuid: 'candidate-123456', namespace: 'env-candidate-123456' } as never,
    target: { uuid: 'candidate-123456', namespace: 'env-candidate-123456', services: [] } as never,
  };
}

function resolvedDependencies(
  loadEnvironment: ResolvedDiagnosticToolDependencies['loadEnvironment']
): ResolvedDiagnosticToolDependencies {
  return {
    loadEnvironment,
    getCoreApi: jest.fn(),
    getJobLogDependencies: jest.fn(),
    collectEvidence: jest.fn(),
  };
}

describe('diagnostic shared helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEnvironmentBuild.mockReturnValue(true);
    mockDeriveDiagnosticTarget.mockImplementation((build, services) => ({ ...build, services }));
  });

  it('loads the authorized environment deploy graph and derives scoped provider targets', async () => {
    const build = { id: 7, uuid: 'candidate-123456', namespace: 'env-candidate-123456' };
    const rows = [
      {
        id: 11,
        uuid: 'deploy-api',
        deployable: { name: 'api', type: DeployTypes.GITHUB },
      },
      {
        id: 12,
        uuid: 'deploy-pipeline',
        deployable: { name: 'pipeline', type: DeployTypes.CODEFRESH },
      },
      {
        id: 13,
        uuid: 'deploy-without-name',
        deployable: { name: '', type: DeployTypes.GITHUB },
      },
      {
        id: 14,
        uuid: 'deploy-without-relation',
        deployable: null,
      },
    ];
    const withGraphFetched = jest.fn().mockResolvedValue(rows);
    const select = jest.fn(() => ({ withGraphFetched }));
    const where = jest.fn(() => ({ select }));
    mockDeployQuery.mockReturnValue({ where });
    mockResolveNamedEnvironmentRead.mockResolvedValue({ build, repository: { fullName: 'example-org/example' } });
    const target = { uuid: build.uuid, namespace: build.namespace, services: ['derived'] };
    mockDeriveDiagnosticTarget.mockReturnValue(target);
    const dependencies = resolveDiagnosticToolDependencies();

    await expect(dependencies.loadEnvironment(build.uuid)).resolves.toEqual({ build, target });

    expect(mockResolveNamedEnvironmentRead).toHaveBeenCalledWith(build.uuid);
    expect(where).toHaveBeenCalledWith({ buildId: 7 });
    expect(select).toHaveBeenCalledWith(
      'id',
      'uuid',
      'buildId',
      'deployableId',
      'githubRepositoryId',
      'status',
      'statusMessage',
      'buildOutput',
      'active'
    );
    expect(withGraphFetched).toHaveBeenCalledWith('deployable');
    expect(build).toHaveProperty('deploys', rows);
    expect(mockDeriveDiagnosticTarget).toHaveBeenCalledWith({ uuid: build.uuid, namespace: build.namespace }, [
      { name: 'api', deployUuid: 'deploy-api', provider: 'kubernetes' },
      { name: 'pipeline', deployUuid: 'deploy-pipeline', provider: 'codefresh' },
    ]);
  });

  it('lazily creates and memoizes the default Kubernetes client and default helper dependencies', async () => {
    const coreApi = { listNamespacedPod: jest.fn() };
    const makeApiClient = jest.fn().mockReturnValue(coreApi);
    const jobLogDependencies = { listJobs: jest.fn() };
    const evidence = { buildStatus: 'ready', failingServices: [], blockedServices: [] };
    mockLoadKubeConfig.mockReturnValue({ makeApiClient });
    mockCreateJobLogDependencies.mockReturnValue(jobLogDependencies);
    mockCollectTriageEvidence.mockResolvedValue(evidence);
    const dependencies = resolveDiagnosticToolDependencies();

    expect(mockLoadKubeConfig).not.toHaveBeenCalled();
    expect(dependencies.getCoreApi()).toBe(coreApi);
    expect(dependencies.getCoreApi()).toBe(coreApi);
    expect(mockLoadKubeConfig).toHaveBeenCalledTimes(1);
    expect(makeApiClient).toHaveBeenCalledTimes(1);
    expect(makeApiClient).toHaveBeenCalledWith(k8s.CoreV1Api);

    expect(dependencies.getJobLogDependencies(coreApi as never)).toBe(jobLogDependencies);
    expect(mockCreateJobLogDependencies).toHaveBeenCalledWith(coreApi);
    await expect(dependencies.collectEvidence({ id: 7 } as never, [], { coreApi: coreApi as never })).resolves.toBe(
      evidence
    );
    expect(mockCollectTriageEvidence).toHaveBeenCalledWith({ id: 7 }, [], { coreApi });
  });

  it('uses every supplied dependency without constructing default clients or helpers', async () => {
    const loaded = loadedEnvironment();
    const coreApi = { listNamespacedPod: jest.fn() };
    const jobLogDependencies = { listJobs: jest.fn() };
    const evidence = { buildStatus: 'ready', failingServices: [], blockedServices: [] };
    const loadEnvironment = jest.fn().mockResolvedValue(loaded);
    const getCoreApi = jest.fn(() => coreApi);
    const getJobLogDependencies = jest.fn(() => jobLogDependencies);
    const collectEvidence = jest.fn().mockResolvedValue(evidence);
    const dependencies = resolveDiagnosticToolDependencies({
      loadEnvironment,
      getCoreApi: getCoreApi as never,
      getJobLogDependencies: getJobLogDependencies as never,
      collectEvidence: collectEvidence as never,
    });

    await expect(dependencies.loadEnvironment('candidate-123456')).resolves.toBe(loaded);
    expect(dependencies.getCoreApi()).toBe(coreApi);
    expect(dependencies.getCoreApi()).toBe(coreApi);
    expect(dependencies.getJobLogDependencies(coreApi as never)).toBe(jobLogDependencies);
    await expect(dependencies.collectEvidence({ id: 7 } as never, [])).resolves.toBe(evidence);

    expect(loadEnvironment).toHaveBeenCalledWith('candidate-123456');
    expect(getCoreApi).toHaveBeenCalledTimes(2);
    expect(getJobLogDependencies).toHaveBeenCalledWith(coreApi);
    expect(collectEvidence).toHaveBeenCalledWith({ id: 7 }, []);
    expect(mockLoadKubeConfig).not.toHaveBeenCalled();
    expect(mockCreateJobLogDependencies).not.toHaveBeenCalled();
    expect(mockCollectTriageEvidence).not.toHaveBeenCalled();
  });

  it('stops before environment loading when the request is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const loadEnvironment = jest.fn();

    await expect(
      requireDiagnosticEnvironment(
        'candidate-123456',
        diagnosticContext(controller.signal),
        resolvedDependencies(loadEnvironment)
      )
    ).rejects.toMatchObject({
      code: 'upstream_unavailable',
      message: 'The diagnostic request was cancelled.',
    });
    expect(loadEnvironment).not.toHaveBeenCalled();
    expect(mockIsEnvironmentBuild).not.toHaveBeenCalled();
  });

  it('rejects missing and non-environment rows without exposing them', async () => {
    const missingLoader = jest.fn().mockResolvedValue(null);
    await expect(
      requireDiagnosticEnvironment('missing-env', diagnosticContext(), resolvedDependencies(missingLoader))
    ).rejects.toMatchObject({
      code: 'env_not_found',
      message: 'No environment named missing-env exists.',
    });
    expect(mockIsEnvironmentBuild).not.toHaveBeenCalled();

    const loaded = loadedEnvironment();
    const nonEnvironmentLoader = jest.fn().mockResolvedValue(loaded);
    mockIsEnvironmentBuild.mockReturnValueOnce(false);
    await expect(
      requireDiagnosticEnvironment('sandbox-row', diagnosticContext(), resolvedDependencies(nonEnvironmentLoader))
    ).rejects.toMatchObject({
      code: 'env_not_found',
      message: 'No environment named sandbox-row exists.',
    });
    expect(mockIsEnvironmentBuild).toHaveBeenCalledWith(loaded.build);
  });

  it('returns the same authorized environment object after validating its build kind', async () => {
    const loaded = loadedEnvironment();
    const loadEnvironment = jest.fn().mockResolvedValue(loaded);

    await expect(
      requireDiagnosticEnvironment('candidate-123456', diagnosticContext(), resolvedDependencies(loadEnvironment))
    ).resolves.toBe(loaded);
    expect(loadEnvironment).toHaveBeenCalledWith('candidate-123456');
    expect(mockIsEnvironmentBuild).toHaveBeenCalledWith(loaded.build);
  });

  it('preserves MCP errors and maps typed diagnostic errors with optional details', () => {
    const mcpError = new McpExecutionError('env_not_found', 'Environment not found.');
    expect(mapDiagnosticError(mcpError)).toBe(mcpError);

    expect(
      mapDiagnosticError(
        new DiagnosticReadError('service_not_found', 'No service named worker exists.', {
          validServices: ['api'],
        })
      )
    ).toMatchObject({
      code: 'service_not_found',
      message: 'No service named worker exists.',
      details: { validServices: ['api'] },
    });

    expect(mapDiagnosticError(new DiagnosticReadError('logs_not_found', 'No logs exist.'))).toMatchObject({
      code: 'logs_not_found',
      message: 'No logs exist.',
      details: undefined,
    });
  });

  it('redacts unexpected provider errors behind a stable retryable diagnostic message', () => {
    const mapped = mapDiagnosticError(new Error('database password=super-secret socket failed'));

    expect(mapped).toMatchObject({
      code: 'upstream_unavailable',
      message:
        'Lifecycle could not read the diagnostic provider. Retry later or ask an administrator to inspect provider health.',
    });
    expect(mapped.message).not.toContain('super-secret');
    expect(mapped.details).toBeUndefined();
  });
});
