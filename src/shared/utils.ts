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

import Redis from 'ioredis';
import Redlock from 'redlock';
import Database from 'server/database';
import { Deploy } from 'server/models';
import Fastly from 'server/lib/fastly';
import { Link, FeatureFlags } from 'shared/types';
import { DD_URL, DD_LOG_URL } from 'shared/constants';
import { getLogger } from 'server/lib/logger';
import Model from 'server/models/_Model';

/**
 * determineIfFastlyIsUsed
 * @description determines if fastly is used in a given deploy
 * @param deploy class a partial class used to determine if fastly is used
 * @returns boolean
 */
export const determineIfFastlyIsUsed = (deploy: Partial<Deploy>[] = []) =>
  deploy && deploy.length >= 1
    ? deploy.some(({ active = null, uuid = '' } = {}) => active && uuid.includes('fastly'))
    : false;

/**
 * constructUrl
 * @description constructs a url from a given url and params
 * @param url
 * @param params
 * @returns string
 */
export const constructUrl = (url: string, params: Record<string, string>[]) => {
  const urlObj = new URL(url);
  if (params) params.forEach(({ name, value } = {}) => name && value && urlObj.searchParams.append(name, value));
  return urlObj.href;
};

/**
 * processLinks
 * @description processes links for a given build id
 * @param buildId
 * @returns
 */
export const processLinks = (buildId: string = '') =>
  buildId.length >= 1
    ? [
        {
          name: 'Fastly Logs',
          url: constructUrl(DD_LOG_URL, [
            {
              name: 'query',
              value: `source:fastly @request.host:*${buildId}*`,
            },
            { name: 'paused', value: 'false' },
          ]),
        },
        {
          name: 'Lifecycle Env Logs',
          url: constructUrl(DD_LOG_URL, [
            { name: 'query', value: `env:lifecycle-${buildId}` },
            { name: 'paused', value: 'false' },
          ]),
        },
        {
          name: 'Serverless',
          url: constructUrl(`${DD_URL}/functions`, [
            { name: 'text_search', value: `env:*${buildId}*` },
            { name: 'paused', value: 'false' },
          ]),
        },
        {
          name: 'Tracing',
          url: constructUrl(`${DD_URL}/apm/traces`, [
            { name: 'query', value: `env:*${buildId}*` },
            { name: 'paused', value: 'false' },
          ]),
        },
        {
          name: 'RUM (If Enabled)',
          url: constructUrl(`${DD_URL}/rum/explorer`, [
            { name: 'query', value: `env:*${buildId}*` },
            { name: 'live', value: 'true' },
          ]),
        },
        {
          name: 'Containers',
          url: constructUrl(`${DD_URL}/containers`, [
            { name: 'query', value: `env:lifecycle-${buildId}` },
            { name: 'paused', value: 'false' },
          ]),
        },
      ]
    : [];

/**
 * constructLinkDictionary
 * @description constructs a dictionary of links
 * @param links an array of Link objects
 * @returns a dictionary of links
 */
export const constructLinkDictionary = (links: Link[] = []) =>
  links.reduce((acc, { name = '', url = '' }: Link) => ({ ...acc, [name]: url }), {});

/**
 * constructLinkRow
 * @description constructs a link row
 * @param links
 * @returns
 */
export const constructLinkRow = (links: Link[] = []) =>
  links.reduce((acc, { name = '', url = '' }: Link) => `${acc}| ${name} | ${url} |\n`, '');

/**
 * constructLinkTable
 * @description constructs a markdown table of links
 * @param links
 * @returns a string markdown table
 */
export const constructLinkTable = (links: Link[] = []) =>
  `<details>\n<summary>Dashboards</summary>\n\n| | Links |\n| --- | --- |\n${constructLinkRow(links)}</details>\n`;

/**
 * constructFastlyBuildLink
 * @description constructs a link item or empty array
 * @param fastlyBuildId string
 * @param fastlyFn fn
 * @returns an array item or empty array
 */
export const constructFastlyBuildLink = async (
  fastlyBuildId: string,
  fastlyServiceType: string,
  fastlyFn: Fastly['getServiceDashboardUrl']
) => {
  try {
    const { href: url = '' } = (await fastlyFn(fastlyBuildId, fastlyServiceType)) || {};
    return url ? { name: 'Fastly Dashboard', url } : {};
  } catch (err) {
    getLogger().error({ error: err }, 'Fastly: build link construction failed');
    return {};
  }
};

/**
 * constructBuildLinks
 * @param buildId
 * @returns a dictionary of dashboard links
 */
export const constructBuildLinks = (buildId: string = '') =>
  buildId.length >= 1 ? constructLinkDictionary(processLinks(buildId)) : {};

/**
 * insertBuildLink
 * @description inserts a build link into a dictionary of build links
 * @param buildLinks dictionary of build links
 * @param name string
 * @param href string
 * @returns disctionary of build links
 */
export const insertBuildLink = (buildLinks: Record<string, string>, name: string, href: string) => ({
  ...buildLinks,
  [name]: href,
});

