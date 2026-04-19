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

const mockSetupReadOnlyServiceAccountInNamespace = jest.fn();

jest.mock('server/lib/kubernetes/rbac', () => ({
  setupReadOnlyServiceAccountInNamespace: mockSetupReadOnlyServiceAccountInNamespace,
}));

function loadModule() {
  let loadedModule: typeof import('../serviceAccountFactory');
  jest.isolateModules(() => {
    loadedModule = require('../serviceAccountFactory');
  });

  return loadedModule!;
}

describe('serviceAccountFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reuses the in-flight setup promise for the same namespace', async () => {
    let resolveSetup!: () => void;
    mockSetupReadOnlyServiceAccountInNamespace.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSetup = resolve;
        })
    );

    const { ensureAgentSessionServiceAccount } = loadModule();
    const firstCall = ensureAgentSessionServiceAccount('test-ns');
    const secondCall = ensureAgentSessionServiceAccount('test-ns');

    expect(mockSetupReadOnlyServiceAccountInNamespace).toHaveBeenCalledTimes(1);

    resolveSetup();

    await expect(firstCall).resolves.toBe('agent-sa');
    await expect(secondCall).resolves.toBe('agent-sa');
  });

  it('clears the namespace cache after a failed setup', async () => {
    const setupError = new Error('setup failed');
    mockSetupReadOnlyServiceAccountInNamespace.mockRejectedValueOnce(setupError).mockResolvedValueOnce(undefined);

    const { ensureAgentSessionServiceAccount } = loadModule();

    await expect(ensureAgentSessionServiceAccount('test-ns')).rejects.toThrow('setup failed');
    await expect(ensureAgentSessionServiceAccount('test-ns')).resolves.toBe('agent-sa');
    expect(mockSetupReadOnlyServiceAccountInNamespace).toHaveBeenCalledTimes(2);
  });
});
