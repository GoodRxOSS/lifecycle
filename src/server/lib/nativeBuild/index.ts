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
import { getLogger, withSpan, withLogContext } from '../logger';
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
  return withLogContext({ deployUuid: options.deployUuid, serviceName: deploy.deployable?.name }, async () => {
    return withSpan(
      'lifecycle.build.image',
      async () => {
        const startTime = Date.now();
        getLogger().info('Build: starting (native)');

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
            getLogger().debug(`Build: using ${builderEngine} engine`);
            result = await buildWithEngine(deploy, buildOptions, builderEngine);
          } else {
            throw new Error(`Unsupported builder engine: ${builderEngine}`);
          }

          const duration = Date.now() - startTime;
          getLogger().info(`Build: completed success=${result.success} duration=${duration}ms`);

          return result;
        } catch (error) {
          const duration = Date.now() - startTime;
          getLogger().error({ error }, `Build: failed duration=${duration}ms`);

          return {
            success: false,
            logs: `Build error: ${error.message}`,
            jobName: '',
          };
        }
      },
      { resource: options.deployUuid }
    );
  });
}
