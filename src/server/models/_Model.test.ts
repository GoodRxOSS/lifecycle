/**
 * Copyright 2026 Lifecycle contributors
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

const mockGetUtcTimestamp = jest.fn();

jest.mock('../lib/time', () => ({
  getUtcTimestamp: () => mockGetUtcTimestamp(),
}));

import objection, { Model as ObjectionModel } from 'objection';
import Model from './_Model';

function modelClass() {
  return class TestModel extends Model {
    static tableName = 'test_models';
  };
}

function queryBuilder() {
  const builder: any = {
    first: jest.fn(),
    insert: jest.fn(),
    limit: jest.fn(),
    modify: jest.fn(),
    offset: jest.fn(),
    patchAndFetchById: jest.fn(),
    skipUndefined: jest.fn(),
    update: jest.fn(),
    where: jest.fn(),
    withGraphFetched: jest.fn(),
  };
  for (const method of [
    'insert',
    'limit',
    'modify',
    'offset',
    'patchAndFetchById',
    'skipUndefined',
    'update',
    'where',
    'withGraphFetched',
  ]) {
    builder[method].mockReturnValue(builder);
  }
  return builder;
}

describe('Model query helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUtcTimestamp.mockReturnValue('2026-08-27T12:34:56.000Z');
  });

  it('exposes the directory containing model classes', () => {
    const TestModel = modelClass();

    expect(TestModel.modelPaths).toEqual([expect.stringMatching(/\/src\/server\/models$/)]);
  });

  it('builds a scoped, eager, modified query when each option is supplied', () => {
    const TestModel = modelClass();
    const builder = queryBuilder();
    const modify = jest.fn();
    (TestModel as any).query = jest.fn(() => builder);

    expect(
      TestModel.find(
        { active: true },
        {
          eager: '[build, deployable]',
          eagerOpts: { minimize: true },
          modify,
        }
      )
    ).toBe(builder);

    expect(builder.where).toHaveBeenCalledWith({ active: true });
    expect(builder.withGraphFetched).toHaveBeenCalledWith('[build, deployable]', { minimize: true });
    expect(builder.modify).toHaveBeenCalledWith(modify);
  });

  it('leaves an unscoped query untouched when no optional find behavior is requested', () => {
    const TestModel = modelClass();
    const builder = queryBuilder();
    (TestModel as any).query = jest.fn(() => builder);

    expect(TestModel.find(null)).toBe(builder);

    expect(builder.where).not.toHaveBeenCalled();
    expect(builder.withGraphFetched).not.toHaveBeenCalled();
    expect(builder.modify).not.toHaveBeenCalled();
  });

  it('findOne returns an existing record and permits an optional miss', async () => {
    const TestModel = modelClass();
    const record = { id: 3 };
    (TestModel as any).find = jest
      .fn()
      .mockReturnValueOnce({ first: () => Promise.resolve(record) })
      .mockReturnValueOnce({ first: () => Promise.resolve(undefined) });

    await expect(TestModel.findOne({ id: 3 })).resolves.toBe(record);
    await expect(TestModel.findOne({ id: 4 })).resolves.toBeUndefined();
  });

  it('findOne describes the model and scope when a required record is absent', async () => {
    const TestModel = modelClass();
    (TestModel as any).find = jest.fn(() => ({ first: () => Promise.resolve(undefined) }));

    await expect(TestModel.findOne({ id: 404 }, { required: true })).rejects.toThrow(
      'TestModel could not be found: {"id":404}'
    );
  });

  it('batches records with stable offsets while preserving the caller modifier', async () => {
    const TestModel = modelClass();
    const callerModify = jest.fn();
    const modifiers: Array<ReturnType<typeof queryBuilder>> = [];
    const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }], []];
    (TestModel as any).find = jest.fn((_scope: unknown, options: any) => {
      const builder = queryBuilder();
      options.modify(builder);
      modifiers.push(builder);
      return Promise.resolve(pages.shift());
    });
    const work = jest.fn().mockResolvedValue(undefined);

    await TestModel.batch({ size: 2, work, options: { modify: callerModify } });

    expect(work).toHaveBeenNthCalledWith(1, [{ id: 1 }, { id: 2 }], 0);
    expect(work).toHaveBeenNthCalledWith(2, [{ id: 3 }], 2);
    expect(callerModify).toHaveBeenCalledTimes(3);
    expect(modifiers[0].limit).toHaveBeenCalledWith(2);
    expect(modifiers[0].offset).toHaveBeenCalledWith(0);
    expect(modifiers[1].offset).toHaveBeenCalledWith(2);
    expect(modifiers[2].offset).toHaveBeenCalledWith(4);
  });

  it('stops a batch immediately when the query returns no collection', async () => {
    const TestModel = modelClass();
    (TestModel as any).find = jest.fn().mockResolvedValue(null);
    const work = jest.fn();

    await TestModel.batch({ size: 10, work });

    expect(work).not.toHaveBeenCalled();
  });

  it('creates a record with the supplied transaction', async () => {
    const TestModel = modelClass();
    const builder = queryBuilder();
    const transaction = { id: 'transaction' };
    const record = { id: 7, name: 'created' };
    builder.insert.mockResolvedValue(record);
    (TestModel as any).query = jest.fn(() => builder);

    await expect(TestModel.create({ name: 'created' }, transaction as any)).resolves.toBe(record);

    expect((TestModel as any).query).toHaveBeenCalledWith(transaction);
    expect(builder.insert).toHaveBeenCalledWith({ name: 'created' });
  });

  it.each([
    ['array', ['id'], { id: 7, name: 'updated' }],
    ['single key', 'slug', { slug: 'example', name: 'updated' }],
  ])('updates and refetches an upsert identified by a %s unique selector', async (_label, unique, data) => {
    const TestModel = modelClass();
    const updateBuilder = queryBuilder();
    const fetchBuilder = queryBuilder();
    const transaction = { id: 'transaction' };
    const record = { ...data };
    updateBuilder.where.mockResolvedValue(1);
    fetchBuilder.first.mockResolvedValue(record);
    (TestModel as any).query = jest.fn().mockReturnValueOnce(updateBuilder).mockReturnValueOnce(fetchBuilder);

    await expect(TestModel.upsert(data, unique as any, transaction as any)).resolves.toEqual(record);

    expect(updateBuilder.update).toHaveBeenCalledWith(data);
    expect(updateBuilder.where).toHaveBeenCalledWith(unique === 'slug' ? { slug: 'example' } : { id: 7 });
    expect(fetchBuilder.where).toHaveBeenCalledWith(unique === 'slug' ? { slug: 'example' } : { id: 7 });
    expect((TestModel as any).query).toHaveBeenCalledWith(transaction);
  });

  it('inserts a missing row before refetching an identified upsert', async () => {
    const TestModel = modelClass();
    const updateBuilder = queryBuilder();
    const insertBuilder = queryBuilder();
    const fetchBuilder = queryBuilder();
    updateBuilder.where.mockResolvedValue(0);
    insertBuilder.insert.mockResolvedValue({ id: 8 });
    fetchBuilder.first.mockResolvedValue({ id: 8, name: 'new' });
    (TestModel as any).query = jest
      .fn()
      .mockReturnValueOnce(updateBuilder)
      .mockReturnValueOnce(insertBuilder)
      .mockReturnValueOnce(fetchBuilder);

    await expect(TestModel.upsert({ id: 8, name: 'new' })).resolves.toEqual({ id: 8, name: 'new' });

    expect(insertBuilder.insert).toHaveBeenCalledWith({ id: 8, name: 'new' });
  });

  it.each([
    [['id'], { name: 'new' }],
    ['slug', { slug: '', name: 'new' }],
  ])('inserts directly when an upsert has no populated unique selector', async (unique, data) => {
    const TestModel = modelClass();
    const builder = queryBuilder();
    const record = { id: 9, ...data };
    builder.insert.mockResolvedValue(record);
    (TestModel as any).query = jest.fn(() => builder);

    await expect(TestModel.upsert(data, unique as any)).resolves.toEqual(record);

    expect(builder.update).not.toHaveBeenCalled();
    expect(builder.insert).toHaveBeenCalledWith(data);
  });
});

describe('Model lifecycle behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUtcTimestamp.mockReturnValue('2026-08-27T12:34:56.000Z');
  });

  it('soft deletes deletable models with the shared UTC timestamp', () => {
    const TestModel = modelClass();
    const builder = queryBuilder();
    const result = { id: 7, deletedAt: '2026-08-27T12:34:56.000Z' };
    TestModel.deleteable = true;
    builder.patchAndFetchById.mockReturnValue(result);
    (TestModel as any).query = jest.fn(() => builder);

    expect(TestModel.softDelete(7)).toBe(result);
    expect(builder.patchAndFetchById).toHaveBeenCalledWith(7, {
      deletedAt: '2026-08-27T12:34:56.000Z',
    });
  });

  it('rejects soft deletion for a model that did not opt in', () => {
    const TestModel = modelClass();

    expect(() => TestModel.softDelete(7)).toThrow(
      "TestModel model does not have static property 'deleteable' specified."
    );
  });

  it('commits a successful transaction and returns the callback value', async () => {
    const TestModel = modelClass();
    const trx = { commit: jest.fn(), rollback: jest.fn() };
    const start = jest.spyOn(objection.transaction, 'start').mockResolvedValue(trx as any);
    const knex = jest.fn(() => 'knex');
    (TestModel as any).knex = knex;
    const callback = jest.fn().mockResolvedValue('result');

    await expect(TestModel.transact(callback)).resolves.toBe('result');

    expect(start).toHaveBeenCalledWith('knex');
    expect(trx.commit).toHaveBeenCalledTimes(1);
    expect(trx.rollback).not.toHaveBeenCalled();
    start.mockRestore();
  });

  it('rolls back and rethrows a failed transaction callback', async () => {
    const TestModel = modelClass();
    const failure = new Error('write failed');
    const trx = { commit: jest.fn(), rollback: jest.fn() };
    const start = jest.spyOn(objection.transaction, 'start').mockResolvedValue(trx as any);
    (TestModel as any).knex = jest.fn(() => 'knex');

    await expect(TestModel.transact(jest.fn().mockRejectedValue(failure))).rejects.toBe(failure);

    expect(trx.rollback).toHaveBeenCalledTimes(1);
    expect(trx.commit).not.toHaveBeenCalled();
    start.mockRestore();
  });

  it('transforms only populated fields and binds transformers to the model class', () => {
    const TestModel = modelClass();
    const transformName = jest.fn(function (this: typeof TestModel, value: string) {
      return `${this.tableName}:${value.toUpperCase()}`;
    });
    const transformDisabled = jest.fn();
    TestModel.transformations = {
      name: transformName,
      disabled: transformDisabled,
    };
    const values = { name: 'example', disabled: false };

    expect(TestModel.transform(values)).toEqual({ name: 'test_models:EXAMPLE', disabled: false });
    expect(transformDisabled).not.toHaveBeenCalled();
  });

  it('returns values unchanged when transformations are disabled', () => {
    const TestModel = modelClass();
    (TestModel as any).transformations = null;
    const values = { name: 'example' };

    expect(TestModel.transform(values)).toBe(values);
    expect(TestModel.transform()).toEqual({});
  });

  it('verifies a unique field while excluding the current record', async () => {
    const TestModel = modelClass();
    const builder = queryBuilder();
    builder.first.mockResolvedValue(undefined);
    (TestModel as any).query = jest.fn(() => builder);
    const record = new TestModel();
    record.id = 12;

    await expect(record.verifyUniqueField({ email: 'user@example.com' })).resolves.toBe(true);

    expect(builder.skipUndefined).toHaveBeenCalledTimes(1);
    expect(builder.where).toHaveBeenCalledWith({ email: 'user@example.com' });
    const modifier = builder.modify.mock.calls[0][0];
    modifier(builder);
    expect(builder.where).toHaveBeenCalledWith('id', '!=', 12);
  });

  it('rejects a duplicate unique field without adding an id exclusion for a new record', async () => {
    const TestModel = modelClass();
    const builder = queryBuilder();
    builder.first.mockResolvedValue({ id: 13 });
    (TestModel as any).query = jest.fn(() => builder);
    const record = new TestModel();

    await expect(record.verifyUniqueField({ email: 'user@example.com' })).rejects.toThrow(
      'The field you provided is already connected with an account.'
    );

    const modifier = builder.modify.mock.calls[0][0];
    modifier(builder);
    expect(builder.where).not.toHaveBeenCalledWith('id', '!=', expect.anything());
  });

  it('transforms values before validation and maps validation failures to HTTP 422', () => {
    const TestModel = modelClass();
    TestModel.transformations = { name: (value: string) => value.trim() };
    const validate = jest.spyOn(ObjectionModel.prototype, '$validate').mockImplementation((json = {}) => json);
    const record = new TestModel();

    expect(record.$validate({ name: '  example  ' }, {})).toEqual({ name: 'example' });

    const validationError: any = new Error('invalid');
    validate.mockImplementationOnce(() => {
      throw validationError;
    });
    expect(() => record.$validate({ name: 'example' }, {})).toThrow(validationError);
    expect(validationError.statusCode).toBe(422);
    validate.mockRestore();
  });

  it('sets insert and update timestamps only for models that opt in', () => {
    const beforeInsert = jest.spyOn(ObjectionModel.prototype, '$beforeInsert').mockImplementation(() => undefined);
    const beforeUpdate = jest.spyOn(ObjectionModel.prototype, '$beforeUpdate').mockImplementation(() => undefined);
    const TimestampedModel = modelClass();
    TimestampedModel.timestamps = true;
    const timestamped = new TimestampedModel();

    timestamped.$beforeInsert({} as any);
    expect(timestamped.createdAt).toBe('2026-08-27T12:34:56.000Z');
    expect(timestamped.updatedAt).toBe('2026-08-27T12:34:56.000Z');

    mockGetUtcTimestamp.mockReturnValueOnce('2026-08-27T13:00:00.000Z');
    timestamped.$beforeUpdate({} as any, {} as any);
    expect(timestamped.updatedAt).toBe('2026-08-27T13:00:00.000Z');

    const PlainModel = modelClass();
    const plain = new PlainModel();
    plain.$beforeInsert({} as any);
    plain.$beforeUpdate({} as any, {} as any);
    expect(plain.createdAt).toBeUndefined();
    expect(plain.updatedAt).toBeUndefined();
    expect(beforeInsert).toHaveBeenCalledTimes(2);
    expect(beforeUpdate).toHaveBeenCalledTimes(2);
    beforeInsert.mockRestore();
    beforeUpdate.mockRestore();
  });

  it('omits hidden JSON fields and preserves JSON when hiding is disabled', () => {
    const TestModel = modelClass();
    TestModel.hidden = ['secret'];
    const record = new TestModel();

    expect(record.$formatJson({ id: 1, secret: 'hidden' })).toEqual({ id: 1 });

    (TestModel as any).hidden = null;
    const json = { id: 1 };
    expect(record.$formatJson(json)).toBe(json);
  });

  it('expands recursive eager templates to the requested depth', () => {
    const record = new (modelClass())();

    expect(record.deepEager('children.[?]', 2)).toBe('children.[children.[children.[]]]');
    expect(record.deepEager('children.[?]', 0)).toBe('children.[]');
  });

  it('reloads database state into the current model instance', async () => {
    const record = new (modelClass())();
    const reloaded = { id: 7, name: 'fresh' };
    record.$query = jest.fn().mockResolvedValue(reloaded) as any;
    record.$set = jest.fn() as any;

    await record.reload();

    expect(record.$query).toHaveBeenCalledTimes(1);
    expect(record.$set).toHaveBeenCalledWith(reloaded);
  });
});
