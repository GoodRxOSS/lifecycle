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

import type Build from 'server/models/Build';
import type Deploy from 'server/models/Deploy';
import { BuildStatus, DeployStatus, DeployTypes } from 'shared/constants';

export type EnvironmentPhase =
  | 'ready'
  | 'deployed_not_ready'
  | 'in_progress'
  | 'paused'
  | 'failed'
  | 'tearing_down'
  | 'torn_down';

export type ReadinessDeploy = Pick<Deploy, 'active' | 'status' | 'publicUrl' | 'publicHref'> & {
  deployable?: { type?: string | null } | null;
};

const RUNTIME_READY_TYPES = new Set<string>([
  DeployTypes.DOCKER,
  DeployTypes.GITHUB,
  DeployTypes.HELM,
  DeployTypes.AURORA_RESTORE,
]);
const BUILD_ONLY_TYPES = new Set<string>([DeployTypes.CODEFRESH, DeployTypes.CONFIGURATION]);
const FAILURE_STATUSES = new Set<string>([
  DeployStatus.ERROR,
  DeployStatus.BUILD_FAILED,
  DeployStatus.DEPLOY_FAILED,
  DeployStatus.TORN_DOWN,
]);

export function isDeployFailure(status: string | null | undefined): boolean {
  return status != null && FAILURE_STATUSES.has(status);
}

export function isActiveServiceReady(deploy: ReadinessDeploy): boolean {
  if (!deploy.active) return true;

  const type = deploy.deployable?.type;
  if (!type) return false;
  if (RUNTIME_READY_TYPES.has(type)) {
    return deploy.status === DeployStatus.READY;
  }
  if (type === DeployTypes.EXTERNAL_HTTP) {
    const effectiveUrl = deploy.publicHref?.trim() || deploy.publicUrl?.trim();
    return Boolean(effectiveUrl) && !isDeployFailure(deploy.status);
  }
  if (BUILD_ONLY_TYPES.has(type)) {
    return deploy.status === DeployStatus.BUILT || deploy.status === DeployStatus.READY;
  }
  // New service types must update this classifier and its fixtures.
  return false;
}

export function isEnvironmentReady(build: Pick<Build, 'status'> & { deploys?: ReadinessDeploy[] | null }): boolean {
  return build.status === BuildStatus.DEPLOYED && (build.deploys ?? []).every(isActiveServiceReady);
}

export function getEnvironmentPhase(
  build: Pick<Build, 'status' | 'deployEnabled'> & { deploys?: ReadinessDeploy[] | null }
): EnvironmentPhase {
  return getEnvironmentPhaseFromState(build.status, build.deployEnabled, isEnvironmentReady(build));
}

export function getEnvironmentPhaseFromState(
  status: string,
  deployEnabled: boolean | null | undefined,
  ready: boolean
): EnvironmentPhase {
  if (ready) return 'ready';
  if (status === BuildStatus.DEPLOYED) return 'deployed_not_ready';
  if ((status === BuildStatus.PENDING || status === BuildStatus.BUILT) && deployEnabled === false) {
    return 'paused';
  }
  if (status === BuildStatus.ERROR || status === BuildStatus.CONFIG_ERROR) return 'failed';
  if (status === BuildStatus.TEARING_DOWN) return 'tearing_down';
  if (status === BuildStatus.TORN_DOWN) return 'torn_down';
  return 'in_progress';
}

export function isEnvironmentTerminal(
  build: Pick<Build, 'status' | 'deployEnabled'> & { deploys?: ReadinessDeploy[] | null }
): boolean {
  const phase = getEnvironmentPhase(build);
  return (
    phase === 'ready' ||
    phase === 'deployed_not_ready' ||
    phase === 'paused' ||
    phase === 'failed' ||
    phase === 'torn_down'
  );
}
