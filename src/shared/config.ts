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

import 'dotenv/config';
import getConfig from 'next/config';
import { serverRuntimeConfig as fallbackServerRuntimeConfig } from '../../next.config';

let serverRuntimeConfig: Record<string, any> | null = null;

/* There are some situations where getConfig is not initialized because of how next works */
if (getConfig() === undefined) {
  serverRuntimeConfig = fallbackServerRuntimeConfig;
} else {
  serverRuntimeConfig = getConfig().serverRuntimeConfig;
}

const getServerRuntimeConfig = (key: string, fallback?: any): any => {
  return getProp(serverRuntimeConfig!, key, fallback);
};

const getProp = (config: Record<string, any>, key: string, fallback?: any): any => {
  const value = config[key];
  if (value !== undefined && value !== null) {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }

  if ('yes' === process.env.BUILD_MODE) return '';

  throw new Error(`Required config missing: '${key}'`);
};

export const APP_ENV = getServerRuntimeConfig('APP_ENV', 'development');
export const IS_PROD = APP_ENV === 'production';
export const IS_STG = APP_ENV === 'staging';
export const IS_DEV = APP_ENV !== 'production';
export const TMP_PATH = `/tmp/lifecycle`;

/**
 * @deprecated Use individual APP_DB_* environment variables instead (APP_DB_HOST, APP_DB_USER, APP_DB_PASSWORD, APP_DB_NAME). This will be removed in future releases.
 */
export const DATABASE_URL = getServerRuntimeConfig('DATABASE_URL');

export const APP_DB_HOST = getServerRuntimeConfig('APP_DB_HOST', '');
export const APP_DB_PORT = getServerRuntimeConfig('APP_DB_PORT', 5432);
export const APP_DB_USER = getServerRuntimeConfig('APP_DB_USER', 'lifecycle');
export const APP_DB_PASSWORD = getServerRuntimeConfig('APP_DB_PASSWORD', 'lifecycle');
export const APP_DB_NAME = getServerRuntimeConfig('APP_DB_NAME', '');
export const APP_DB_SSL = getServerRuntimeConfig('APP_DB_SSL', '');

export const LIFECYCLE_UI_HOSTHAME_WITH_SCHEME = getServerRuntimeConfig(
  'LIFECYCLE_UI_HOSTHAME_WITH_SCHEME',
  'REPLACE_ME_WITH_UI_URL'
);

export const GITHUB_APP_ID = getServerRuntimeConfig('GITHUB_APP_ID');
export const GITHUB_CLIENT_ID = getServerRuntimeConfig('GITHUB_CLIENT_ID');
export const GITHUB_CLIENT_SECRET = getServerRuntimeConfig('GITHUB_CLIENT_SECRET');

export const LIFECYCLE_MODE = getServerRuntimeConfig('LIFECYCLE_MODE');

/**
 * @deprecated Use individual APP_REDIS_* environment variables instead (APP_REDIS_HOST, APP_REDIS_PORT, APP_REDIS_PASSWORD). This will be removed in future releases.
 */
export const REDIS_URL = getServerRuntimeConfig('REDIS_URL');

export const APP_REDIS_HOST = getServerRuntimeConfig('APP_REDIS_HOST', '');
export const APP_REDIS_PORT = getServerRuntimeConfig('APP_REDIS_PORT', 6379);
export const APP_REDIS_PASSWORD = getServerRuntimeConfig('APP_REDIS_PASSWORD', '');
export const APP_REDIS_TLS = getServerRuntimeConfig('APP_REDIS_TLS', 'false');

export const GITHUB_PRIVATE_KEY = getServerRuntimeConfig('GITHUB_PRIVATE_KEY')
  .replace(/\\n/g, '\n')
  .replace(/\\k/g, '\n');
export const GITHUB_WEBHOOK_SECRET = getServerRuntimeConfig('GITHUB_WEBHOOK_SECRET');

export const JOB_VERSION = getServerRuntimeConfig('JOB_VERSION', 'default');

export const LOG_LEVEL = getServerRuntimeConfig('LOG_LEVEL', 'debug');

export const FASTLY_TOKEN = getServerRuntimeConfig('FASTLY_TOKEN');

export const CODEFRESH_API_KEY = getServerRuntimeConfig('CODEFRESH_API_KEY');

export const MAX_GITHUB_API_REQUEST = getServerRuntimeConfig('MAX_GITHUB_API_REQUEST', 40);

export const SECRET_BOOTSTRAP_NAME = getServerRuntimeConfig('SECRET_BOOTSTRAP_NAME', 'app-secrets');

export const GITHUB_API_REQUEST_INTERVAL = getServerRuntimeConfig('GITHUB_API_REQUEST_INTERVAL', 10000);

export const QUEUE_NAMES = {
  WEBHOOK_PROCESSING: `webhook_processing_${JOB_VERSION}`,
  COMMENT_QUEUE: `comment_queue_${JOB_VERSION}`,
  CLEANUP: `cleanup_${JOB_VERSION}`,
  GLOBAL_CONFIG_CACHE_REFRESH: 'global_config_cache_refresh',
  GITHUB_CLIENT_TOKEN_CACHE_REFRESH: 'github_client_token_cache_refresh',
  INGRESS_MANIFEST: `ingress_manifest_${JOB_VERSION}`,
  INGRESS_CLEANUP: `ingress_cleanup_${JOB_VERSION}`,
  DELETE_QUEUE: `delete_queue_${JOB_VERSION}`,
  WEBHOOK_QUEUE: `webhook_queue_${JOB_VERSION}`,
  RESOLVE_AND_DEPLOY: `resolve_and_deploy_${JOB_VERSION}`,
  BUILD_QUEUE: `build_queue_${JOB_VERSION}`,
  GITHUB_DEPLOYMENT: `github_deployment_${JOB_VERSION}`,
  LABEL: `label_${JOB_VERSION}`,
} as const;

export const GITHUB_APP_INSTALLATION_ID = getServerRuntimeConfig('GITHUB_APP_INSTALLATION_ID');

export const APP_AUTH = {
  appId: Number(GITHUB_APP_ID),
  privateKey: GITHUB_PRIVATE_KEY,
  clientId: GITHUB_CLIENT_ID,
  clientSecret: GITHUB_CLIENT_SECRET,
};

/**
 * @description datadog env vars
 */
export const DD_ENV = getServerRuntimeConfig('DD_ENV', 'prd');
export const DD_SERVICE = getServerRuntimeConfig('DD_SERVICE', 'lifecycle-job');
export const DD_VERSION = getServerRuntimeConfig('DD_VERSION', 'lifecycle');
export const DD_ENVS = {
  ENV: DD_ENV,
  SERVICE: DD_SERVICE,
  VERSION: DD_VERSION,
};
export const ENVIRONMENT = getServerRuntimeConfig('ENVIRONMENT', 'production');
export const APP_HOST = getServerRuntimeConfig('APP_HOST', 'http://localhost:5001');
