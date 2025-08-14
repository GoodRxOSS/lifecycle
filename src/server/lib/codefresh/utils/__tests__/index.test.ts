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

import {
  afterBuildStep,
  afterBuildStepWithAppShort,
  buildStep,
  checkoutStep,
  generateAfterBuildStepOptions,
  generateAfterBuildStepOptionsWithAppShort,
  generateBuildStepOptions,
  repo,
  revision,
} from 'server/lib/codefresh/__fixtures__/codefresh';
import * as utils from 'server/lib/codefresh/utils';

describe('constructBuildArgs', () => {
  it('returns an empty array when no env vars are passed', () => {
    const result = utils.constructBuildArgs({});
    expect(result).toEqual([]);
  });

  it('returns an array of env vars when env vars are passed', () => {
    const result = utils.constructBuildArgs({ FOO: 'bar', BAZ: 'qux' });
    expect(result).toEqual(['FOO=${{FOO}}', 'BAZ=${{BAZ}}']);
  });
});

test('generateCheckoutStep', () => {
  const gitOrg = 'test-git-org';
  const result = utils.generateCheckoutStep(revision, repo, gitOrg);
  expect(result).toEqual({
    ...checkoutStep,
    git: gitOrg,
  });
});

test('generateBuildStep', () => {
  const options = { ...generateBuildStepOptions, imageName: 'test-image', ecrRepo: 'lfc/lifecycle-deployments' };
  const result = utils.generateBuildStep(options);
  expect(result).toEqual(buildStep);
});

test('generateAfterBuildStep without appShort', () => {
  const result = utils.generateAfterBuildStep(generateAfterBuildStepOptions);
  expect(result).toEqual(afterBuildStep);
});

test('generateAfterBuildStep with appShort', () => {
  const result = utils.generateAfterBuildStep(generateAfterBuildStepOptionsWithAppShort);
  expect(result).toEqual(afterBuildStepWithAppShort);
});

describe('constructStages', () => {
  it('returns defaults', () => {
    const result = utils.constructStages({});
    expect(result).toEqual(['Checkout', 'Build']);
  });

  it('returns all build items when defined', () => {
    const result = utils.constructStages({ initDockerfilePath: 'foo', afterBuildPipelineId: 'bar' });
    expect(result).toEqual(['Checkout', 'Build', 'InitContainer', 'PostBuild']);
  });

  it('returns all build items when defined', () => {
    const result = utils.constructStages({ afterBuildPipelineId: 'bar' });
    expect(result).toEqual(['Checkout', 'Build', 'PostBuild']);
  });
});
