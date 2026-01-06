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

/* eslint-disable no-unused-vars */
export enum DeployTypes {
  DOCKER = 'docker',
  GITHUB = 'github',
  EXTERNAL_HTTP = 'externalHTTP',
  AURORA_RESTORE = 'aurora-restore',
  CODEFRESH = 'codefresh',
  CONFIGURATION = 'configuration',
  HELM = 'helm',
}

export const DEPLOY_TYPES = [
  'docker',
  'github',
  'externalHttp',
  'auroraRestore',
  'rdsRestore',
  'codefresh',
  'configuration',
  'helmChart',
];

export const DEPLOY_TYPES_DICTIONARY = {
  docker: 'docker',
  github: 'github',
  extneralHttp: 'externalHttp',
  auroraRestore: 'auroraRestore',
  rdsRestore: 'rds-restore',
  codefresh: 'codefresh',
  configuration: 'configuration',
  helmChart: 'helmChart',
};

export const HelmDeployTypes = new Set([DeployTypes.HELM]);

export const CLIDeployTypes = new Set([DeployTypes.AURORA_RESTORE, DeployTypes.CODEFRESH]);

export const KubernetesDeployTypes = new Set([DeployTypes.DOCKER, DeployTypes.GITHUB]);

export enum DiskAccessMode {
  READ_WRITE_ONCE = 'ReadWriteOnce',
  READ_ONLY_MANY = 'ReadOnlyMany',
  READ_WRITE_MANY = 'ReadWriteMany',
  READ_WRITE_ONCE_POD = 'ReadWriteOncePod',
}

export enum BuildStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  BUILDING = 'building',
  DEPLOYING = 'deploying',
  BUILT = 'built',
  DEPLOYED = 'deployed',
  TEARING_DOWN = 'tearing_down',
  TORN_DOWN = 'torn_down',
  ERROR = 'error',
  CONFIG_ERROR = 'config_error',
}

export enum PullRequestStatus {
  OPEN = 'open',
  CLOSED = 'closed',
}

export enum DeployStatus {
  CLONING = 'cloning',
  BUILDING = 'building',
  BUILT = 'built',
  READY = 'ready',
  ERROR = 'error',
  QUEUED = 'queued',
  PENDING = 'pending',
  TORN_DOWN = 'torn_down',
  DEPLOYING = 'deploying',
  WAITING = 'waiting',
  BUILD_FAILED = 'build_failed',
  DEPLOY_FAILED = 'deploy_failed',
}

export enum GithubWebhookTypes {
  PULL_REQUEST = 'pull_request',
  INTEGRATION_INSTALLATION = 'integration_installation',
  PUSH = 'push',
  LABELED = 'labeled',
  UNLABELED = 'unlabeled',
  ISSUE_COMMENT = 'issue_comment',
}

export enum GithubPullRequestActions {
  OPENED = 'opened',
  REOPENED = 'reopened',
  EDITED = 'edited',
  CLOSED = 'closed',
  SYNCHRONIZE = 'synchronize',
}

// TTL Cleanup defaults
export const DEFAULT_TTL_INACTIVITY_DAYS = 14;
export const DEFAULT_TTL_CHECK_INTERVAL_MINUTES = 240; // 4 hours

export enum CommentParser {
  HEADER = `----EDIT BELOW THIS LINE----`,
  FOOTER = `----EDIT ABOVE THIS LINE----`,
}

export enum FallbackLabels {
  DEPLOY = 'lifecycle-deploy!',
  DISABLED = 'lifecycle-disabled!',
  KEEP = 'lifecycle-keep!',
  DEPLOY_STG = 'lifecycle-stg-deploy!',
  STATUS_COMMENTS = 'lifecycle-status-comments!',
}

export enum FeatureFlags {
  // if enabled will not set defaultUUID for services that are not checked or don't exisit in the environment
  NO_DEFAULT_ENV_RESOLVE = 'no-default-env-resolve',
}

export enum CAPACITY_TYPE {
  ON_DEMAND = 'ON_DEMAND',
  SPOT = 'SPOT',
}

export enum MEDIUM_TYPE {
  EBS = 'EBS',
  MEMORY = 'MEMORY',
  DISK = 'DISK',
}

export const NO_DEFAULT_ENV_UUID = 'lc-service-disabled';

export const DD_URL = 'https://app.datadoghq.com';
export const DD_LOG_URL = `${DD_URL}/logs`;

export const GITHUB_QUEUE_OPTIONS = {
  defaultJobOptions: {
    attempts: 1,
    timeout: 3600000,
    removeOnComplete: true,
    removeOnFail: true,
  },
  settings: {
    maxStalledCount: 0,
  },
};

export const HYPHEN_REPLACEMENT = '______';
export const HYPHEN_REPLACEMENT_REGEX = /______/g;

// 10 minutes
export const GITHUB_API_CACHE_EXPIRATION_SECONDS = 60 * 10;

export const GITHUB_API_CACHE_EXPIRATION_HOUR = 60 * 60;

export enum Features {
  namespace = 'namespace',
}
