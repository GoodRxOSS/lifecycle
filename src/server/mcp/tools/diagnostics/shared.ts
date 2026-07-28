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

import * as k8s from '@kubernetes/client-node';
import type Build from 'server/models/Build';
import Deploy from 'server/models/Deploy';
import { DeployTypes } from 'shared/constants';
import {
  collectTriageEvidence,
  type TriageDossierOptions,
  type TriageEvidence,
} from 'server/lib/agentSession/triageDossier';
import {
  createDiagnosticJobLogDependencies,
  deriveDiagnosticTarget,
  DiagnosticReadError,
  type DiagnosticCoreApi,
  type DiagnosticJobLogDependencies,
  type DiagnosticTarget,
} from 'server/lib/kubernetes/diagnosticReaders';
import { loadKubeConfig } from 'server/lib/kubernetes/getDeploymentPods';
import type { McpJsonObject, McpToolContext } from '../../contracts';
import { McpExecutionError } from '../../errors';
import { isEnvironmentBuild, resolveNamedEnvironmentRead } from '../core/getEnvironment';

type LoadedDeploy = Deploy & {
  deployable?: (NonNullable<Deploy['deployable']> & { type?: string }) | null;
};

export interface LoadedDiagnosticEnvironment {
  build: Build & { deploys?: LoadedDeploy[] };
  target: DiagnosticTarget;
}

export interface DiagnosticToolDependencies {
  loadEnvironment?: (uuid: string) => Promise<LoadedDiagnosticEnvironment | null>;
  getCoreApi?: () => DiagnosticCoreApi;
  getJobLogDependencies?: (coreApi: DiagnosticCoreApi) => DiagnosticJobLogDependencies;
  collectEvidence?: (
    build: Parameters<typeof collectTriageEvidence>[0],
    deploys: Parameters<typeof collectTriageEvidence>[1],
    options?: TriageDossierOptions
  ) => Promise<TriageEvidence | null>;
}

export interface ResolvedDiagnosticToolDependencies {
  loadEnvironment: (uuid: string) => Promise<LoadedDiagnosticEnvironment | null>;
  getCoreApi: () => DiagnosticCoreApi;
  getJobLogDependencies: (coreApi: DiagnosticCoreApi) => DiagnosticJobLogDependencies;
  collectEvidence: NonNullable<DiagnosticToolDependencies['collectEvidence']>;
}

async function defaultLoadEnvironment(uuid: string): Promise<LoadedDiagnosticEnvironment | null> {
  const named = await resolveNamedEnvironmentRead(uuid);
  const build = named.build as LoadedDiagnosticEnvironment['build'];
  const diagnosticDeploys = (await Deploy.query()
    .where({ buildId: build.id })
    .select(
      'id',
      'uuid',
      'buildId',
      'deployableId',
      'githubRepositoryId',
      'status',
      'statusMessage',
      'buildOutput',
      'active'
    )
    .withGraphFetched('deployable')) as LoadedDeploy[];
  build.deploys = diagnosticDeploys;
  const deploys = diagnosticDeploys.filter((deploy): deploy is LoadedDeploy => Boolean(deploy.deployable?.name));
  const services = deploys.map((deploy) => ({
    name: deploy.deployable!.name,
    deployUuid: deploy.uuid,
    provider: deploy.deployable!.type === DeployTypes.CODEFRESH ? ('codefresh' as const) : ('kubernetes' as const),
  }));
  return {
    build,
    target: deriveDiagnosticTarget(
      {
        uuid: build.uuid,
        namespace: build.namespace,
      },
      services
    ),
  };
}

function defaultCoreApi(): DiagnosticCoreApi {
  const config = loadKubeConfig();
  return config.makeApiClient(k8s.CoreV1Api) as unknown as DiagnosticCoreApi;
}

export function resolveDiagnosticToolDependencies(
  dependencies: DiagnosticToolDependencies = {}
): ResolvedDiagnosticToolDependencies {
  let coreApi: DiagnosticCoreApi | undefined;
  return {
    loadEnvironment: dependencies.loadEnvironment ?? defaultLoadEnvironment,
    getCoreApi: () => dependencies.getCoreApi?.() ?? (coreApi ??= defaultCoreApi()),
    getJobLogDependencies:
      dependencies.getJobLogDependencies ?? ((resolvedCoreApi) => createDiagnosticJobLogDependencies(resolvedCoreApi)),
    collectEvidence: dependencies.collectEvidence ?? collectTriageEvidence,
  };
}

export async function requireDiagnosticEnvironment(
  uuid: string,
  context: McpToolContext,
  dependencies: ResolvedDiagnosticToolDependencies
): Promise<LoadedDiagnosticEnvironment> {
  if (context.signal.aborted) {
    throw new McpExecutionError('upstream_unavailable', 'The diagnostic request was cancelled.');
  }
  const loaded = await dependencies.loadEnvironment(uuid);
  if (!loaded || !isEnvironmentBuild(loaded.build)) {
    throw new McpExecutionError('env_not_found', `No environment named ${uuid} exists.`);
  }
  return loaded;
}

export function mapDiagnosticError(error: unknown): McpExecutionError {
  if (error instanceof McpExecutionError) return error;
  if (error instanceof DiagnosticReadError) {
    return new McpExecutionError(error.code, error.message, {
      ...(error.details ? { details: error.details as McpJsonObject } : {}),
    });
  }
  return new McpExecutionError(
    'upstream_unavailable',
    'Lifecycle could not read the diagnostic provider. Retry later or ask an administrator to inspect provider health.'
  );
}
