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

import yaml from 'js-yaml';
import {
  constructBuildArgs,
  generateBuildStep,
  generateAfterBuildStep,
  constructStages,
  generateCheckoutStep,
} from 'server/lib/codefresh/utils';
import { ContainerBuildOptions } from 'server/lib/codefresh/types';

export const generateYaml = (options: ContainerBuildOptions) => {
  const {
    ecrRepo,
    envVars,
    gitOrg = 'REPLACE_ME_ORG',
    repo,
    revision,
    tag,
    ecrDomain,
    dockerfilePath,
    initDockerfilePath,
    cacheFrom,
    afterBuildPipelineId,
    branch,
    detatchAfterBuildPipeline,
    deploy,
    initTag,
    author,
    enabledFeatures = [],
  } = options;
  const buildArgs = constructBuildArgs(envVars);

  const buildOptions = {
    ecrRepo,
    tag,
    dockerfile: dockerfilePath,
    buildArgs,
    repo,
    cacheFrom,
    deploy,
    author,
    enabledFeatures,
    ecrDomain,
  };

  const annotationsObj = {
    uuid: deploy?.deployable?.buildUUID,
    deployUUID: deploy?.uuid,
    branch: deploy?.branchName,
    repo,
    author,
  };
  const annotations = Object.keys(annotationsObj)
    .filter((key) => annotationsObj[key])
    .map((key) => ({ [key]: annotationsObj[key] }));

  const yamlContent = {
    version: '1.0',
    hooks: {
      on_elected: {
        annotations: {
          set: [{ annotations, display: 'deployUUID' }],
        },
      },
    },
    mode: 'parallel',
    stages: constructStages({ initDockerfilePath, afterBuildPipelineId }),
    steps: {
      Checkout: generateCheckoutStep(revision, repo, gitOrg),
      Build: generateBuildStep(buildOptions),
      ...(initDockerfilePath && {
        InitContainer: generateBuildStep({
          ...buildOptions,
          tag: `${initTag}`,
          dockerfile: initDockerfilePath,
        }),
      }),
      ...(afterBuildPipelineId && {
        PostBuildPipeline: generateAfterBuildStep({
          ecrRepo,
          afterBuildPipelineId,
          tag,
          buildArgs,
          revision,
          branch,
          detatchAfterBuildPipeline,
          ecrDomain,
        }),
      }),
    },
  };

  const generatedYaml = yaml.dump(yamlContent);
  return generatedYaml;
};
