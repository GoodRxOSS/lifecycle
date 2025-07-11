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
import { ConnectionString } from 'connection-string';
import { merge } from 'lodash';

const { NODE_ENV, DATABASE_URL, APP_DB_HOST, APP_DB_PORT, APP_DB_USER, APP_DB_PASSWORD, APP_DB_NAME, APP_DB_SSL } =
  process.env;

let host: string | undefined;
let user: string | undefined;
let password: string | undefined;
let database: string | undefined;
let port: number;
let ssl: boolean | { rejectUnauthorized: boolean };

if (APP_DB_HOST && APP_DB_USER && APP_DB_PASSWORD && APP_DB_NAME) {
  host = APP_DB_HOST;
  user = APP_DB_USER;
  password = APP_DB_PASSWORD;
  database = APP_DB_NAME;
  port = APP_DB_PORT ? parseInt(APP_DB_PORT, 10) : 5432;
  ssl = APP_DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
} else if (DATABASE_URL) {
  // Fall back to parsing DATABASE_URL will be removed in future releases
  const parsed = new ConnectionString(DATABASE_URL);
  host = parsed.hosts?.[0]?.name;
  user = parsed.user;
  password = parsed.password;
  database = parsed.path?.[0];
  port = parsed.port || 5432;
  ssl = parsed.params?.ssl == 'true' ? { rejectUnauthorized: false } : false;
} else {
  throw new Error(
    'Database configuration not found. Please provide either DATABASE_URL or individual APP_DB_* environment variables.'
  );
}

const defaults = {
  client: 'pg',
  connection: {
    host,
    user,
    password,
    database,
    port,
    ssl,
  },
  pool: {
    min: 0,
    max: 25,
  },
  migrations: {
    extension: 'ts',
    tableName: '_knex_migrations',
    directory: `${__dirname}/src/server/db/migrations`,
  },
  seeds: {
    extension: 'ts',
    directory: `${__dirname}/src/server/db/seeds`,
    loadExtensions: ['.ts'],
  },
  debug: false,
};

const environments = {};

const config = merge(defaults, environments[NODE_ENV]);

module.exports = config;
export default config;
