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

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ getBuildByUUID: jest.fn() })),
}));

jest.mock('server/models/Repository', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

jest.mock('server/lib/environments/readiness', () => ({
  getEnvironmentPhase: jest.fn(),
  isEnvironmentTerminal: jest.fn(),
}));

jest.mock('../config', () => ({
  DEFAULT_MCP_WAIT_SECONDS: 10,
  MAX_MCP_WAIT_SECONDS: 15,
  loadMcpRuntimeConfig: jest.fn(),
}));

jest.mock('../tools/core/getEnvironment', () => ({
  isEnvironmentBuild: jest.fn(),
  serializeEnvironmentState: jest.fn(),
}));

jest.mock('../tools/core/listRepositories', () => ({
  mapCoreToolError: jest.fn((error: unknown) => error),
}));

import { deployRequestState } from '../tools/core/waitForEnvironment';

const row = (runUUID: string, desiredGeneration: number, observedGeneration: number, active = true) => ({
  runUUID,
  desiredGeneration,
  observedGeneration,
  active,
});

describe('deployRequestState', () => {
  it('settles a whole-environment deploy id once every active row has caught up', () => {
    const build: any = { runUUID: 'env-run', deploys: [row('a', 3, 3), row('b', 3, 2, false)] };
    expect(deployRequestState(build, 'env-run')).toBe('settled');

    build.deploys = [row('a', 3, 3), row('b', 3, 2)];
    expect(deployRequestState(build, 'env-run')).toBe('pending');
  });

  it('follows the rows a service-scoped run owns', () => {
    const build: any = { runUUID: 'env-run', deploys: [row('run-b', 4, 3), row('run-c', 2, 2)] };
    expect(deployRequestState(build, 'run-b')).toBe('pending');
    expect(deployRequestState(build, 'run-c')).toBe('settled');
  });

  it('falls back to the accepted entry when the rows were taken by a newer intent', () => {
    const build: any = {
      runUUID: 'env-run',
      deploys: [row('run-newer', 5, 4)],
      acceptedRefs: {
        'source:1:main': { requestId: 'run-old', gen: 4, observedGen: 4 },
        'source:2:main': { requestId: 'run-waiting', gen: 5 },
      },
    };
    expect(deployRequestState(build, 'run-old')).toBe('settled');
    expect(deployRequestState(build, 'run-waiting')).toBe('pending');
    expect(deployRequestState(build, 'run-unknown')).toBe('unknown');
    expect(deployRequestState({ runUUID: 'env-run', deploys: [], acceptedRefs: null } as any, 'x')).toBe('unknown');
  });
});
