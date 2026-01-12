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

import knex, { Knex } from 'knex';
import { merge } from 'lodash';
import * as models from './models';
import { IServices } from 'server/services/types';
import Model from 'server/models/_Model';
import knexfile from '../../knexfile';

import { getLogger } from 'server/lib/logger/index';

export default class Database {
  models: models.IModels;
  services: IServices;
  config: any = {};

  private __knexInstance: Knex;
  private knexConfig: Knex.Config;

  constructor(knexConfig?: Knex.Config) {
    this.setKnexConfig(knexConfig);
    this.connect();
  }

  get knex(): Knex {
    if (!this.__knexInstance) {
      this.connect();
    }

    return this.__knexInstance;
  }

  setKnexConfig(knexConfig: Knex.Config = {}) {
    this.knexConfig = merge({}, knexfile, knexConfig);
  }

  setLifecycleConfig(config: any = {}) {
    getLogger().debug('Database: setting lifecycle config');
    this.config = merge({}, this.config, config);
  }

  connect(knexConfig: Knex.Config = {}): void {
    this.close();

    this.setKnexConfig(knexConfig);
    if (
      typeof this.knexConfig.connection === 'object' &&
      !(this.knexConfig.connection as Knex.ConnectionConfig).database
    ) {
      delete (this.knexConfig.connection as Knex.ConnectionConfig).database;
    }

    this.__knexInstance = knex(this.knexConfig);
    this.models = models;
    Model.knex(this.__knexInstance);
  }

  close(): void {
    if (!this.__knexInstance) {
      return;
    }

    this.__knexInstance.destroy();
    this.__knexInstance = null;
  }
}
