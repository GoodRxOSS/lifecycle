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

const SITES_UPLOAD_BODY_LIMIT_BYTES = 200 * 1000 * 1000;

module.exports = {
  experimental: {
    middlewareClientMaxBodySize: SITES_UPLOAD_BODY_LIMIT_BYTES,
  },
  serverExternalPackages: [
    '@kubernetes/client-node',
    // gRPC SDK (nice-grpc/protobufjs) must never be bundled; loaded lazily by providers/modal.ts.
    'modal',
    '@octokit/core',
    '@octokit/auth-app',
    'dd-trace',
    'knex',
    '@aws-sdk/client-s3',
    'google-auth-library',
  ],
  env: {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};
