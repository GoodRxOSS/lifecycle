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

const mockKnex = jest.fn();
const mockBindModels = jest.fn();
const mockDebug = jest.fn();

jest.mock('knex', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockKnex(...args),
}));

jest.mock('./models', () => ({ Build: class Build {} }));

jest.mock('server/models/_Model', () => ({
  __esModule: true,
  default: {
    knex: (...args: unknown[]) => mockBindModels(...args),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ debug: mockDebug }),
}));

jest.mock('../../knexfile', () => ({
  __esModule: true,
  default: {
    client: 'pg',
    connection: {
      database: 'lifecycle',
      host: 'database',
      password: 'base-password',
      port: 5432,
      user: 'lifecycle',
    },
    pool: { min: 0, max: 25 },
  },
}));

import Database from './database';
import * as mockedModels from './models';

function knexInstance() {
  return { destroy: jest.fn() };
}

describe('Database', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('connects on construction, exposes models, and binds the shared model base', () => {
    const connection = knexInstance();
    mockKnex.mockReturnValue(connection);

    const database = new Database();

    expect(mockKnex).toHaveBeenCalledWith({
      client: 'pg',
      connection: {
        database: 'lifecycle',
        host: 'database',
        password: 'base-password',
        port: 5432,
        user: 'lifecycle',
      },
      pool: { min: 0, max: 25 },
    });
    expect(database.models.Build).toBe(mockedModels.Build);
    expect(database.knex).toBe(connection);
    expect(mockBindModels).toHaveBeenCalledWith(connection);
  });

  it('deep-merges lifecycle configuration without discarding prior values', () => {
    mockKnex.mockReturnValue(knexInstance());
    const database = new Database();

    database.setLifecycleConfig({ agent: { enabled: true, maxRuns: 3 } });
    database.setLifecycleConfig({ agent: { maxRuns: 5 }, feature: 'preview' });
    database.setLifecycleConfig();

    expect(database.config).toEqual({
      agent: { enabled: true, maxRuns: 5 },
      feature: 'preview',
    });
    expect(mockDebug).toHaveBeenCalledTimes(3);
  });

  it('destroys the previous connection before reconnecting with overrides', () => {
    const first = knexInstance();
    const second = knexInstance();
    mockKnex.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const database = new Database();

    database.connect({ connection: { database: 'tenant', host: 'tenant-db' } });

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(mockKnex).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({ database: 'tenant', host: 'tenant-db' }),
      })
    );
    expect(database.knex).toBe(second);
  });

  it('removes empty connection fields when no database name is configured', () => {
    mockKnex.mockReturnValueOnce(knexInstance()).mockReturnValueOnce(knexInstance());
    const database = new Database();

    database.connect({
      connection: {
        database: '',
        host: 'tenant-db',
        password: 'secret',
        user: null,
      } as any,
    });

    expect(mockKnex).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connection: {
          host: 'tenant-db',
          password: 'secret',
          port: 5432,
        },
      })
    );
  });

  it('closes idempotently and lazily reconnects when knex is requested again', () => {
    const first = knexInstance();
    const second = knexInstance();
    mockKnex.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const database = new Database();

    database.close();
    database.close();
    expect(database.knex).toBe(second);

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.destroy).not.toHaveBeenCalled();
    expect(mockKnex).toHaveBeenCalledTimes(2);
  });
});
