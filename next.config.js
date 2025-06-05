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

require('dotenv').config();

module.exports = {
  env: {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  },
  publicRuntimeConfig: {},
  serverRuntimeConfig: {
    APP_ENV: process.env.APP_ENV,
    CODEFRESH_API_KEY: process.env.CODEFRESH_API_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    FASTLY_TOKEN: process.env.FASTLY_TOKEN,
    GITHUB_API_REQUEST_INTERVAL: process.env.GITHUB_API_REQUEST_INTERVAL,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    JOB_VERSION: process.env.JOB_VERSION,
    LIFECYCLE_MODE: process.env.LIFECYCLE_MODE,
    LIFECYCLE_UI_HOSTHAME_WITH_SCHEME: process.env.LIFECYCLE_UI_HOSTHAME_WITH_SCHEME,
    LOG_LEVEL: process.env.LOG_LEVEL,
    MAX_GITHUB_API_REQUEST: process.env.MAX_GITHUB_API_REQUEST,
    REDIS_URL: process.env.REDIS_URL,
    REDIS_PORT: process.env.REDIS_PORT,
    GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
    PINO_PRETTY: process.env.PINO_PRETTY,
    ENVIRONMENT: process.env.ENVIRONMENT,
    APP_HOST: process.env.APP_HOST,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};
