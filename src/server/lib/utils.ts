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

import { execFile } from 'child_process';
import { promisify } from 'util';
import { GithubPullRequestActions, PullRequestStatus, FallbackLabels } from 'shared/constants';
import GlobalConfigService from 'server/services/globalConfig';
import { GenerateDeployTagOptions, WaitUntilOptions, EnableKillswitchOptions } from 'server/lib/types';

import { getLogger } from 'server/lib/logger/index';
import { ENVIRONMENT } from 'shared/config';

const execFilePromise = promisify(execFile);

export const exec = async (runner: string, cmd: string[], { execCmd = execFilePromise } = {}) => {
  try {
    const out = await execCmd(runner, cmd);
    return out?.stdout || '';
  } catch (err) {
    getLogger().error(`Exec: error executing runner=${runner} error=${JSON.stringify(err)}`);
    return '';
  }
};

/**
 * waitUntil ⏰
 * @description a utility function for waiting until a condition is met
 * @example basic: waitUntil(() => true, 1000, 100)
 * @example with args and currying;
 *  | const fn = (a,b) => () => a + b;
 *  | const ex = fn(a,b);
 *  | waitUntil(ex, 1000, 100);
 * @param conditionFunction function
 * @param timeoutMs number
 * @param intervalMs number
 * @returns void
 */
export const waitUntil = async (
  conditionFunction,
  {
    timeoutMs,
    intervalMs,
    // for testing
    setTimeoutFn = setTimeout,
    start = Date as DateConstructor,
    time = Date as DateConstructor,
  }: WaitUntilOptions
): Promise<unknown> => {
  const startTime = start.now();

  const checkCondition = async (resolve, reject): Promise<void> => {
    try {
      const result = await conditionFunction();
      const timeElapsed = time.now() - startTime;

      if (result) {
        resolve(result);
      } else if (timeElapsed < timeoutMs) {
        setTimeoutFn(checkCondition, intervalMs, resolve, reject);
      } else {
        reject(new Error('Timeout waiting for condition'));
      }
    } catch (error) {
      reject(error);
    }
  };

  return new Promise(checkCondition);
};

/**
 * Flattens and object and returns it in a format with dot notation
 * @param ob
 * @returns
 */
export function flattenObject(ob) {
  const toReturn = {};

  for (const i in ob) {
    // eslint-disable-next-line no-prototype-builtins
    if (!ob.hasOwnProperty(i)) {
      continue;
    }

    if (typeof ob[i] === 'object') {
      const flatObject = flattenObject(ob[i]);
      for (const x in flatObject) {
        // eslint-disable-next-line no-prototype-builtins
        if (!flatObject.hasOwnProperty(x)) {
          continue;
        }

        toReturn[i + '.' + x] = flatObject[x];
      }
    } else {
      toReturn[i] = ob[i];
    }
  }
  return toReturn;
}

export const generateDeployTag = ({ prefix = 'lfc', sha, envVarsHash }: GenerateDeployTagOptions) => {
  if (!sha) throw Error('[generateDeployTag]: branch and sha are required');
  const hashedVars = envVarsHash ? `-${envVarsHash}` : '';
  const tag = `${prefix}-${sha}${hashedVars}`;
  return tag;
};

export const constructEcrRepoPath = (
  baseEcrRepo: string,
  serviceName: string | undefined,
  ecrDomain: string
): string => {
  if (!baseEcrRepo || !serviceName) return baseEcrRepo || '';

  if (ecrDomain && ecrDomain.includes('ecr')) {
    return baseEcrRepo;
  }

  if (baseEcrRepo.endsWith(`/${serviceName}`)) {
    return baseEcrRepo;
  }

  return `${baseEcrRepo}/${serviceName}`;
};

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * enableKillswitch
 * @description Check for conditions which should stop a process; Lifecycle, Metrics, etc
 * @param {Object}
 * @returns {boolean}
 */
