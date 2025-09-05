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

import type { NextApiRequest, NextApiResponse } from 'next';
import rootLogger from 'server/lib/logger';
import * as k8s from '@kubernetes/client-node';
import { HttpError } from '@kubernetes/client-node';
import { Deploy } from 'server/models';

const logger = rootLogger.child({
  filename: __filename,
});

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

interface HelmDeploymentDetails {
  type: 'helm';
  releaseName: string;
  chart: string;
  version?: string;
  values: Record<string, any>;
  manifest?: string;
}

interface GitHubDeploymentDetails {
  type: 'github';
  manifestConfigMap: string;
  manifest: string;
}

async function getHelmDeploymentDetails(namespace: string, deployUuid: string): Promise<HelmDeploymentDetails | null> {
  const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

  try {
    const secretName = `sh.helm.release.v1.${deployUuid}.v1`;
    logger.debug(`Checking for Helm secret: ${secretName} in namespace ${namespace}`);

    const secret = await coreV1Api.readNamespacedSecret(secretName, namespace);

    if (!secret.body.data?.release) {
      logger.debug(`Helm secret ${secretName} found but no release data`);
      return null;
    }

    const firstDecode = Buffer.from(secret.body.data.release, 'base64').toString();

    let releaseData: Buffer;
    if (/^[A-Za-z0-9+/]/.test(firstDecode) && firstDecode.length % 4 <= 2) {
      try {
        releaseData = Buffer.from(firstDecode, 'base64');
      } catch {
        releaseData = Buffer.from(firstDecode);
      }
    } else {
      releaseData = Buffer.from(firstDecode);
    }

    let release: any;
    try {
      const zlib = require('zlib');
      const decompressed = zlib.gunzipSync(releaseData);
      release = JSON.parse(decompressed.toString());
    } catch (decompressError: any) {
      try {
        release = JSON.parse(releaseData.toString());
      } catch (parseError: any) {
        logger.warn(
          `Failed to parse Helm release data for ${deployUuid}: decompress_error=${decompressError.message} parse_error=${parseError.message}`
        );
        return null;
      }
    }

    return {
      type: 'helm',
      releaseName: release.name,
      chart: release.chart?.metadata?.name || 'unknown',
      version: release.chart?.metadata?.version,
      values: release.config || {},
      manifest: release.manifest,
    };
  } catch (error) {
    if (error instanceof HttpError && error.response?.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

async function getGitHubDeploymentDetails(
  namespace: string,
  deployUuid: string
): Promise<GitHubDeploymentDetails | null> {
  const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

  try {
    const labelSelector = `deploy_uuid=${deployUuid},app=lifecycle-deploy`;
    const configMaps = await coreV1Api.listNamespacedConfigMap(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector
    );

    const manifestConfigMap = configMaps.body.items.find((cm) => cm.metadata?.name?.includes('-manifest'));

    if (!manifestConfigMap || !manifestConfigMap.data?.['manifest.yaml']) {
      const deploy = await Deploy.query().where('uuid', deployUuid).withGraphFetched('[deployable, service]').first();

      if (!deploy?.manifest) {
        return null;
      }

      return {
        type: 'github',
        manifestConfigMap: 'stored-in-database',
        manifest: deploy.manifest,
      };
    }

    return {
      type: 'github',
      manifestConfigMap: manifestConfigMap.metadata?.name || '',
      manifest: manifestConfigMap.data['manifest.yaml'],
    };
  } catch (error) {
    if (error instanceof HttpError && error.response?.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * @openapi
 * /api/v1/builds/{uuid}/services/{name}/deployment:
 *   get:
 *     summary: Get deployment details
 *     description: |
 *       Returns detailed information about a specific deployment.
 *       For Helm deployments, this includes the release information and values.
 *       For GitHub-type deployments, this includes the Kubernetes manifest.
 *     tags:
 *       - Deployments
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the service
 *     responses:
 *       '200':
 *         description: Deployment details
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   properties:
 *                     type:
 *                       type: string
 *                       const: helm
 *                     releaseName:
 *                       type: string
 *                       example: my-service
 *                     chart:
 *                       type: string
 *                       example: my-chart
 *                     version:
 *                       type: string
 *                       example: 1.2.3
 *                     values:
 *                       type: object
 *                       description: Helm values used for deployment
 *                     manifest:
 *                       type: string
 *                       description: Rendered Kubernetes manifest
 *                 - type: object
 *                   properties:
 *                     type:
 *                       type: string
 *                       const: github
 *                     manifestConfigMap:
 *                       type: string
 *                       example: deploy-uuid-manifest
 *                     manifest:
 *                       type: string
 *                       description: Kubernetes manifest YAML
 *       '400':
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       '404':
 *         description: Deployment not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       '405':
 *         description: Method not allowed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       '500':
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    logger.warn({ method: req.method }, 'Method not allowed');
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  const { uuid, name } = req.query;

  if (typeof uuid !== 'string' || typeof name !== 'string') {
    logger.warn({ uuid, name }, 'Missing or invalid query parameters');
    return res.status(400).json({ error: 'Missing or invalid parameters' });
  }

  const deployUuid = `${name}-${uuid}`;

  try {
    const namespace = `env-${uuid}`;

    logger.info(`Fetching deployment details: deployUuid=${deployUuid} namespace=${namespace} service=${name}`);

    const helmDetails = await getHelmDeploymentDetails(namespace, deployUuid);
    if (helmDetails) {
      logger.info(`Found Helm deployment details for ${deployUuid}`);
      return res.status(200).json(helmDetails);
    }

    const githubDetails = await getGitHubDeploymentDetails(namespace, deployUuid);
    if (githubDetails) {
      logger.info(`Found GitHub-type deployment details for ${deployUuid}`);
      return res.status(200).json(githubDetails);
    }

    logger.warn(`No deployment details found for ${deployUuid}`);
    return res.status(404).json({ error: 'Deployment not found' });
  } catch (error) {
    logger.error({ err: error }, `Error getting deployment details for ${deployUuid}`);

    if (error instanceof HttpError) {
      if (error.response?.statusCode === 404) {
        return res.status(404).json({ error: 'Deployment not found' });
      }
      return res.status(502).json({ error: 'Failed to communicate with Kubernetes' });
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
};

export default handler;
