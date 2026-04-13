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

import { buildAgentPrewarmJobSpec } from '../prewarmJobFactory';

describe('prewarmJobFactory', () => {
  const baseOpts = {
    jobName: 'agent-prewarm-sample',
    namespace: 'env-sample',
    pvcName: 'agent-prewarm-pvc-sample',
    image: 'workspace-image:latest',
    apiKeySecretName: 'agent-secret-sample',
    repoUrl: 'https://github.com/example-org/example-repo.git',
    branch: 'sample-branch',
    revision: 'abcdef1234567890',
    workspacePath: '/workspace/example-repo',
  };

  it('keeps clone/bootstrap steps separate from runtime seeding', () => {
    const job = buildAgentPrewarmJobSpec(baseOpts);
    const initWorkspace = job.spec!.template.spec!.initContainers!.find(
      (container) => container.name === 'init-workspace'
    );
    const seedRuntimeConfig = job.spec!.template.spec!.initContainers!.find(
      (container) => container.name === 'seed-runtime-config'
    );

    expect(initWorkspace).toBeDefined();
    expect(seedRuntimeConfig).toBeDefined();
    expect(initWorkspace!.command![2]).toContain('git clone --progress --depth 50 --branch "sample-branch"');
    expect(initWorkspace!.command![2]).not.toContain('git config --global user.name');
    expect(initWorkspace!.command![2]).not.toContain('git config --global --add safe.directory');
    expect(initWorkspace!.command![2]).not.toContain('pre-push');
    expect(seedRuntimeConfig!.command![2]).toContain(
      'git config --global --add safe.directory "/workspace/example-repo"'
    );
    expect(seedRuntimeConfig!.command![2]).toContain('pre-push');
  });

  it('configures git auth before clone when GitHub token forwarding is enabled', () => {
    const job = buildAgentPrewarmJobSpec({ ...baseOpts, hasGitHubToken: true });
    const initWorkspace = job.spec!.template.spec!.initContainers!.find(
      (container) => container.name === 'init-workspace'
    );

    expect(initWorkspace).toBeDefined();
    const script = initWorkspace!.command![2];
    const credentialHelperIndex = script.indexOf(
      'git config --global credential.helper \'!f() { test "$1" = get || exit 0; echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f\''
    );
    const cloneIndex = script.indexOf('git clone --progress --depth 50 --branch "sample-branch"');

    expect(credentialHelperIndex).toBeGreaterThan(-1);
    expect(cloneIndex).toBeGreaterThan(-1);
    expect(credentialHelperIndex).toBeLessThan(cloneIndex);
  });
});
