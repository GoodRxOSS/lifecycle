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

import { mkdirSync, writeFileSync } from 'fs';
import { CODEFRESH_PATH } from 'server/lib/codefresh/constants';
import { generateYaml } from 'server/lib/codefresh/utils/generateYaml';
import { constructEcrTag } from 'server/lib/codefresh/utils';
import { ContainerBuildOptions } from 'server/lib/codefresh/types';
import { Deploy } from 'server/models';
import { shellQuote } from 'server/lib/shellQuote';
import { codefreshRunArgs } from '../command';

export const generateCodefreshCmd = (options: ContainerBuildOptions) => {
  const yaml = generateYaml(options);

  const { ecrRepo, envVars, tag, branch, runtimeName, buildPipelineName, ecrDomain } = options;
  const configFilename = constructEcrTag({ repo: ecrRepo, tag, ecrDomain }).split('/').join('');
  const configPath = `${CODEFRESH_PATH}/${configFilename}.yaml`;
  const runtimeArgument = runtimeName ? [`--runtime-name=${runtimeName}`] : [];

  const variables = Object.keys(envVars).map((key) => `--variable=${key}=${envVars[key]}`);
  const command = codefreshRunArgs(String(buildPipelineName), [
    `--branch=${branch}`,
    ...runtimeArgument,
    ...variables,
    `--yaml=${configPath}`,
  ]);

  mkdirSync(CODEFRESH_PATH, { recursive: true });
  writeFileSync(configPath, yaml, 'utf8');

  return command;
};

export const deletePendingHelmReleaseStep = ({ deploy, namespace }: { deploy: Deploy; namespace: string }) => {
  return {
    title: 'Delete Pending Helm Releases',
    stage: 'Cleanup',
    image: 'alpine/helm:3.7.2',
    fail_fast: false,
    commands: [
      `helm list --namespace=${shellQuote(namespace)} -m 1000 --pending -q | grep -- ${shellQuote(
        deploy.uuid
      )} | xargs --no-run-if-empty helm uninstall --wait --namespace=${shellQuote(namespace)} --`,
    ],
  };
};

/*
   Wait for in progress builds to complete for deployUUID annotation
   This step will wait for any previous builds to complete(success/error/terminated)
   Meant to be executed before `deletePendingHelmReleaseStep` 
*/
export const waitForInProgressDeploys = ({ deployUUID, pipelineId }: { deployUUID: string; pipelineId: string }) => {
  return {
    title: 'Wait for pending deploys to finish',
    stage: 'Wait',
    image: 'codefresh/cli:0.87.4',
    fail_fast: false,
    commands: [
      `curl -X GET ${shellQuote(
        `https://g.codefresh.io/api/workflow?pipeline=${encodeURIComponent(pipelineId)}&status=running`
      )} -H "Authorization: $CODEFRESH_API_KEY" | jq -r --arg CF_BUILD_TIMESTAMP "$CF_BUILD_TIMESTAMP" --arg DEPLOY_UUID ${shellQuote(
        deployUUID
      )} '.workflows.docs[] | select(.annotations[] | select(.key=="deployUUID" and .value==$DEPLOY_UUID)) | select(.exposedVariables.pipeline[] | select(.key=="CF_BUILD_TIMESTAMP" and (.value | tonumber) < ($CF_BUILD_TIMESTAMP | tonumber))) | .id' | xargs -I {} bash -c 'if [ "$1" != "$CF_BUILD_ID" ]; then cf_export "terminate_CF_OUTPUT_URL=https://g.codefresh.io/build/$1"; case "$1" in -*) exit 1;; esac; codefresh wait -v "$1"; fi' _ '{}'`,
    ],
  };
};
