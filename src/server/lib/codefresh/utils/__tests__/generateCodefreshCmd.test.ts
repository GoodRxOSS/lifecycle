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
import { generateCodefreshCmd } from 'server/lib/codefresh/utils/generateCodefreshCmd';

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
});
