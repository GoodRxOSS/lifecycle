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

const { NODE_ENV, DATABASE_URL } = process.env;
const { hosts, user, password, path, port = 5432, params } = new ConnectionString(DATABASE_URL);
const host = hosts?.[0]?.name;
const database = path?.[0];
const ssl = params?.ssl == 'true' ? { rejectUnauthorized: false } : false;

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
