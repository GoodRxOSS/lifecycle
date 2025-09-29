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

import BaseService from './_service';
import rootLogger from 'server/lib/logger';
import { Build } from 'server/models';
import * as k8s from 'server/lib/kubernetes';
import DeployService from './deploy';

const logger = rootLogger.child({
  filename: 'services/override.ts',
});

interface ValidationResult {
  valid: boolean;
  error?: string;
}

interface UpdateResult {
  build: Build;
  deploysUpdated: number;
}

export default class OverrideService extends BaseService {
  /**
   * Validate UUID format and uniqueness
   * @param uuid The UUID to validate
   * @returns ValidationResult with validation status and error details
   */
  async validateUuid(uuid: string): Promise<ValidationResult> {
    if (uuid.length < 3 || uuid.length > 50) {
      return { valid: false, error: 'UUID must be between 3 and 50 characters' };
    }

    if (!/^[a-zA-Z0-9-]+$/.test(uuid)) {
      return { valid: false, error: 'UUID can only contain letters, numbers, and hyphens' };
    }

    if (uuid.startsWith('-') || uuid.endsWith('-')) {
      return { valid: false, error: 'UUID cannot start or end with a hyphen' };
    }

    try {
      const existingBuild = await this.db.models.Build.query().findOne({ uuid });

      if (existingBuild) {
        return { valid: false, error: 'UUID is not available' };
      }
    } catch (error) {
      logger.error('Error checking UUID uniqueness:', error);
      return { valid: false, error: 'Unable to validate UUID' };
    }

    return { valid: true };
  }

  /**
   * Update build UUID and all related records
   * @param build The build to update
   * @param newUuid The new UUID to set
   * @returns UpdateResult with updated build and count of updated deploys
   */
  async updateBuildUuid(build: Build, newUuid: string): Promise<UpdateResult> {
    const oldUuid = build.uuid;
    const oldNamespace = build.namespace;

    logger.info(`[BUILD ${oldUuid}] Updating UUID to '${newUuid}'`);

    try {
      return await this.db.models.Build.transact(async (trx) => {
        await build.$query(trx).patch({
          uuid: newUuid,
          namespace: `env-${newUuid}`,
        });

        await this.db.models.Deployable.query(trx).where('buildId', build.id).patch({ buildUUID: newUuid });

        const deploys = await this.db.models.Deploy.query(trx)
          .where('buildId', build.id)
          .withGraphFetched('[service, deployable]');

        // Update all deploys
        // this will not work for database configured services
        const deployService = new DeployService();
        const updateDeploys = deploys.map(async (deploy) => {
          const newDeployUuid = `${deploy.deployable.name}-${newUuid}`;
          return deploy.$query(trx).patch({
            uuid: newDeployUuid,
            internalHostname: newDeployUuid,
            publicUrl: build.enableFullYaml
              ? deployService.hostForDeployableDeploy(deploy, deploy.deployable)
              : deployService.hostForServiceDeploy(deploy, deploy.service),
          });
        });

        await Promise.all(updateDeploys);

        const updatedBuild = await this.db.models.Build.query(trx).findById(build.id);

        // Delete the old namespace for cleanup (non-blocking, outside transaction)
        k8s.deleteNamespace(oldNamespace).catch((error) => {
          logger.warn(`[BUILD ${oldUuid}] Failed to delete old namespace ${oldNamespace}:`, error);
        });
        logger.info(
          `[BUILD ${newUuid}] Successfully updated UUID from '${oldUuid}' to '${newUuid}', updated ${deploys.length} deploys`
        );

        return {
          build: updatedBuild,
          deploysUpdated: deploys.length,
        };
      });
    } catch (error) {
      logger.error(`[BUILD ${oldUuid}] Failed to update UUID to '${newUuid}': ${error}`, error);
      throw error;
    }
  }
}
