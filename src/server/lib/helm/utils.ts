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

import { Build, Deploy } from 'server/models';
import { BuildEnvironmentVariables } from '../buildEnvVariables';
import Database from 'server/database';
import mustache from 'mustache';
import { HYPHEN_REPLACEMENT, HYPHEN_REPLACEMENT_REGEX } from 'shared/constants';
import { NodeAffinity, Toleration } from './types';
import { LIFECYCLE_UI_HOSTHAME_WITH_SCHEME, APP_HOST } from 'shared/config';

export const renderTemplate = async (build: Build, values: string[] = []): Promise<string[]> => {
  const db = build.$knex();
  const envVars = new BuildEnvironmentVariables(db as unknown as Database);
  const availableEnvVars = await envVars.availableEnvironmentVariablesForBuild(build);

  const joinedValues = values.join('%%SPLIT%%');
  const processedValues = joinedValues.replace(/-/g, HYPHEN_REPLACEMENT);
  const renderedString = mustache.render(processedValues, availableEnvVars);

  return renderedString.replace(HYPHEN_REPLACEMENT_REGEX, '-').split('%%SPLIT%%');
};

export function generateTolerationsCustomValues(key: string, tolerations: Toleration[]): string[] {
  return tolerations
    .map((toleration, index) => {
      return [
        `${key}[${index}].key=${toleration.key}`,
        `${key}[${index}].operator=${toleration.operator}`,
        `${key}[${index}].value=${toleration.value}`,
        `${key}[${index}].effect=${toleration.effect}`,
      ];
    })
    .flat();
}

export function generateNodeAffinityCustomValues(key: string, nodeAffinity: NodeAffinity): string[] {
  return nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.flatMap((term, termIndex) => {
    return term.matchExpressions.flatMap((expression, expressionIndex) => {
      const expressionValues = expression.values.map(
        (value, valueIndex) =>
          `${key}.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[${termIndex}].matchExpressions[${expressionIndex}].values[${valueIndex}]=${value}`
      );

      return [
        `${key}.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[${termIndex}].matchExpressions[${expressionIndex}].key=${expression.key}`,
        `${key}.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[${termIndex}].matchExpressions[${expressionIndex}].operator=${expression.operator}`,
        ...expressionValues,
      ];
    });
  });
}

export function generateNodeSelector(key: string, nodeSelector: string): string {
  return `${key}.app-long=${nodeSelector}`;
}

export interface BannerOptions {
  label: string;
  value: string;
  url?: string;
}

/**
 * Creates a single window.LFC_BANNER array containing all banner items.
 * Each item in the array contains label, value, and optional url properties.
 *
 * For example:
 * createBannerVars([
 *   { label: "sha", value: "abc123" },
 *   { label: "pr", value: "#123", url: "https://example.com" }
 * ]);
 *
 * produces:
 * window.LFC_BANNER = [
 *   { "label": "sha", "value": "abc123" },
 *   { "label": "pr", "value": "#123", "url": "https://example.com" }
 * ];
 */
export function createBannerVars(options: BannerOptions[], deploy: Deploy): string {
  const bannerItems = options.map(({ label, value, url }) => ({
    label: label.toLowerCase(),
    value,
    ...(url && { url }),
  }));

  const uuid = deploy?.build?.uuid || '';
  const serviceName = deploy?.deployable?.name || '';
  const deployStatus = deploy?.status || '';
  const createdAt = deploy?.build?.createdAt || '';

  return [
    `window.LFC_BANNER = ${JSON.stringify(bannerItems)};`,
    `window.LFC_UUID = "${uuid}";`,
    `window.LFC_SERVICE_NAME = "${serviceName}";`,
    `window.LFC_BASE_URL = "${APP_HOST}";`,
    `window.LFC_DEPLOY_STATUS = "${deployStatus}";`,
    `window.LFC_CREATED_AT = "${createdAt}";`,
    `window.LFC_DASHBOARD_URL = "${LIFECYCLE_UI_HOSTHAME_WITH_SCHEME}/build/${uuid}";`,
  ].join('\n');
}

export function ingressBannerSnippet(deploy: Deploy) {
  const uuid = deploy?.build?.uuid;
  const { pullRequest } = deploy.build;
  const { pullRequestNumber } = pullRequest;

  const bannerVars: string = createBannerVars(
    [
      {
        label: 'UUID',
        value: uuid || '',
        url: `${LIFECYCLE_UI_HOSTHAME_WITH_SCHEME}/build/${uuid}`,
      },
      {
        label: 'PR Owner',
        value: deploy.build.pullRequest.githubLogin || '',
      },
      {
        label: 'PR',
        value: `#${pullRequestNumber}` || '',
        url: `https://github.com/${pullRequest.fullName}/pull/${pullRequestNumber}`,
      },
      {
        label: 'sha',
        value: deploy.sha || '',
      },
      {
        label: 'Branch',
        value: deploy.branchName || '',
      },
      {
        label: 'Service Name',
        value: deploy.deployable.name || '',
      },
      {
        label: 'Build',
        value: 'Logs',
        url: deploy.buildLogs,
      },
    ],
    deploy
  );

  const inlineScript = `<script type="text/javascript">${bannerVars}</script>`;
  const baseUrl = APP_HOST;
  const externalScript = `<script type="text/javascript" src="${baseUrl}/utils/0-banner.js" defer></script>`;
  const fullSnippet = `${externalScript}${inlineScript}`;
  const configSnippet = [
    'proxy_set_header Accept-Encoding "";',
    'sub_filter "</head>" \'' + fullSnippet + "</head>';",
    'sub_filter_once off;',
    'sub_filter_types text/html;',
  ].join('\n');

  return {
    metadata: {
      annotations: {
        'nginx.ingress.kubernetes.io/configuration-snippet': configSnippet,
      },
    },
  };
}
