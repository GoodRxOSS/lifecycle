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

import { BuildStatus, DeployStatus, DeployTypes } from 'shared/constants';
import {
  getEnvironmentPhase,
  getEnvironmentPhaseFromState,
  isActiveServiceReady,
  isDeployFailure,
  isEnvironmentReady,
  isEnvironmentTerminal,
} from '../readiness';

function service(
  type: string,
  status: DeployStatus,
  options: { active?: boolean; publicUrl?: string | null; publicHref?: string | null } = {}
) {
  return {
    active: options.active ?? true,
    status,
    publicUrl: options.publicUrl ?? null,
    publicHref: options.publicHref ?? null,
    deployable: { type },
  } as any;
}

describe('MCP environment readiness', () => {
  it.each([
    [DeployTypes.DOCKER, DeployStatus.READY, {}, true],
    [DeployTypes.GITHUB, DeployStatus.READY, {}, true],
    [DeployTypes.HELM, DeployStatus.READY, {}, true],
    [DeployTypes.AURORA_RESTORE, DeployStatus.READY, {}, true],
    [DeployTypes.DOCKER, DeployStatus.DEPLOYED, {}, false],
    [DeployTypes.EXTERNAL_HTTP, DeployStatus.QUEUED, { publicUrl: 'external.example' }, true],
    [DeployTypes.EXTERNAL_HTTP, DeployStatus.ERROR, { publicUrl: 'external.example' }, false],
    [DeployTypes.EXTERNAL_HTTP, DeployStatus.READY, {}, false],
    [DeployTypes.CODEFRESH, DeployStatus.BUILT, {}, true],
    [DeployTypes.CODEFRESH, DeployStatus.READY, {}, true],
    [DeployTypes.CONFIGURATION, DeployStatus.BUILT, {}, true],
    [DeployTypes.CONFIGURATION, DeployStatus.DEPLOYED, {}, false],
    ['future-provider', DeployStatus.READY, {}, false],
  ])('classifies active %s at %s with %o as ready=%s', (type, status, options, expected) => {
    expect(isActiveServiceReady(service(type as string, status as DeployStatus, options as any))).toBe(expected);
  });

  it('ignores inactive services, including unknown and failed service types', () => {
    expect(
      isActiveServiceReady(
        service('future-provider', DeployStatus.ERROR, {
          active: false,
        })
      )
    ).toBe(true);
  });

  it('fails closed when an active service has no declared type', () => {
    expect(
      isActiveServiceReady({
        active: true,
        status: DeployStatus.READY,
        publicUrl: null,
        publicHref: null,
        deployable: null,
      } as any)
    ).toBe(false);
  });

  it('requires both deployed build state and every active type-aware service condition', () => {
    const deploys = [
      service(DeployTypes.CONFIGURATION, DeployStatus.BUILT),
      service(DeployTypes.EXTERNAL_HTTP, DeployStatus.PENDING, {
        publicHref: 'https://public.example',
      }),
      service(DeployTypes.GITHUB, DeployStatus.READY),
    ];

    expect(isEnvironmentReady({ status: BuildStatus.DEPLOYED, deploys } as any)).toBe(true);
    expect(isEnvironmentReady({ status: BuildStatus.PENDING, deploys } as any)).toBe(false);
    expect(
      isEnvironmentReady({
        status: BuildStatus.DEPLOYED,
        deploys: [...deploys, service(DeployTypes.DOCKER, DeployStatus.DEPLOYED)],
      } as any)
    ).toBe(false);
    expect(isEnvironmentReady({ status: BuildStatus.DEPLOYED, deploys: null } as any)).toBe(true);
  });

  it.each([
    [BuildStatus.DEPLOYED, true, [service(DeployTypes.DOCKER, DeployStatus.READY)], 'ready'],
    [BuildStatus.DEPLOYED, true, [service(DeployTypes.DOCKER, DeployStatus.DEPLOYED)], 'deployed_not_ready'],
    [BuildStatus.QUEUED, true, [], 'in_progress'],
    [BuildStatus.PENDING, false, [], 'paused'],
    [BuildStatus.BUILT, false, [], 'paused'],
    [BuildStatus.BUILT, true, [], 'in_progress'],
    [BuildStatus.ERROR, false, [], 'failed'],
    [BuildStatus.CONFIG_ERROR, true, [], 'failed'],
    [BuildStatus.TEARING_DOWN, false, [], 'tearing_down'],
    [BuildStatus.TORN_DOWN, false, [], 'torn_down'],
  ])('rolls status=%s enabled=%s into phase=%s', (status, deployEnabled, deploys, expected) => {
    const build = { status, deployEnabled, deploys } as any;
    expect(getEnvironmentPhase(build)).toBe(expected);
    expect(isEnvironmentTerminal(build)).toBe(
      ['ready', 'deployed_not_ready', 'paused', 'failed', 'torn_down'].includes(expected as string)
    );
  });

  it('exposes the pure phase rollup for pre-aggregated listing state', () => {
    expect(getEnvironmentPhaseFromState(BuildStatus.BUILDING, true, false)).toBe('in_progress');
  });

  it.each([DeployStatus.ERROR, DeployStatus.BUILD_FAILED, DeployStatus.DEPLOY_FAILED, DeployStatus.TORN_DOWN])(
    'recognizes terminal deploy failure %s',
    (status) => {
      expect(isDeployFailure(status)).toBe(true);
    }
  );

  it('does not classify absent or progressing deploy statuses as failures', () => {
    expect(isDeployFailure(null)).toBe(false);
    expect(isDeployFailure(DeployStatus.BUILDING)).toBe(false);
  });
});
