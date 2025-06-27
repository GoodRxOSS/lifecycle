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

import { Deploy } from '../../models';
import logger from '../logger';
import { ensureNamespaceExists } from './utils';
import { buildWithEngine, NativeBuildOptions } from './engines';
import { ensureServiceAccountForJob } from '../kubernetes/common/serviceAccount';

export type { NativeBuildOptions } from './engines';

export interface NativeBuildResult {
  success: boolean;
  logs: string;
  jobName: string;
}

export async function buildWithNative(deploy: Deploy, options: NativeBuildOptions): Promise<NativeBuildResult> {
  const startTime = Date.now();
  logger.info(`[Native Build] Starting build for ${options.deployUuid} in namespace ${options.namespace}`);

  try {
    await ensureNamespaceExists(options.namespace);

    const serviceAccountName = await ensureServiceAccountForJob(options.namespace, 'build');

    const buildOptions = {
      ...options,
      serviceAccount: serviceAccountName,
    };

    await deploy.$fetchGraph('[deployable]');
    const builderEngine = deploy.deployable?.builder?.engine;

    let result: NativeBuildResult;

    if (builderEngine === 'buildkit' || builderEngine === 'kaniko') {
      logger.info(`[Native Build] Using ${builderEngine} engine for ${options.deployUuid}`);
      result = await buildWithEngine(deploy, buildOptions, builderEngine);
    } else {
      throw new Error(`Unsupported builder engine: ${builderEngine}`);
    }

    const duration = Date.now() - startTime;
    logger.info(
      `[Native Build] Build completed for ${options.deployUuid}: jobName=${result.jobName}, success=${result.success}, duration=${duration}ms, namespace=${options.namespace}`
    );

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(
      `[Native Build] Build failed for ${options.deployUuid}: error=${error.message}, duration=${duration}ms, namespace=${options.namespace}`
    );

    return {
      success: false,
      logs: `Build error: ${error.message}`,
      jobName: '',
    };
  }
}
