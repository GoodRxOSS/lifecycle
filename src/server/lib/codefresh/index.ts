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

import { shellPromise } from 'server/lib/shell';
import rootLogger from 'server/lib/logger';
import { generateCodefreshCmd, constructEcrTag, getCodefreshPipelineIdFromOutput } from 'server/lib/codefresh/utils';
import { waitUntil } from 'server/lib/utils';
import { ContainerBuildOptions } from 'server/lib/codefresh/types';
import { Metrics } from 'server/lib/metrics';
import { ENVIRONMENT } from 'shared/config';
import GlobalConfigService from 'server/services/globalConfig';

const logger = rootLogger.child({
  filename: 'lib/codefresh/codefresh.ts',
});

export const tagExists = async ({ tag, ecrRepo = 'lifecycle-deployments', uuid = '' }) => {
  const { lifecycleDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  const repoName = ecrRepo;
  // fetch the ecr registry id from ecrDomain value `acctid.dkr.ecr.us-west-2.amazonaws.com`.  this is useful if registry is in a different account
  // if its in the same account as lifecycle app, still passed for clarity here
  const registryId = (lifecycleDefaults.ecrDomain?.split?.('.') || [])[0] || '';
  try {
    const command = `aws ecr describe-images --repository-name=${repoName} --image-ids=imageTag=${tag} --no-paginate --no-cli-auto-prompt --registry-id ${registryId}`;
    await shellPromise(command);
    logger.info(`[BUILD ${uuid}] Image with tag:${tag} exists in ecr repo ${repoName}`);
    return true;
  } catch (error) {
    logger.info(`[BUILD ${uuid}] Image with tag:${tag} does not exist in ecr repo ${repoName}`);
    return false;
  }
};

export const buildImage = async (options: ContainerBuildOptions) => {
  const { repo: repositoryName, branch, uuid, revision: sha, tag } = options;
  const metrics = new Metrics('build.codefresh.image', { uuid, repositoryName, branch, sha });
  const prefix = uuid ? `[DEPLOY ${uuid}][buildImage]:` : '[DEPLOY][buildImage]:';
  const suffix = `${repositoryName}/${branch}:${sha}`;
  const eventDetails = {
    title: 'Codefresh Build Image',
    description: `build for ${uuid} with ${tag} has finished for ${suffix}`,
  };
  try {
    const codefreshRunCommand = generateCodefreshCmd(options);
    const output = await shellPromise(codefreshRunCommand);
    const hasOutput = output?.length > 0;
    const hasYamlString = output?.includes('Yaml');
    if (!hasOutput || !hasYamlString) {
      metrics
        .increment('total', { error: 'error_with_cli_output', result: 'error', codefreshBuildId: '' })
        .event(eventDetails.title, eventDetails.description);
      logger.child({ output }).error(`${prefix}[noCodefreshBuildOutput] no output from Codefresh for ${suffix}`);
      if (!hasOutput) throw Error('no output from Codefresh');
    }
    const codefreshBuildId = getCodefreshPipelineIdFromOutput(output);
    if (!codefreshBuildId) {
      metrics
        .increment('total', { error: 'error_with_pipeline', result: 'error', codefreshBuildId: '' })
        .event(eventDetails.title, eventDetails.description);
      throw Error('no returned from Codefresh');
    }
    metrics
      .increment('total', { error: '', result: 'complete', codefreshBuildId })
      .event(eventDetails.title, eventDetails.description);
    return codefreshBuildId;
  } catch (error) {
    logger.child({ error }).error(`${prefix} failed for ${suffix}`);
    throw error;
  }
};

export const getRepositoryTag = ({ tag, ecrRepo, ecrDomain }) => {
  const ecrRepoTag = constructEcrTag({ repo: ecrRepo, tag, ecrDomain });
  return ecrRepoTag;
};

export const checkPipelineStatus = (id: string) => async () => {
  await shellPromise(`codefresh wait ${id}`);
  const status: string = await shellPromise(`codefresh get build ${id} --output json | jq -r ".status"`);
  return Boolean(status?.includes('success'));
};

export const waitForImage = async (id: string, { timeoutMs = 180000, intervalMs = 10000 } = {}) => {
  try {
    const checkStatus = checkPipelineStatus(id);
    return await waitUntil(checkStatus, { timeoutMs, intervalMs });
  } catch (error) {
    return false;
  }
};

export const triggerPipeline = async (
  pipelineId: string,
  trigger: string,
  data: Record<string, string>
): Promise<string> => {
  const branch = data?.branch || data?.BRANCH;
  if (!branch) throw Error(`[triggerPipeline][WEBHOOK ${pipelineId}/${trigger}] webhook error: no "branch" env var.`);
  const variables = Object.keys(data)
    .map((key) => ` -v '${key}'='${data[key]}' `)
    .join(' ');
  const command = `codefresh run "${pipelineId}" -d -b "${branch}" --trigger "${trigger}" ${variables}`;
  const output = await shellPromise(command);
  const buildId = getCodefreshPipelineIdFromOutput(output);
  return buildId;
};

export function kubeContextStep({ context, cluster }: { context: string; cluster: string }) {
  let awsAccessKeyId = '${{DEPLOYMENT_AWS_ACCESS_KEY_ID}}';
  let awsSecretAccessKey = '${{DEPLOYMENT_AWS_SECRET_ACCESS_KEY}}';

  if (ENVIRONMENT === 'staging') {
    awsAccessKeyId = '${{STG_AWS_ACCESS_KEY_ID}}';
    awsSecretAccessKey = '${{STG_AWS_SECRET_ACCESS_KEY}}';
  }

  return {
    title: 'Set kube context',
    // this is a custom step setup to update kube context
    type: 'REPLACE_ME_IF_NEEDED/kube-context:0.0.2',
    arguments: {
      app: context,
      cluster,
      aws_access_key_id: awsAccessKeyId,
      aws_secret_access_key: awsSecretAccessKey,
    },
  };
}

export const getLogs = async (id: string) => {
  try {
    const command = `codefresh logs ${id}`;
    const output = await shellPromise(command);
    return output;
  } catch (error) {
    return error;
  }
};