/**
 *determineFeatureStatus
 * @description determines if a feature is enabled or not
 * @param {string} featureFlag, the name of the featureFlag
 * @param {object} featureFlags
 * @returns {string|boolean}
 */
export const determineFeatureFlagStatus = (featureFlag: string, featureFlags = {}): string | boolean => {
  const featureList = Object.keys(featureFlags);
  if (featureList.length === 0) return false;
  const feature = featureList.find((feature) => feature === featureFlag);
  if (!feature) return false;
  return featureFlags?.[featureFlag];
};

/**
 * enableService
 * @description enables a service if a feature flag is enabled
 * @param {class} svc, the service to be enabled
 * @param {class} db, the database class
 * @param {class} redis, the redis class
 * @param {class} redlock, the redlock class
 * @param {boolean} hasFeatureFlag, does the flag exist
 * @returns {class} new svc class
 */
export const enableService = (svc, db: Database, redis: Redis.Redis, redlock: Redlock) => new svc(db, redis, redlock);

/**
 * determineBuildFeatureFlagValue
 * @description determines the value for a given feature flag considering it's values in the service heirarchy
 * @param {string} featureFlag a feature flag to be evaluated
 * @param {object} featureFlags a record of feature flags
 * @returns {boolean} featureFlag value
 */
export const determineFeatureFlagValue = (featureFlag = '', featureFlags: FeatureFlags = {}) =>
  featureFlags?.[featureFlag] === true;

/**
 * mergeKeyValueArrays
 * @description merges two arrays of key value pairs into a single array of key value pairs
 * @param {string[]} baseArray default [] - baseArray an array of key value pairs
 * @param {string[]} overwriteArray default [] - an array of key value pairs
 * @param {string} delimiter the delimiter used to split the key value pairs
 */
export const mergeKeyValueArrays = (
  baseArray: string[] = [],
  overwriteArray: string[] = [],
  delimiter: string
): string[] => {
  function arrayToObj(arr: string[]) {
    return arr.reduce((acc, item) => {
      const [key, value] = item.split(delimiter);
      if (value !== undefined) {
        acc[key] = value;
      }
      return acc;
    }, {});
  }
  const obj1 = arrayToObj(baseArray);
  const obj2 = arrayToObj(overwriteArray);
  const mergedObj = { ...obj1, ...obj2 };

  return Object.entries(mergedObj).map(([key, value]) => `${key}${delimiter}${value}`);
};

export const getResourceType = (resource: string) => {
  const resourceType = resource || 'deployment';
  return resourceType.toLowerCase();
};

export interface PatternInfo {
  pattern: string;
  envKey: string;
}

/**
 * Extracts build dependencies from environment variables
 * @param env Environment variables from deploy.deployables.env
 * @returns Map of dependent services and their regex patterns
 */
export const extractEnvVarsWithBuildDependencies = (env: Record<string, string>): Record<string, PatternInfo[]> => {
  const dependencies: Record<string, PatternInfo[]> = {};
  const buildOutputPattern = /{{{?([^{}]+)\.buildOutput\((.*?)\)}}}?/g;

  for (const [key, value] of Object.entries(env)) {
    const matches = typeof value === 'string' && value.trim() ? Array.from(value.matchAll(buildOutputPattern)) : [];

    for (const match of matches) {
      const serviceName = match[1];
      const regexPattern = match[2];

      if (!dependencies[serviceName]) {
        dependencies[serviceName] = [];
      }

      const patternInfo: PatternInfo = {
        pattern: regexPattern,
        envKey: key,
      };

      dependencies[serviceName].push(patternInfo);
    }
  }

  return dependencies;
};

/**
 * Waits for a specified property on a model to have a non-falsy value
 *
 * This function repeatedly checks a model property by reloading the model from
 * the database at a specified interval until the property has a value or
 * maximum attempts are reached.
 *
 * @param model - The database model instance to monitor
 * @param propertyName - The name of the property to check
 * @param maxAttempts - Optional maximum number of polling attempts (default: 250)
 * @param intervalMs - Optional polling interval in milliseconds (default: 5000)
 *
 * @returns The updated model if the property has a value, null if timed out
 *
 * @example
 * // Wait for a build pipeline ID to be available
 * const deploy = await waitForColumnValue(deployItem, 'buildPipelineId');
 * if (deploy) {
 *   console.log(`Pipeline ID is available: ${deploy.buildPipelineId}`);
 * } else {
 *   console.log('Timed out waiting for pipeline ID');
 * }
 *
 * @example
 * // Custom polling interval and max attempts
 * const user = await waitForColumnValue(userModel, 'emailVerifiedAt', 100, 10000);
 */
export async function waitForColumnValue<T extends Model, K extends keyof T>(
  model: T,
  propertyName: K,
  maxAttempts = 250,
  intervalMs = 5000
): Promise<T | null> {
  let attempts = 0;

  while (!model[propertyName] && attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    await model.reload();
    attempts++;
  }

  return model[propertyName] ? model : null;
}
