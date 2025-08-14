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

import { CF, CF_BUILD_STEP, CF_AFTER_BUILD_STEP } from 'server/lib/codefresh/constants';
export const branch = 'main';
export const dockerfilePath = 'Dockerfile';
export const envVars = {};
export const image = 'test-image';
export const pipelineId = 'test-pipeline';
export const org = 'test-org';
export const registry = 'lifecycle-deployments';
export const revision = 'abc123';
export const wd = 'test-repo';
export const version = 'latest';
export const ecrDomain = 'account-id.dkr.ecr.us-west-2.amazonaws.com';
export const repo = `${org}/${wd}`;
export const appShort = 'test';

export const deploy = {
  deployable: {
    buildUUID: '123',
  } as any,
  uuid: '456',
  serviceId: 123,
  branchName: 'foo',
};

export const checkoutStep = {
  fail_fast: true,
  repo,
  revision,
  stage: CF.CHECKOUT.CHECKOUT_STAGE,
  title: CF.CHECKOUT.CHECKOUT_STEP_TITLE,
  type: CF.CHECKOUT.TYPE,
  working_directory: '.',
};

export const annotations = [{ uuid: '123' }, { deployUUID: '456' }, { branch: 'foo' }, { repo: 'test-org/test-repo' }];

const hooks = {
  on_elected: {
    annotations: {
      set: [
        {
          annotations,
          display: 'deployUUID',
        },
      ],
    },
  },
};

export const buildStep = {
  ...CF_BUILD_STEP,
  build_arguments: ['BUILDKIT_INLINE_CACHE=1'],
  registry: 'lfc',
  image_name: 'lifecycle-deployments',
  no_cf_cache: true,
  working_directory: `./${wd}`,
  dockerfile: dockerfilePath,
  tag: version,
};

export const afterBuildStep = {
  ...CF_AFTER_BUILD_STEP,
  arguments: {
    DETACH: true,
    PIPELINE_ID: pipelineId,
    VARIABLE: [`TAG=${ecrDomain}/lfc/${registry}:${version}`, `SOURCE_REVISION=${revision}`, `SOURCE_BRANCH=${branch}`],
  },
};

export const afterBuildStepWithAppShort = {
  ...CF_AFTER_BUILD_STEP,
  arguments: {
    DETACH: true,
    PIPELINE_ID: pipelineId,
    VARIABLE: [`TAG=${ecrDomain}/lfc/app/lfc:${version}`, `SOURCE_REVISION=${revision}`, `SOURCE_BRANCH=${branch}`],
  },
};

export const generateAfterBuildStepOptions = {
  afterBuildPipelineId: pipelineId,
  tag: version,
  buildArgs: [],
  revision,
  branch,
  detatchAfterBuildPipeline: true,
  appShort: undefined,
  ecrDomain,
  ecrRepo: 'lfc/lifecycle-deployments',
};
export const generateAfterBuildStepOptionsWithAppShort = {
  afterBuildPipelineId: pipelineId,
  tag: version,
  buildArgs: [],
  revision,
  branch,
  detatchAfterBuildPipeline: true,
  appShort,
  ecrDomain,
  ecrRepo: `lfc/app/lfc`,
};

export const generateBuildStepOptions = {
  tag: version,
  dockerfile: dockerfilePath,
  buildArgs: [],
  repo,
  cacheFrom: '',
  deploy,
};

export const generalOptionDefaults = {
  afterBuildPipelineId: '',
  appShort: '',
  branch: '',
  buildPipelineName: '',
  cacheFrom: '',
  deploy,
  detatchAfterBuildPipeline: true,
  dockerfilePath: '',
  envVars: {},
  initDockerfilePath: '',
  registry: '',
  repo: '',
  revision: '',
  runtimeName: '',
  tag: '',
};

export const generateOptions = {
  ...generalOptionDefaults,
  imageName: image,
  repo,
  revision,
  dockerfilePath,
  envVars,
  tag: version,
  deploy,
  ecrDomain,
  ecrRepo: `lfc/app/lfc`,
};

export const generateYamlOptions = {
  ...generalOptionDefaults,
  envVars,
  repo,
  revision,
  dockerfile: dockerfilePath,
  initDockerfilePath: '',
  cacheFrom: '',
  afterBuildPipelineId: pipelineId,
  detachAfterBuildPipeline: true,
  deploy,
  ecrDomain,
  ecrRepo: `lfc/app/lfc`,
};

export const yamlDefaults = {
  mode: 'parallel',
  version: '1.0',
};

export const yamlStages = ['Checkout', 'Build', 'PostBuild'];

export const yamlContent = {
  ...yamlDefaults,
  hooks,
  stages: yamlStages,
  steps: {
    Build: buildStep,
    Checkout: checkoutStep,
    PostBuildPipeline: afterBuildStep,
  },
};

export const buildImageOptions = {
  dockerfilePath,
  envVars,
  tag: version,
  repo,
  revision,
  branch,
  initDockerfilePath: '',
  cacheFrom: '',
  detatchAfterBuildPipeline: true,
  afterBuildPipelineId: '',
  runtimeName: '',
  buildPipelineName: '',
  deploy,
  ecrDomain,
  ecrRepo: '',
};
