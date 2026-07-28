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
import { BuildKind } from 'shared/constants';
import { resolveNamedEnvironmentRead, type LoadedEnvironment } from '../tools/core/getEnvironment';
import { createWaitForEnvironmentToolDefinition } from '../tools/core/waitForEnvironment';
import { assertAuthorizedEnvironmentTarget } from '../tools/operations/shared';

function loaded(kind: BuildKind): LoadedEnvironment {
  return {
    build: {
      id: 41,
      uuid: 'candidate-123456',
      kind,
    } as Build,
    repository: {
      githubRepositoryId: 7,
      fullName: 'goodrx/example',
    },
  };
}

const context = {
  principal: {
    kind: 'user' as const,
    authMethod: 'oauth' as const,
    userId: 'user-1',
    actor: 'user-1',
    roles: ['user' as const],
    scopes: null,
    tokenId: null,
    repositoryAllowlist: null,
    repositoryAllowlistRepoIds: null,
    identity: null,
  },
  requestId: 'request-1',
  signal: new AbortController().signal,
  audit: { annotate: jest.fn() },
};

it('keeps sandbox rows outside the shared Environment resolver', async () => {
  const loadDestroyedEnvironment = jest.fn().mockResolvedValue(null);

  await expect(
    resolveNamedEnvironmentRead('candidate-123456', {
      loadEnvironment: jest.fn().mockResolvedValue(loaded(BuildKind.SANDBOX)),
      loadDestroyedEnvironment,
    })
  ).rejects.toMatchObject({
    code: 'env_not_found',
  });
  expect(loadDestroyedEnvironment).toHaveBeenCalledWith('candidate-123456');
});

it('keeps sandbox rows outside exact Environment mutation targets', () => {
  expect(() => assertAuthorizedEnvironmentTarget(loaded(BuildKind.SANDBOX), 41)).toThrow(
    expect.objectContaining({ code: 'env_not_found' })
  );
});

it('keeps sandbox rows outside Environment waits', async () => {
  const tool = createWaitForEnvironmentToolDefinition({
    loadTarget: jest.fn().mockResolvedValue({
      kind: 'live',
      loaded: loaded(BuildKind.SANDBOX),
    }),
    getMaxWaitSeconds: () => 5,
  });

  await expect(
    tool.handler(
      {
        uuid: 'candidate-123456',
        environmentId: 41,
      },
      context
    )
  ).rejects.toMatchObject({
    code: 'env_not_found',
  });
});
