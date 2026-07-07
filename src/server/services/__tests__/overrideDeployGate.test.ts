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

jest.mock('server/lib/dependencies', () => ({}));
jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  updateLogContext: jest.fn(),
  extractContextForQueue: jest.fn(() => ({})),
}));
jest.mock('server/lib/kubernetes', () => ({ deleteNamespace: jest.fn() }));
jest.mock('../deploy', () => ({ __esModule: true, default: jest.fn().mockImplementation(() => ({})) }));

import OverrideService from '../override';

function createService() {
  const enqueueResolveAndDeployBuild = jest.fn().mockResolvedValue(undefined);
  const db = { services: { BuildService: { enqueueResolveAndDeployBuild } } };
  return { enqueueResolveAndDeployBuild, service: new OverrideService(db as any, {} as any, {} as any, {} as any) };
}

const enqueueRedeploy = (service: OverrideService, build: unknown, pullRequest: unknown) =>
  (service as any).enqueueRedeployIfEnabled(build, pullRequest, 'run-1');

describe('enqueueRedeployIfEnabled PR-less gate (F1 site)', () => {
  it('queues a redeploy for a PR-less build whose deployEnabled is true', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const build = { id: 9, pullRequest: null, deployEnabled: true };

    const queued = await enqueueRedeploy(service, build, null);

    expect(queued).toBe(true);
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: 9, triggerRef: 'run-1' })
    );
  });

  it('does not queue for a PR-less build whose deployEnabled is false', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const build = { id: 9, pullRequest: null, deployEnabled: false };

    const queued = await enqueueRedeploy(service, build, null);

    expect(queued).toBe(false);
    expect(enqueueResolveAndDeployBuild).not.toHaveBeenCalled();
  });

  it('hydrates a passed pullRequest onto a build that lacks one, then gates on it', async () => {
    const { service, enqueueResolveAndDeployBuild } = createService();
    const build: any = { id: 9, pullRequest: null, deployEnabled: false };
    const pullRequest = { deployOnUpdate: true };

    const queued = await enqueueRedeploy(service, build, pullRequest);

    expect(build.pullRequest).toBe(pullRequest);
    expect(queued).toBe(true);
    expect(enqueueResolveAndDeployBuild).toHaveBeenCalled();
  });
});
