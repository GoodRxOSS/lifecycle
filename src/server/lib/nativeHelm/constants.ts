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

export const HELM_TIMEOUT_MINUTES = 30;
export const HELM_JOB_TIMEOUT_SECONDS = HELM_TIMEOUT_MINUTES * 60;
export const STATIC_ENV_JOB_TTL_SECONDS = 86400; // 24 hours
export const DEFAULT_HELM_VERSION = '3.12.0';
export const HELM_IMAGE_PREFIX = 'alpine/helm';

export const REPO_MAPPINGS = {
  bitnami: 'https://charts.bitnami.com/bitnami',
  stable: 'https://charts.helm.sh/stable',
  incubator: 'https://charts.helm.sh/incubator',
  'prometheus-community': 'https://prometheus-community.github.io/helm-charts',
  grafana: 'https://grafana.github.io/helm-charts',
};

/* eslint-disable no-unused-vars */
export enum ChartType {
  PUBLIC = 'public',
  ORG_CHART = 'org',
  LOCAL = 'local',
}
/* eslint-enable no-unused-vars */