export const enableKillSwitch = async ({
  action = '',
  branch = '',
  fullName = '',
  isBotUser = false,
  labels = [],
  status = '',
}: Omit<EnableKillswitchOptions, 'logger'>) => {
  try {
    const isOpened = [GithubPullRequestActions.OPENED, GithubPullRequestActions.REOPENED].includes(
      action as GithubPullRequestActions
    );
    const isClosed = status === PullRequestStatus.CLOSED && !isOpened;
    const isDisabled = await hasDisabledLabel(labels);
    if (isClosed || isDisabled) {
      return true;
    }
    const isForceDeploy = await hasDeployLabel(labels);
    if (isForceDeploy) {
      return false;
    }

    if (isBotUser) {
      return true;
    }

    const configs = await GlobalConfigService.getInstance().getAllConfigs();
    const lifecycleIgnores = configs?.lifecycleIgnores;
    const github = lifecycleIgnores?.github;
    const events = github?.events;
    const branches = github?.branches;
    const organizations = github?.organizations;
    const owner = fullName?.split('/')?.[0];
    if (!events || !branches || !fullName || !owner) {
      throw Error('missing required configs to enable killswitch returning false');
    }
    // don't deploy when untracked github events are emitted (deleted, closed, etc)
    const isIgnore = events.includes(action);
    // don't deploy release branches
    const isReleaseBranch = branches.includes(branch);
    // don't deploy unauthorized organizations
    const isUnallowed = organizations.includes(owner?.toLowerCase());
    return isIgnore || isReleaseBranch || isUnallowed;
  } catch (error) {
    getLogger().warn(`Killswitch: error checking fullName=${fullName} branch=${branch} error=${error}`);
    return false;
  }
};

export const isStaging = () => {
  return ENVIRONMENT === 'staging';
};

/**
 * Check if PR has any deploy labels from configuration
 * @param labels Array of PR labels
 * @returns Promise<boolean> True if PR has deploy label
 */
export const hasDeployLabel = async (labels: string[]): Promise<boolean> => {
  if (!labels || labels.length === 0) return false;
  const labelsConfig = await GlobalConfigService.getInstance().getLabels();
  const deployLabels = labelsConfig.deploy || [];
  return deployLabels.some((deployLabel) => labels.includes(deployLabel));
};

/**
 * Check if PR has any disabled labels fr m configuration
 * @param labels Array of PR labels
 * @returns Promise<boolean> True if PR has disabled label
 */
export const hasDisabledLabel = async (labels: string[]): Promise<boolean> => {
  if (!labels || labels.length === 0) return false;
  const labelsConfig = await GlobalConfigService.getInstance().getLabels();
  const disabledLabels = labelsConfig.disabled || [];
  return disabledLabels.some((disabledLabel) => labels.includes(disabledLabel));
};

/**
 * Check if PR has any status comment labels from configuration
 * @param labels Array of PR labels
 * @returns Promise<boolean> True if PR has status comment label
 */
export const hasStatusCommentLabel = async (labels: string[]): Promise<boolean> => {
  if (!labels || labels.length === 0) return false;
  const labelsConfig = await GlobalConfigService.getInstance().getLabels();
  const statusCommentLabels = labelsConfig.statusComments || [];
  return statusCommentLabels.some((statusLabel) => labels.includes(statusLabel));
};

/**
 * Get the first deploy label from configuration for user-facing messages
 * @returns Promise<string> First deploy label from config
 */
export const getDeployLabel = async (): Promise<string> => {
  const labelsConfig = await GlobalConfigService.getInstance().getLabels();
  return labelsConfig?.deploy?.[0] || FallbackLabels.DEPLOY;
};

/**
 * Get the first disabled label from configuration for user-facing messages
 * @returns Promise<string> First disabled label from config
 */
export const getDisabledLabel = async (): Promise<string> => {
  const labelsConfig = await GlobalConfigService.getInstance().getLabels();
  return labelsConfig?.disabled?.[0] || FallbackLabels.DISABLED;
};

/**
 * Get the first keep label from configuration for user-facing messages
 * @returns Promise<string> First keep label from config
 */
export const getKeepLabel = async (): Promise<string> => {
  const labelsConfig = await GlobalConfigService.getInstance().getLabels();
  return labelsConfig?.keep?.[0] || FallbackLabels.KEEP;
};

/**
 * Get the first status comment label from configuration for user-facing messages
 * @returns Promise<string> First status comment label from config
 */
export const getStatusCommentLabel = async (): Promise<string> => {
  const labelsConfig = await GlobalConfigService.getInstance().getLabels();
  return labelsConfig?.statusComments?.[0] || FallbackLabels.STATUS_COMMENTS;
};

/**
 * Check if status comments should be enabled by default
 * @returns Promise<boolean> True if status comments are enabled by default
 */
export const isDefaultStatusCommentsEnabled = async (): Promise<boolean> => {
  const labelsConfig = await GlobalConfigService.getInstance().getLabels();
  return labelsConfig.defaultStatusComments ?? true;
};

/**
 * Check if control comments should be enabled
 * @returns Promise<boolean> True if control comments are enabled (defaults to true if not configured)
 */
export const isControlCommentsEnabled = async (): Promise<boolean> => {
  try {
    const labelsConfig = await GlobalConfigService.getInstance().getLabels();
    return labelsConfig.defaultControlComments ?? true;
  } catch (error) {
    getLogger().warn(`Config: error retrieving control comments config error=${error}`);
    return true;
  }
};
