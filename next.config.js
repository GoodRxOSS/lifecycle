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
  experimental: {
    serverComponentsExternalPackages: [
      '@kubernetes/client-node',
      '@octokit/core',
      '@octokit/auth-app',
      'dd-trace',
      'knex',
      '@google/genai',
      'google-auth-library',
      'gaxios',
    ],
  },
  env: {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  },
  publicRuntimeConfig: {},
  serverRuntimeConfig: {
    APP_ENV: process.env.APP_ENV,
    CODEFRESH_API_KEY: process.env.CODEFRESH_API_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    APP_DB_HOST: process.env.APP_DB_HOST,
    APP_DB_PORT: process.env.APP_DB_PORT,
    APP_DB_USER: process.env.APP_DB_USER,
    APP_DB_PASSWORD: process.env.APP_DB_PASSWORD,
    APP_DB_NAME: process.env.APP_DB_NAME,
    APP_DB_SSL: process.env.APP_DB_SSL,
    FASTLY_TOKEN: process.env.FASTLY_TOKEN,
    GITHUB_API_REQUEST_INTERVAL: process.env.GITHUB_API_REQUEST_INTERVAL,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_APP_AUTH_CALLBACK: process.env.GITHUB_APP_AUTH_CALLBACK,
    JOB_VERSION: process.env.JOB_VERSION,
    LIFECYCLE_MODE: process.env.LIFECYCLE_MODE,
    LIFECYCLE_UI_URL: process.env.LIFECYCLE_UI_URL,
    LOG_LEVEL: process.env.LOG_LEVEL,
    MAX_GITHUB_API_REQUEST: process.env.MAX_GITHUB_API_REQUEST,
    REDIS_URL: process.env.REDIS_URL,
    APP_REDIS_HOST: process.env.APP_REDIS_HOST,
    APP_REDIS_PORT: process.env.APP_REDIS_PORT,
    APP_REDIS_PASSWORD: process.env.APP_REDIS_PASSWORD,
    APP_REDIS_TLS: process.env.APP_REDIS_TLS,
    GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
    PINO_PRETTY: process.env.PINO_PRETTY,
    ENVIRONMENT: process.env.ENVIRONMENT,
    APP_HOST: process.env.APP_HOST,
    SECRET_BOOTSTRAP_NAME: process.env.SECRET_BOOTSTRAP_NAME,
    KEYCLOAK_ISSUER: process.env.KEYCLOAK_ISSUER,
    KEYCLOAK_CLIENT_ID: process.env.KEYCLOAK_CLIENT_ID,
    KEYCLOAK_JWKS_URL: process.env.KEYCLOAK_JWKS_URL,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    MINIO_ENDPOINT: process.env.MINIO_ENDPOINT,
    MINIO_PORT: process.env.MINIO_PORT,
    MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY,
    MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY,
    MINIO_BUCKET: process.env.MINIO_BUCKET,
    MINIO_USE_SSL: process.env.MINIO_USE_SSL,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};
