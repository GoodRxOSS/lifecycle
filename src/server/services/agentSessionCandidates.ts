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

import Build from 'server/models/Build';
import type { Deploy } from 'server/models';
import { fetchLifecycleConfig, type LifecycleConfig } from 'server/models/yaml';
import {
  getDeployType,
  hasLifecycleManagedDockerBuild,
  type DevConfig,
  type Service as LifecycleService,
} from 'server/models/yaml/YamlService';
import { DeployTypes } from 'shared/constants';

export interface AgentSessionServiceCandidate {
  name: string;
  type: DeployTypes;
  detail?: string;
  deployId: number;
  devConfig: DevConfig;
  baseDeploy: Deploy;
}

export async function loadAgentSessionServiceCandidates(buildUuid: string): Promise<AgentSessionServiceCandidate[]> {
  const build = await Build.query()
    .findOne({ uuid: buildUuid })
    .withGraphFetched('[pullRequest, deploys.[deployable]]');
  if (!build?.pullRequest) {
    throw new Error('Build not found');
  }

  const lifecycleConfig = await fetchLifecycleConfig(build.pullRequest.fullName, build.pullRequest.branchName);
  if (!lifecycleConfig) {
    throw new Error('Lifecycle config not found for build');
  }

  return resolveAgentSessionServiceCandidates(build.deploys || [], lifecycleConfig);
}

export function resolveRequestedAgentSessionServices(
  candidates: AgentSessionServiceCandidate[],
  requestedServices: string[]
): AgentSessionServiceCandidate[] {
  const candidatesByName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
  const missingServices: string[] = [];

  const resolved = requestedServices.flatMap((serviceName) => {
    const candidate = candidatesByName.get(serviceName);
    if (!candidate) {
      missingServices.push(serviceName);
      return [];
    }

    return [candidate];
  });

  if (missingServices.length > 0) {
    throw new Error(`Unknown services for build: ${missingServices.join(', ')}`);
  }

  return resolved;
}

export function resolveAgentSessionServiceCandidates(
  deploys: Deploy[],
  lifecycleConfig: LifecycleConfig
): AgentSessionServiceCandidate[] {
  const activeDeploysByName = new Map(
    deploys
      .filter((deploy) => deploy.active && deploy.deployable?.name && deploy.id != null)
      .map((deploy) => [deploy.deployable!.name, deploy])
  );

  return lifecycleConfig.services.flatMap((service) => {
    if (!isSessionSelectableService(service)) {
      return [];
    }

    const baseDeploy = activeDeploysByName.get(service.name);
    if (!baseDeploy?.id) {
      return [];
    }

    return [
      {
        name: service.name,
        type: getDeployType(service),
        detail: baseDeploy.status,
        deployId: baseDeploy.id,
        devConfig: service.dev!,
        baseDeploy,
      },
    ];
  });
}

function isSessionSelectableService(service: LifecycleService): boolean {
  return !!service.dev && hasLifecycleManagedDockerBuild(service);
}
