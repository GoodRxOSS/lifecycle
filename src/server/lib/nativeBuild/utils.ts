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

import { shellPromise } from '../shell';
import rootLogger from '../logger';
import { randomAlphanumeric } from '../random';
import Deploy from 'server/models/Deploy';
import GlobalConfigService from 'server/services/globalConfig';
import { TMP_PATH } from 'shared/config';
import fs from 'fs';

const logger = rootLogger.child({
  filename: 'lib/shared/utils.ts',
});

export const MANIFEST_PATH = `${TMP_PATH}/build`;
export const BACKOFF_LIMIT = 0;
export const MAX_WAIT_TIME = 25 * 60 * 1000;
export const GIT_USERNAME = 'x-access-token';
export const JOB_TTL = 86400; // 24 hours
export const JOB_NAMESPACE = 'lifecycle-app';

export interface BuildOptions {
  tag: string;
  ecrDomain: string;
  namespace?: string;
  initTag?: string;
}

export interface JobResult {
  completed: boolean;
  logs: string;
  status: string;
}

export function createCloneScript(repo: string, branch: string, revision?: string, repoName?: string): string {
  const actualRepoName = repoName || repo.split('/')[1];

  return `
REPO_DIR="/workspace/repo-${actualRepoName}"
echo "Volumee space:\n$(df -h /workspace)"
echo "Cached workspace size: $(du -sh /workspace | cut -f1)"

if [ ! -d "$REPO_DIR" ]; then
  echo "Cloning repository into $REPO_DIR"
  git clone --depth=1 --single-branch -b ${branch} https://$GIT_USERNAME:$GIT_PASSWORD@github.com/${repo}.git $REPO_DIR
  ${revision ? `cd $REPO_DIR && git checkout ${revision}` : ''}
else
  echo "Repository already exists. Updating to the latest."
  cd $REPO_DIR
  git fetch origin
  git checkout ${branch} &&
  git pull --ff-only origin ${branch} || git reset --hard origin/${branch}
fi
`.trim();
}

// Generic function to create a job
export function createJob(
  name: string,
  namespace: string,
  gitUsername: string,
  gitToken: string,
  cloneScript: string,
  containers: any[],
  volumeConfig: any
): any {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace,
    },
    spec: {
      backoffLimit: BACKOFF_LIMIT,
      ttlSecondsAfterFinished: JOB_TTL,
      template: {
        spec: {
          serviceAccountName: 'runtime-sa',
          // Resasonable grace period for container builds to avoid overly disruptive terminations.
          terminationGracePeriodSeconds: 600,
          tolerations: [
            {
              key: 'builder',
              operator: 'Equal',
              value: 'yes',
              effect: 'NoSchedule',
            },
          ],
          ...(cloneScript
            ? {
                initContainers: [
                  {
                    name: 'clone-repo',
                    image: 'alpine/git:latest',
                    env: [
                      {
                        name: 'GIT_USERNAME',
                        value: gitUsername,
                      },
                      {
                        name: 'GIT_PASSWORD',
                        value: gitToken,
                      },
                    ],
                    command: ['/bin/sh', '-c'],
                    args: [cloneScript],
                    volumeMounts: [
                      {
                        name: volumeConfig.workspaceName,
                        mountPath: '/workspace',
                      },
                    ],
                  },
                ],
              }
            : {}),
          containers,
          restartPolicy: 'Never',
          volumes: volumeConfig.volumes,
        },
      },
    },
  };
}

/**
 * Helper function to wait for a job to complete and get its logs
 */
