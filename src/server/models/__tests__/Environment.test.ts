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

import Environment from 'server/models/Environment';

describe('Environment model', () => {
  let env;
  beforeEach(() => {
    env = new Environment();
  });
  afterEach(() => {
    env = undefined;
  });
  afterAll(() => {
    jest.restoreAllMocks();
  });
  test('has default properties', () => {
    expect(Environment.tableName).toEqual('environments');
    expect(Environment.timestamps).toBeTruthy();
    expect(env.autoDeploy).toBeUndefined();
  });
  test('has default base model properties', () => {
    expect(Environment.deleteable).toBeFalsy();
    expect(env.verifyUniqueField).toBeDefined();
    expect(env.$validate).toBeDefined();
    expect(env.$beforeInsert).toBeDefined();
    expect(env.$beforeUpdate).toBeDefined();
    expect(env.$formatJson).toBeDefined();
    expect(env.deepEager).toBeDefined();
    expect(env.reload).toBeDefined();
  });

  test('has default Objection model properties', () => {
    expect(env.$query).toBeDefined();
    expect(env.$set).toBeDefined();
  });
});
