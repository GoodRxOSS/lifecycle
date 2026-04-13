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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';
mockRedisClient();

import RepositoryService from 'server/services/repository';
import { GITHUB_REPOSITORY_DATA as repoData } from 'server/services/__fixtures__/github';

describe('RepositoryService', () => {
  let service, db, redis, redlock;

  beforeEach(() => {
    db = {
      models: {
        Repository: {
          findOne: jest.fn(),
          create: jest.fn(),
          query: jest.fn(),
        },
      },
    };
    redis = {};
    redlock = {};
    service = new RepositoryService(db, redis, redlock);
  });

  describe('findRepository', () => {
    test('returns existing repository', async () => {
      db.models.Repository.findOne.mockReturnValue({ id: 1 });
      const result = await service.findRepository(1, 2, 3);
      expect(result).toEqual({ id: 1 });
      expect(db.models.Repository.findOne).toHaveBeenCalledWith({
        githubRepositoryId: 2,
        githubInstallationId: 3,
        ownerId: 1,
      });
      expect(db.models.Repository.create).not.toHaveBeenCalled();
    });

    test('creates new repository if none exists', async () => {
      db.models.Repository.findOne.mockReturnValue(null);
      db.models.Repository.create.mockReturnValue({ id: 1 });
      const result = await service.findOrCreateRepository(
        repoData.ownerId,
        repoData.githubRepositoryId,
        repoData.githubInstallationId,
        repoData.fullName,
        repoData.htmlUrl,
        repoData.defaultEnvId
      );
      expect(result).toEqual({ id: 1 });
      expect(db.models.Repository.findOne).toHaveBeenCalledWith({
        githubRepositoryId: repoData.githubRepositoryId,
        githubInstallationId: repoData.githubInstallationId,
        ownerId: repoData.ownerId,
      });
      expect(db.models.Repository.create).toHaveBeenCalledWith({
        githubRepositoryId: repoData.githubRepositoryId,
        githubInstallationId: repoData.githubInstallationId,
        ownerId: repoData.ownerId,
        fullName: repoData.fullName,
        htmlUrl: repoData.htmlUrl,
        defaultEnvId: repoData.defaultEnvId,
      });
    });
  });

  describe('searchRepositories', () => {
    test('returns ranked repository matches for valid queries', async () => {
      const limit = jest.fn().mockResolvedValue([
        {
          githubRepositoryId: 12,
          fullName: 'example-org/example-repo',
          htmlUrl: 'https://github.com/example-org/example-repo',
        },
      ]);
      const orderBy = jest.fn().mockReturnValue({ limit });
      const orderByRaw = jest.fn().mockReturnValue({ orderBy });
      const whereRaw = jest.fn().mockReturnValue({ orderByRaw });
      const select = jest.fn().mockReturnValue({ whereRaw });

      db.models.Repository.query.mockReturnValue({ select });

      const result = await service.searchRepositories('Example-Org/Example', 50);

      expect(result).toEqual([
        {
          githubRepositoryId: 12,
          fullName: 'example-org/example-repo',
          htmlUrl: 'https://github.com/example-org/example-repo',
        },
      ]);
      expect(db.models.Repository.query).toHaveBeenCalled();
      expect(select).toHaveBeenCalledWith('githubRepositoryId', 'fullName', 'htmlUrl');
      expect(whereRaw).toHaveBeenCalledWith('lower("fullName") like ?', ['%example-org/example%']);
      expect(orderByRaw).toHaveBeenCalledWith(
        'case when lower("fullName") = ? then 0 when lower("fullName") like ? then 1 else 2 end',
        ['example-org/example', 'example-org/example%']
      );
      expect(orderBy).toHaveBeenCalledWith('updatedAt', 'desc');
      expect(limit).toHaveBeenCalledWith(25);
    });

    test('returns an empty array for blank queries', async () => {
      const result = await service.searchRepositories('   ', 10);

      expect(result).toEqual([]);
      expect(db.models.Repository.query).not.toHaveBeenCalled();
    });
  });
});
