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

import { spawn } from 'child_process';
import { shellPromise } from 'server/lib/shell';
import { getLogger } from 'server/lib/logger';
import { generateCodefreshCmd, constructEcrTag, getCodefreshPipelineIdFromOutput } from 'server/lib/codefresh/utils';
import { waitUntil } from 'server/lib/utils';
import { ContainerBuildOptions } from 'server/lib/codefresh/types';
import { Metrics } from 'server/lib/metrics';
import { ENVIRONMENT } from 'shared/config';
import GlobalConfigService from 'server/services/globalConfig';

export const tagExists = async ({ tag, ecrRepo = 'lifecycle-deployments', uuid: _uuid = '' }) => {
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
  let awsAccessKeyId = '${{AWS_ACCESS_KEY_ID_LFC_PRD}}';
  let awsSecretAccessKey = '${{AWS_SECRET_ACCESS_KEY_LFC_PRD}}';

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

// Typed result so callers can tell "fetched (maybe empty)" from "fetch failed".
export type GetLogsResult = { ok: true; output: string; truncatedAtSource: boolean } | { ok: false; reason: string };

const LOG_FETCH_KEEP_TAIL_BYTES = 24 * 1024 * 1024;
const LOG_FETCH_TIMEOUT_MS = 180_000;

// spawn with an arg array (no shell) and a bounded tail buffer: oversized logs
// degrade to "kept the last 24MB" instead of failing at exec's maxBuffer.
export const getLogsResult = async (id: string): Promise<GetLogsResult> => {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: GetLogsResult) => {
      if (settled) return;
      settled = true;
      if (result.ok === false) {
        getLogger().error({ reason: result.reason }, `Codefresh: getLogs failed pipelineId=${id}`);
      }
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('codefresh', ['logs', id]);
    } catch (error) {
      settle({ ok: false, reason: error instanceof Error ? error.message : String(error) });
      return;
    }

    const chunks: Buffer[] = [];
    let bufferedBytes = 0;
    let droppedHead = false;
    let stderrTail = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, LOG_FETCH_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      bufferedBytes += chunk.length;
      while (chunks.length > 1 && bufferedBytes - chunks[0].length >= LOG_FETCH_KEEP_TAIL_BYTES) {
        bufferedBytes -= chunks.shift()!.length;
        droppedHead = true;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      settle({ ok: false, reason: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        settle({ ok: false, reason: `codefresh logs timed out after ${LOG_FETCH_TIMEOUT_MS / 1000}s` });
        return;
      }
      if (code !== 0) {
        settle({ ok: false, reason: `codefresh logs exited with code ${code}${stderrTail ? `: ${stderrTail}` : ''}` });
        return;
      }
      settle({ ok: true, output: Buffer.concat(chunks).toString('utf8'), truncatedAtSource: droppedHead });
    });
  });
};

// Back-compat string wrapper: failures collapse to '' (existing deploy.ts behavior).
export const getLogs = async (id: string): Promise<string> => {
  const result = await getLogsResult(id);
  return result.ok ? result.output : '';
};
