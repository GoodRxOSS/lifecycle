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
  checkoutStep,
  buildStep,
  afterBuildStep,
  generateYamlOptions,
  yamlContent,
} from 'server/lib/codefresh/__fixtures__/codefresh';
import { generateYaml } from 'server/lib/codefresh/utils/generateYaml';

jest.mock('js-yaml', () => ({
  dump: jest.fn((value) => value),
}));

jest.mock('server/lib/codefresh/utils');
import * as utils from 'server/lib/codefresh/utils';

describe('generateYaml', () => {
  let constructBuildArgs, generateCheckoutStepSpy, generateBuildStepSpy, generateAfterBuildStepSpy, constructStagesSpy;

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('should generate yaml', () => {
    constructBuildArgs = jest.spyOn(utils, 'constructBuildArgs').mockReturnValue([]);
    generateCheckoutStepSpy = jest.spyOn(utils, 'generateCheckoutStep').mockReturnValue({
      ...checkoutStep,
      git: 'REPLACE_ME_ORG',
    });
    generateBuildStepSpy = jest.spyOn(utils, 'generateBuildStep').mockReturnValue(buildStep);
    generateAfterBuildStepSpy = jest.spyOn(utils, 'generateAfterBuildStep').mockReturnValue(afterBuildStep);
    constructStagesSpy = jest.spyOn(utils, 'constructStages').mockReturnValue(['Checkout', 'Build', 'PostBuild']);
    const result = generateYaml(generateYamlOptions);
    expect(result).toEqual({
      ...yamlContent,
      steps: {
        ...yamlContent.steps,
        Checkout: {
          ...checkoutStep,
          git: 'REPLACE_ME_ORG',
        },
      },
    });
    expect(constructBuildArgs).toHaveBeenCalledWith({});
    expect(generateCheckoutStepSpy).toHaveBeenCalled();
    expect(generateBuildStepSpy).toHaveBeenCalled();
    expect(generateAfterBuildStepSpy).toHaveBeenCalled();
    expect(constructStagesSpy).toHaveBeenCalled();
  });
});
