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

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
}));

jest.mock('../build', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../deploy', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    hostForDeployableDeploy: jest.fn(),
  })),
}));

jest.mock('../agentSession', () => ({
  __esModule: true,
  default: {
    createSession: jest.fn(),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    warn: jest.fn(),
  })),
}));

jest.mock('server/models/yaml', () => ({
  fetchLifecycleConfig: jest.fn(),
  getDeployingServicesByName: jest.fn(),
}));

import AgentSandboxSessionService from '../agentSandboxSession';
import { fetchLifecycleConfig, getDeployingServicesByName } from 'server/models/yaml';

describe('agentSandboxSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps repository identity when resolving duplicate dependency names', async () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);
    const baseBuild = {
      uuid: 'base-build',
      deploys: [
        {
          id: 1,
          active: true,
          deployable: { name: 'frontend' },
          repository: { fullName: 'org/frontend' },
        },
        {
          id: 2,
          active: true,
          deployable: { name: 'shared-api' },
          repository: { fullName: 'org/api-a' },
        },
        {
          id: 3,
          active: true,
          deployable: { name: 'shared-api' },
          repository: { fullName: 'org/api-b' },
        },
      ],
    } as any;
    const selectedService = {
      name: 'frontend',
      devConfig: { image: 'node:20', command: 'pnpm dev' },
      baseDeploy: baseBuild.deploys[0],
      serviceRepo: 'org/frontend',
      serviceBranch: 'main',
      yamlService: {
        name: 'frontend',
        requires: [{ name: 'shared-api', repository: 'org/api-b' }],
      },
    } as any;

    (fetchLifecycleConfig as jest.Mock).mockResolvedValue({});
    (getDeployingServicesByName as jest.Mock).mockReturnValue({
      name: 'shared-api',
      requires: [],
    });

    const includedKeys = await (service as any).resolveDependencyClosure(baseBuild, selectedService, {
      repo: 'env/static-environments',
      branch: 'main',
    });

    expect([...includedKeys]).toEqual(expect.arrayContaining(['org/frontend::frontend', 'org/api-b::shared-api']));
    expect(includedKeys.has('org/api-a::shared-api')).toBe(false);
  });

  it('fails closed when multiple top-level sandbox candidates share the same name', () => {
    const service = new AgentSandboxSessionService({} as any, {} as any, {} as any, {} as any);

    expect(() =>
      (service as any).resolveSelectedService('shared-api', [
        { name: 'shared-api', serviceRepo: 'org/api-a' },
        { name: 'shared-api', serviceRepo: 'org/api-b' },
      ])
    ).toThrow('Multiple sandbox services matched shared-api');
  });
});
