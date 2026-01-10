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
import { withLogContext, getLogger, LogStage } from 'server/lib/logger/index';
import BaseService from './_service';
import fs from 'fs';
import { TMP_PATH, QUEUE_NAMES } from 'shared/config';
import { IngressConfiguration } from '../../server/services/build';
import { shellPromise } from 'server/lib/shell';
import yaml from 'js-yaml';
import { redisClient } from 'server/lib/dependencies';
import GlobalConfigService from './globalConfig';

const MANIFEST_PATH = `${TMP_PATH}/ingress`;

export default class IngressService extends BaseService {
  async updateIngressManifest(): Promise<boolean> {
    return true;
  }

  /**
   * Job for generating manifests
   */
  ingressManifestQueue = this.queueManager.registerQueue(QUEUE_NAMES.INGRESS_MANIFEST, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 5,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });

  /**
   * Job for cleaning up ingress
   */
  ingressCleanupQueue = this.queueManager.registerQueue(QUEUE_NAMES.INGRESS_CLEANUP, {
    connection: redisClient.getConnection(),
    defaultJobOptions: {
      attempts: 5,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });

  /**
   * Cleans up ingresses for a build that has been deleted
   * @param job a job with a buildId in the data object
   * @param done the done callback
   */
  ingressCleanupForBuild = async (job) => {
    const { buildId, buildUuid, sender, correlationId, _ddTraceContext } = job.data;

    return withLogContext({ correlationId, buildUuid, sender, _ddTraceContext }, async () => {
      getLogger({ stage: LogStage.INGRESS_PROCESSING }).info('Ingress: cleaning up');

      // For cleanup purpose, we want to include the ingresses for all the services (active or not) to cleanup just in case.
      const configurations = await this.db.services.BuildService.configurationsForBuildId(buildId, true);
      const namespace = await this.db.services.BuildService.getNamespace({ id: buildId });
      try {
        configurations.forEach(async (configuration) => {
          await shellPromise(
            `kubectl delete ingress ingress-${configuration.deployUUID} --namespace ${namespace}`
          ).catch((error) => {
            getLogger({ stage: LogStage.INGRESS_PROCESSING }).warn(`${error}`);
            return null;
          });
        });
        getLogger({ stage: LogStage.INGRESS_COMPLETE }).info('Ingress: cleaned up');
      } catch (e) {
        getLogger({ stage: LogStage.INGRESS_FAILED }).warn({ error: e }, 'Error cleaning up ingress');
      }
    });
  };

  createOrUpdateIngressForBuild = async (job) => {
    const { buildId, buildUuid, sender, correlationId, _ddTraceContext } = job.data;

    return withLogContext({ correlationId, buildUuid, sender, _ddTraceContext }, async () => {
      getLogger({ stage: LogStage.INGRESS_PROCESSING }).info('Ingress: creating');

      // We just want to create/update ingress for active services only
      const configurations = await this.db.services.BuildService.configurationsForBuildId(buildId, false);
      const namespace = await this.db.services.BuildService.getNamespace({ id: buildId });
      const { lifecycleDefaults, domainDefaults } = await GlobalConfigService.getInstance().getAllConfigs();
      const manifests = configurations.map((configuration) => {
        return yaml.dump(
          this.generateNginxManifestForConfiguration({
            configuration,
            ingressClassName: lifecycleDefaults?.ingressClassName,
            altHosts: domainDefaults?.altHttp || [],
          }),
          {
            skipInvalid: true,
          }
        );
      });
      manifests.forEach(async (manifest, idx) => {
        await this.applyManifests(manifest, `${buildId}-${idx}-nginx`, namespace);
      });

      getLogger({ stage: LogStage.INGRESS_COMPLETE }).info('Ingress: created');
    });
  };

  /**
   * Generates an nginx manifest for an ingress configuration
   * @param configuration the ingress configuration that describes a deploy object
   * @param defaultUUID the default UUID from global configuration
   * @param ingressClassName the ingress class name from global configuration (defaults to 'nginx' if not set)
   */
  private generateNginxManifestForConfiguration = ({
    configuration,
    ingressClassName,
    altHosts,
  }: {
    configuration: IngressConfiguration;
    ingressClassName?: string;
    altHosts: string[];
  }) => {
    const annotations = {
      ...configuration.ingressAnnotations,
    };
    if (configuration.ipWhitelist && configuration.ipWhitelist.length > 0) {
      annotations['nginx.ingress.kubernetes.io/whitelist-source-range'] = configuration.ipWhitelist.join(', ');
    }
    return {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: `ingress-${configuration.deployUUID}`,
        annotations,
        labels: {
          lc_uuid: configuration.deployUUID,
        },
      },
      spec: {
        rules: this.generateRulesForManifest(configuration, altHosts),
        ingressClassName: ingressClassName || 'nginx',
      },
    };
  };

  /**
   * Generates the rules for an ingress configuration
   * @param configuration the ingress configuration to generate rules for
   */
  private generateRulesForManifest = (configuration: IngressConfiguration, altHosts: string[]) => {
    const allHosts = [configuration.host, ...altHosts.map((v) => `${configuration.deployUUID}.${v}`)];

    const createRule = (host: string, path: string, port: number) => ({
      host,
      http: {
        paths: [
          {
            path,
            pathType: 'ImplementationSpecific',
            backend: {
              service: {
                name: configuration.serviceHost,
                port: {
                  number: port,
                },
              },
            },
          },
        ],
      },
    });

    return allHosts.flatMap((host) =>
      Object.entries(configuration.pathPortMapping).map(([path, port]) => createRule(host, path, port))
    );
  };

  /**
   * Applies a manifest to the k8 cluster
   * @param manifest the manifest to apply
   * @param ingressName a name for the manifest for tmp directory namespacing
   */
  private applyManifests = async (manifest, ingressName, namespace: string) => {
    try {
      const localPath = `${MANIFEST_PATH}/global-ingress/${ingressName}-ingress.yaml`;
      await fs.promises.mkdir(`${MANIFEST_PATH}/global-ingress/`, {
        recursive: true,
      });
      await fs.promises.writeFile(localPath, manifest, 'utf8');
      await shellPromise(`kubectl apply -f ${localPath} --namespace ${namespace}`);
    } catch (error) {
      getLogger({ stage: LogStage.INGRESS_FAILED }).warn({ error }, 'Failed to apply ingress manifest');
    }
  };
}
