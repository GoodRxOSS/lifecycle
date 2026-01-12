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

import { getLogger } from 'server/lib/logger/index';
import { Repository } from 'server/models';
import BaseService from './_service';

export default class RepositoryService extends BaseService {
  /**
   * Retrieve a Lifecycle Github Repository model. If it doesn't exist, create a new record.
   * @param ownerId Github repoistory owner ID.
   * @param githubRepositoryId Github repository ID.
   * @param githubInstallationId Lifecycle Github installation ID.
   * @param fullName Github repository full name (including the owner/organization name).
   * @param htmlUrl Github repository owner URL.
   * @param defaultEnvId Default Lifecycle environment ID.
   * @returns Lifecycle Github Repository model.
   */
  async findOrCreateRepository(
    ownerId: number,
    githubRepositoryId: number,
    githubInstallationId: number,
    fullName: string,
    htmlUrl: string,
    defaultEnvId: number
  ) {
    let repository: Repository;

    try {
      repository =
        (await this.db.models.Repository.findOne({
          githubRepositoryId,
          githubInstallationId,
          ownerId,
        })) ||
        (await this.db.models.Repository.create({
          githubRepositoryId,
          githubInstallationId,
          ownerId,
          fullName,
          htmlUrl,
          defaultEnvId,
        }));
    } catch (error) {
      getLogger({ githubRepositoryId, error }).error('Repository: find or create failed');
      throw error;
    }

    return repository;
  }

  /**
   * Retrieve a Lifecycle Github Repository model. If it doesn't exist, create a new record.
   * @param ownerId Github repoistory owner ID.
   * @param githubRepositoryId Github repository ID.
   * @param githubInstallationId Lifecycle Github installation ID.
   * @param fullName Github repository full name (including the owner/organization name).
   * @param htmlUrl Github repository owner URL.
   * @param defaultEnvId Default Lifecycle environment ID.
   * @returns Lifecycle Github Repository model.
   */
  async findRepository(ownerId: number, githubRepositoryId: number, githubInstallationId: number) {
    let repository: Repository;

    try {
      repository = await this.db.models.Repository.findOne({
        githubRepositoryId,
        githubInstallationId,
        ownerId,
      });
    } catch (error) {
      getLogger({ githubRepositoryId, error }).error('Repository: find failed');
      throw error;
    }

    return repository;
  }
}
