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

import { generateYaml } from 'server/lib/codefresh/utils/generateYaml';
import { generateCodefreshCmd } from 'server/lib/codefresh/utils/generateCodefreshCmd';
import { CF, CF_CHECKOUT_STEP, CF_BUILD_STEP, CF_AFTER_BUILD_STEP } from 'server/lib/codefresh/constants';

export const constructBuildArgs = (envVars = {}) => {
  const envVarsItems = Object.keys(envVars);
  return envVarsItems?.length > 0 ? Object.keys(envVars).map((k) => `${k}=\${{${k}}}`) : [];
};

export const generateCheckoutStep = (revision: string, repo: string, gitOrg: string) => ({
  ...CF_CHECKOUT_STEP,
  working_directory: '.',
  git: gitOrg,
  repo,
  revision,
  type: CF.CHECKOUT.TYPE,
});

export const generateBuildStep = ({ ecrRepo, tag, dockerfile, buildArgs, repo, cacheFrom }) => {
  const cacheFromArg = cacheFrom?.length > 0 ? [`--cache-from=${cacheFrom}`] : [];
  const build_arguments = [...buildArgs, 'BUILDKIT_INLINE_CACHE=1', ...cacheFromArg];
  const [registry, ...rest] = ecrRepo.split('/');
  const image_name = rest.join('/');
  return {
    ...CF_BUILD_STEP,
    registry,
    image_name,
    tag,
    build_arguments,
    no_cf_cache: cacheFrom ? false : true,
    working_directory: `./${repo.split('/')[1]}`,
    dockerfile,
  };
};

export const generateAfterBuildStep = ({
  afterBuildPipelineId: PIPELINE_ID,
  tag,
  buildArgs,
  revision,
  branch,
  detatchAfterBuildPipeline: DETACH,
  ecrRepo,
  ecrDomain,
}) => {
  const ecrTag = constructEcrTag({ repo: ecrRepo, tag, ecrDomain });
  return {
    ...CF_AFTER_BUILD_STEP,
    arguments: {
      DETACH,
      PIPELINE_ID,
      VARIABLE: buildArgs.concat(`TAG=${ecrTag}`, `SOURCE_REVISION=${revision}`, `SOURCE_BRANCH=${branch}`),
    },
  };
};

export const constructStages = ({ initDockerfilePath = '', afterBuildPipelineId = '' }) =>
  ['Checkout', 'Build'].concat(
    (initDockerfilePath && ['InitContainer']) || [],
    (afterBuildPipelineId && ['PostBuild']) || []
  );

export const constructEcrTag = ({ repo, tag, ecrDomain }: { repo: string; tag: string; ecrDomain: string }) =>
  `${ecrDomain}/${repo}:${tag}`;

export const getCodefreshPipelineIdFromOutput = (output: string) => {
  const lines = output.split('\n');

  // Codefresh uses 24-character hexadecimal strings as pipeline IDs
  const regex = /^[a-f0-9]{24}$/i;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (regex.test(trimmedLine)) {
      return trimmedLine;
    }
  }

  throw new Error(`Could not find pipeline ID in Codefresh output: ${output}`);
};

export { generateYaml, generateCodefreshCmd };
