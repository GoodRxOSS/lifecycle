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
import { getLogger } from 'server/lib/logger';
import { generateCodefreshCmd, constructEcrTag, getCodefreshPipelineIdFromOutput } from 'server/lib/codefresh/utils';
import { waitUntil } from 'server/lib/utils';
import { ContainerBuildOptions } from 'server/lib/codefresh/types';
import { Metrics } from 'server/lib/metrics';
import { ENVIRONMENT } from 'shared/config';
import GlobalConfigService from 'server/services/globalConfig';

export const tagExists = async ({ tag, ecrRepo = 'lifecycle-deployments', uuid = '' }) => {
  const { lifecycleDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
  const repoName = ecrRepo;
  const registryId = (lifecycleDefaults.ecrDomain?.split?.('.') || [])[0] || '';
  try {
    const command = `aws ecr describe-images --repository-name=${repoName} --image-ids=imageTag=${tag} --no-paginate --no-cli-auto-prompt --registry-id ${registryId}`;
    await shellPromise(command);
    getLogger().info(`ECR: exists tag=${tag} repo=${repoName}`);
    return true;
  } catch (error) {
    getLogger().debug(`ECR: tag=${tag} not found in ${repoName}`);
    return false;
  }
};

export const buildImage = async (options: ContainerBuildOptions) => {
  const { repo: repositoryName, branch, uuid, revision: sha, tag } = options;
  const metrics = new Metrics('build.codefresh.image', { uuid, repositoryName, branch, sha });
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
      getLogger().error({ output }, `Codefresh: build output missing suffix=${suffix}`);
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
    getLogger().error({ error }, `Codefresh: build failed suffix=${suffix}`);
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
    getLogger().error({ error }, `Codefresh: waitForImage failed pipelineId=${id}`);
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

export async function kubeContextStep({ context, cluster }: { context: string; cluster: string }) {
  let awsAccessKeyId = '${{DEPLOYMENT_AWS_ACCESS_KEY_ID}}';
  let awsSecretAccessKey = '${{DEPLOYMENT_AWS_SECRET_ACCESS_KEY}}';

  if (ENVIRONMENT === 'staging') {
    awsAccessKeyId = '${{STG_AWS_ACCESS_KEY_ID}}';
    awsSecretAccessKey = '${{STG_AWS_SECRET_ACCESS_KEY}}';
  }
  const { app_setup } = await GlobalConfigService.getInstance().getAllConfigs();
  const gitOrg = (app_setup?.org && app_setup.org.trim()) || 'REPLACE_ME_ORG';
  return {
    title: 'Set kube context',
    // this is a custom step setup to update kube context
    type: `${gitOrg}/kube-context:0.0.2`,
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
    getLogger().error({ error }, `Codefresh: getLogs failed pipelineId=${id}`);
    return '';
  }
};