export async function waitForJobAndGetLogs(
  jobName: string,
  namespace: string = JOB_NAMESPACE,
  logPrefix: string,
  containerPrefixes: string[]
): Promise<JobResult> {
  logger.info(`${logPrefix} Waiting for job ${jobName} to complete...`);

  // let jobCompleted = false;
  let podName = '';

  const jobResult: JobResult = { completed: false, logs: '', status: '' };
  const startWaitTime = Date.now();

  while (!jobResult.completed && Date.now() - startWaitTime < MAX_WAIT_TIME) {
    const jobStatus = await shellPromise(`kubectl get job ${jobName} -n ${namespace} -o jsonpath='{.status}'`);
    const jobStatusObj = JSON.parse(jobStatus);

    if (jobStatusObj.succeeded) {
      jobResult.completed = true;
      jobResult.status = 'succeeded';
      logger.info(`${logPrefix} Job ${jobName} completed successfully`);
    } else if (jobStatusObj.failed && jobStatusObj.failed >= BACKOFF_LIMIT) {
      jobResult.completed = true;
      logger.error(`${logPrefix} Job ${jobName} failed after retries`);
    }

    if (!jobResult.completed) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  if (!jobResult.completed) {
    logger.warn(`${logPrefix} Timed out waiting for job ${jobName} to complete`);
    jobResult.completed = false;
    jobResult.status = 'timeout';
    jobResult.logs = `Timed out waiting for job ${jobName} to complete after ${Math.floor(
      (Date.now() - startWaitTime) / 1000 / 60
    )} minutes`;

    return jobResult;
  }

  const podsOutput = await shellPromise(
    `kubectl get pods -n ${namespace} -l job-name=${jobName} -o jsonpath='{.items[0].metadata.name}'`
  );
  podName = podsOutput.trim();

  // let combinedLogs = '';

  if (podName) {
    try {
      const cloneLogs = await shellPromise(`kubectl logs -n ${namespace} ${podName} -c clone-repo`);
      jobResult.logs += `--- CLONE CONTAINER ---\n${cloneLogs}\n\n`;
    } catch (error) {
      logger.warn(`${logPrefix} Error getting logs from clone-repo container: ${error}`);
    }

    // Get logs from all relevant containers
    for (const prefix of containerPrefixes) {
      try {
        const containerList = await shellPromise(
          `kubectl get pod ${podName} -n ${namespace} -o jsonpath='{.spec.containers[*].name}'`
        );

        const mainContainerName = `${prefix}-main`;
        if (containerList.includes(mainContainerName)) {
          const mainContainerLogs = await shellPromise(
            `kubectl logs -n ${namespace} ${podName} -c ${mainContainerName}`
          );
          jobResult.logs += `--- MAIN CONTAINER ---\n${mainContainerLogs}\n\n`;
        }

        const initContainerName = `${prefix}-init`;
        if (containerList.includes(initContainerName)) {
          const initContainerLogs = await shellPromise(
            `kubectl logs -n ${namespace} ${podName} -c ${initContainerName}`
          );
          jobResult.logs += `--- INIT CONTAINER ---\n${initContainerLogs}`;
        }
      } catch (error) {
        logger.warn(`${logPrefix} Error getting logs from ${prefix} containers: ${error}`);
      }
    }

    logger.info(`${logPrefix} Retrieved logs from pod ${podName}`);
  } else {
    logger.warn(`${logPrefix} Could not find pod for job ${jobName}`);
  }

  return jobResult;
}

/**
 * Generic build function for applying manifests and getting results
 */
export async function buildImage(
  deploy: Deploy,
  options: BuildOptions,
  // eslint-disable-next-line no-unused-vars
  manifestGenerator: (deploy: Deploy, jobId: string, options: BuildOptions) => Promise<string>,
  buildEngine: string
): Promise<JobResult> {
  await deploy.$fetchGraph('repository');

  const repositoryName = deploy.repository.fullName;
  const branch = deploy.branchName;
  const uuid = deploy.build.uuid;
  const sha = deploy.sha;
  const prefix = uuid ? `[DEPLOY ${uuid}][build${buildEngine}]:` : `[DEPLOY][build${buildEngine}]:`;
  const suffix = `${repositoryName}/${branch}:${sha}`;
  const buildStartTime = Date.now();

  const jobId = randomAlphanumeric(4).toLowerCase();

  try {
    logger.info(`${prefix} Generating ${buildEngine} manifest for ${suffix}`);
    const manifest = await manifestGenerator(deploy, jobId, options);

    const shortSha = deploy.sha.substring(0, 7);
    let buildJobName = `${deploy.uuid}-${buildEngine.toLowerCase()}-${jobId}-${shortSha}`.substring(0, 63);
    if (buildJobName.endsWith('-')) {
      buildJobName = buildJobName.slice(0, -1);
    }

    const localPath = `${MANIFEST_PATH}/${buildEngine.toLowerCase()}/${deploy.uuid}-pr-${
      deploy.build.pullRequest.pullRequestNumber
    }-build-${shortSha}`;
    await fs.promises.mkdir(`${MANIFEST_PATH}/${buildEngine.toLowerCase()}/`, {
      recursive: true,
    });
    await fs.promises.writeFile(localPath, manifest, 'utf8');

    await shellPromise(`kubectl apply -f ${localPath}`);

    await deploy.$query().patchAndFetch({ buildJobName });
    const jobResult = await waitForJobAndGetLogs(buildJobName, options.namespace || JOB_NAMESPACE, prefix, [
      buildEngine.toLowerCase(),
    ]);

    const buildEndTime = Date.now();
    const buildDuration = buildEndTime - buildStartTime;
    logger
      .child({
        build: {
          duration: buildDuration,
          uuid,
          service: deploy?.deployable?.name,
        },
      })
      .info(`${prefix} ${buildEngine} build completed in ${buildDuration}ms (${(buildDuration / 1000).toFixed(2)}s)`);

    await deploy.$query().patch({ buildOutput: jobResult.logs });

    return jobResult;
  } catch (error) {
    const buildEndTime = Date.now();
    const buildDuration = buildEndTime - buildStartTime;
    logger
      .child({
        error,
        buildDuration: `${buildDuration}ms (${(buildDuration / 1000).toFixed(2)}s)`,
      })
      .error(`${prefix} failed for ${suffix}`);
    throw error;
  }
}

export async function getGitHubToken(): Promise<string> {
  return await GlobalConfigService.getInstance().getGithubClientToken();
}

export function generateJobName(deploy: Deploy, buildTool: string, jobId: string): string {
  const shortSha = deploy.sha.substring(0, 7);
  return `${deploy.uuid}-${buildTool.toLowerCase()}-${shortSha}-${jobId}`;
}

export function constructBuildArgs(envVars: Record<string, string>): string[] {
  return Object.entries(envVars).map(([key, value]) => `${key}=${value}`);
}
