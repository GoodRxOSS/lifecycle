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
import { omit, pick } from 'lodash';
import objection, {
  Model as ObjectionModel,
  ModelOptions,
  Pojo,
  QueryBuilder,
  QueryContext,
  QueryInterface,
  Transaction,
} from 'objection';
import { getUtcTimestamp } from '../lib/time';

type Constructor<M> = (new (...args: any[]) => M) & typeof Model;

interface IFindOptions {
  required?: boolean;
  eager?: string;
  eagerOpts?: Pojo;
  modify?: (qb: QueryBuilder<any>) => QueryInterface<any, any, any>;
  cache?: boolean;
}

interface IBatchOptions {
  size: number;
  options?: IFindOptions;
  work(records: Model[], offset: number): Promise<void>;
}

export default class Model extends ObjectionModel {
  id!: number;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string;

  static get modelPaths() {
    return [__dirname];
  }

  static deleteable: boolean = false;
  static locatable: boolean = false;
  static hidden: string[] = [];
  static timestamps: boolean = false;
  static transformations: {
    [key: string]: (value: string | boolean | object) => any;
  } = {};
  static isSearchable: boolean = false;
  static searchMapping?: {
    [key: string]: any;
  };

  static pickJsonSchemaProperties = false;

  static find<T>(this: Constructor<T>, scope?: Pojo | null, options: IFindOptions = {}): QueryBuilder<T & Model> {
    const { eager, eagerOpts = {}, modify } = options;

    const query = this.query();

    if (scope) {
      query.where(scope);
    }

    if (eager) {
      query.withGraphFetched(eager, eagerOpts);
    }

    if (modify) {
      query.modify(modify);
    }

    return query;
  }

  static async findOne<T>(this: Constructor<T>, query: Pojo, options: IFindOptions = {}): Promise<T> {
    return this.find(query, options)
      .first()
      .then((record) => {
        if (options.required && !record) {
          throw Error(`${this.name} could not be found: ${JSON.stringify(query)}`);
        }
        return record;
      });
  }

  static async batch({ size, work, options = {} }: IBatchOptions) {
    let records;
    let offset = 0;

    const modify = (qb: QueryBuilder<any>) => {
      if (options.modify) {
        options.modify(qb);
      }
      qb.limit(size);
      qb.offset(offset);
      return qb;
    };

    // eslint-disable-next-line no-constant-condition
    while (1) {
      // eslint-disable-line
      records = await this.find(null, {
        ...options,
        modify,
      });

      if (!records || !records.length) {
        break;
      }
      await work(records, offset);
      offset += size;
    }
  }

  static async create<T>(this: Constructor<T>, attributes: object, trx?: Transaction): Promise<T> {
    return this.query(trx).insert(attributes);
  }

  static async upsert(data: Pojo, unique = ['id'], trx?: Transaction) {
    const tryUpdate = Array.isArray(unique) ? unique.some((key) => data[key]) : !!data[unique];

    if (tryUpdate) {
      const where = pick(data, unique);
      const updatedRowCount = await this.query(trx).update(data).where(where);

      if (updatedRowCount === 0) {
        await this.query(trx).insert(data);
      }

      return this.query(trx).where(where).first();
    }

    return this.query().insert(data);
  }

  static softDelete(id: number) {
    if (this.deleteable) {
      return this.query().patchAndFetchById(id, {
        deletedAt: getUtcTimestamp(),
      });
    }

    throw Error(`${this.name} model does not have static property 'deleteable' specified.`);
  }

  static async transact(callback: (trx: Transaction) => Promise<any>) {
    const trx = await objection.transaction.start(this.knex());
    try {
      const res = await callback(trx);
      await trx.commit();
      return res;
    } catch (err) {
      await trx.rollback();
      throw err;
    }
  }

  static transform(values: Pojo = {}): Pojo {
    if (this.transformations) {
      return Object.entries(this.transformations).reduce((json: Pojo, [key, transformer]) => {
        if (json[key]) {
          json[key] = transformer.call(this, values[key]); // eslint-disable-line
        }

        return json;
      }, values);
    }

    return values;
  }

  async verifyUniqueField(scope: object) {
    const record = await (this.constructor as typeof Model)
      .query()
      .skipUndefined()
      .where(scope)
      .modify((qb) => {
        if (this.id) {
          qb.where('id', '!=', this.id);
        }
      })
      .first();

    if (record) {
      throw new Error(`The field you provided is already connected with an account.`);
    }

    return true;
  }

  $validate(json: Pojo, options: ModelOptions) {
    const { transform } = this.constructor as typeof Model;

    json = transform.call(this.constructor, json); // eslint-disable-line

    try {
      return super.$validate(json, options);
    } catch (err) {
      err.statusCode = 422;
      throw err;
    }
  }

  $beforeInsert(context: QueryContext) {
    super.$beforeInsert(context);

    const { timestamps } = this.constructor as typeof Model;

    if (timestamps) {
      const timestamp = getUtcTimestamp();
      this.createdAt = timestamp;
      this.updatedAt = timestamp;
    }
  }

  $beforeUpdate(options: ModelOptions, context: QueryContext) {
    super.$beforeUpdate(options, context);

    const { timestamps } = this.constructor as typeof Model;

    if (timestamps) {
      this.updatedAt = getUtcTimestamp();
    }
  }

  $formatJson(json: Pojo) {
    const { hidden } = this.constructor as typeof Model;

    return hidden ? omit(json, hidden) : json;
  }

  deepEager(tree: string, depth: number): string {
    return tree.replace('?', depth > 0 ? this.deepEager(tree, depth - 1) : '');
  }

  /**
   * Refresh the record with database values
   */
  async reload() {
    const reloaded = await this.$query();
    this.$set(reloaded);
  }
}
