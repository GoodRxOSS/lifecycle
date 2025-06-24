import { Deploy } from '../../models';
import logger from '../logger';
import GlobalConfigService from '../../services/globalConfig';
import { ensureNamespaceExists, setupBuildServiceAccountInNamespace } from './utils';
import { buildWithEngine, NativeBuildOptions } from './engines';

export { NativeBuildOptions } from './engines';

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

    const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
    const buildDefaults = globalConfig.buildDefaults || {};
    const awsRoleArn = globalConfig.serviceAccount?.role;
    const serviceAccountName = options.serviceAccount || buildDefaults.serviceAccount || 'native-build-sa';

    await setupBuildServiceAccountInNamespace(options.namespace, serviceAccountName, awsRoleArn);

    await deploy.$fetchGraph('[deployable]');
    const builderEngine = deploy.deployable?.builder?.engine;

    // Route to appropriate builder - both buildkit and kaniko now handle init builds internally
    let result: NativeBuildResult;

    if (builderEngine === 'buildkit' || builderEngine === 'kaniko') {
      logger.info(`[Native Build] Using ${builderEngine} engine for ${options.deployUuid}`);
      result = await buildWithEngine(deploy, options, builderEngine);
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
