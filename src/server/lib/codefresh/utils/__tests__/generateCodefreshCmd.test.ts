/**
 * Copyright 2025 GoodRx, Inc.
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

import { generateOptions } from 'server/lib/codefresh/__fixtures__/codefresh';
import {
  deletePendingHelmReleaseStep,
  generateCodefreshCmd,
  waitForInProgressDeploys,
} from 'server/lib/codefresh/utils/generateCodefreshCmd';

jest.mock('server/lib/codefresh/utils/generateYaml');
import * as yaml from 'server/lib/codefresh/utils/generateYaml';

describe('generateCodefreshCmd', () => {
  it('should generate command with master branch', () => {
    jest.spyOn(yaml, 'generateYaml').mockReturnValue('yaml');
    const options = { ...generateOptions, branch: 'master' };
    const result = generateCodefreshCmd(options);

    expect(result).toContain('-b "master"');
  });

  it('should generate command with unique branch', () => {
    jest.spyOn(yaml, 'generateYaml').mockReturnValue('yaml');
    const customBranchOptions = {
      ...generateOptions,
      branch: 'unique-branch-name',
    };

    const result = generateCodefreshCmd(customBranchOptions);

    expect(result).toContain('-b "unique-branch-name"');
  });

  it('should generate command with repo name', () => {
    jest.spyOn(yaml, 'generateYaml').mockReturnValue('yaml');
    const customImageOptions = {
      ...generateOptions,
      imageTag: 'latest',
    };

    const result = generateCodefreshCmd(customImageOptions);

    expect(result).toContain('latest');
  });

  it('includes the selected runtime and every build environment variable', () => {
    jest.spyOn(yaml, 'generateYaml').mockReturnValue('yaml');

    const result = generateCodefreshCmd({
      ...generateOptions,
      runtimeName: 'production-runtime',
      envVars: { API_URL: 'https://api.example.test', EMPTY_VALUE: '' },
    });

    expect(result).toContain('--runtime-name production-runtime');
    expect(result).toContain("-v 'API_URL'='https://api.example.test'");
    expect(result).toContain("-v 'EMPTY_VALUE'=''");
  });
});

describe('Codefresh deployment coordination steps', () => {
  it('builds the pending Helm release cleanup step for the deployment namespace', () => {
    expect(
      deletePendingHelmReleaseStep({
        deploy: { uuid: 'deploy-123' } as never,
        namespace: 'candidate-123',
      })
    ).toEqual({
      title: 'Delete Pending Helm Releases',
      stage: 'Cleanup',
      image: 'alpine/helm:3.7.2',
      fail_fast: false,
      commands: [
        'helm list -n candidate-123 -m 1000 --pending -q | grep deploy-123 | xargs --no-run-if-empty helm uninstall --wait -n candidate-123',
      ],
    });
  });

  it('builds the wait step with the requested deployment and pipeline identifiers', () => {
    const step = waitForInProgressDeploys({ deployUUID: 'deploy-123', pipelineId: 'pipeline-456' });

    expect(step).toMatchObject({
      title: 'Wait for pending deploys to finish',
      stage: 'Wait',
      image: 'codefresh/cli:0.87.4',
      fail_fast: false,
    });
    expect(step.commands).toHaveLength(1);
    expect(step.commands[0]).toContain('pipeline=pipeline-456&status=running');
    expect(step.commands[0]).toContain('.value=="deploy-123"');
    expect(step.commands[0]).toContain('if [ "{}" != "$CF_BUILD_ID" ]');
  });
});
