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

import { getLogger } from 'server/lib/logger';
import { getK8sJobStatusAndPod } from 'server/lib/logStreamingHelper';
import BuildService from 'server/services/build';
import { LogStreamResponse, LogType } from './types/logStreaming';
import GlobalConfigService from 'server/services/globalConfig';
import { getLogArchivalService } from 'server/services/logArchival';

export class LogStreamingService {
  private buildService: BuildService;

  constructor() {
    this.buildService = new BuildService();
  }

  async getLogStreamInfo(
    uuid: string,
    jobName: string,
    serviceName?: string, // Optional for webhooks
    explicitType?: LogType
  ): Promise<LogStreamResponse> {
    // 1. Validate Build Existence
    const build = await this.buildService.db.models.Build.query().findOne({ uuid });
    if (!build) {
      throw new Error('Build not found');
    }

    // 2. Determine Configuration
    const namespace = `env-${uuid}`;
    const logType: LogType = (explicitType as LogType) || this.detectLogType(jobName);

    getLogger().info(`LogStreaming: processing log request name=${serviceName} jobName=${jobName} logType=${logType}`);

    // 3. Fetch K8s Data
    const podInfo = await getK8sJobStatusAndPod(jobName, namespace);

    // 4. Handle "Not Found" scenario — attempt archived log fallback
    if (!podInfo || podInfo.status === 'NotFound') {
      const globalConfig = await GlobalConfigService.getInstance().getAllConfigs();
      if (globalConfig.logArchival?.enabled && serviceName && jobName) {
        try {
          const archivalService = getLogArchivalService();
          const jobType = logType === 'deploy' ? 'deploy' : 'build';
          const archivedLogs = await archivalService.getArchivedLogs(namespace, jobType, serviceName, jobName);
          if (archivedLogs !== null) {
            return {
              status: 'Archived',
              streamingRequired: false,
              archivedLogs,
              message: 'Logs retrieved from archive',
            };
          }
        } catch (archiveError) {
          getLogger().warn({ error: archiveError }, `LogArchival: failed to fetch archived logs jobName=${jobName}`);
        }
      }

      const response: LogStreamResponse = {
        status: 'NotFound',
        streamingRequired: false,
        message: podInfo?.message || 'Job not found',
      };

      if (logType === 'deploy') {
        response.error = podInfo?.message || 'Job not found';
        delete response.message;
      }
      return response;
    }

    // 5. Map Status and Construct Response
    const unifiedStatus = this.mapPodStatusToUnified(podInfo.status);
    const streamingRequired =
      unifiedStatus === 'Active' ||
      unifiedStatus === 'Pending' ||
      unifiedStatus === 'Complete' ||
      unifiedStatus === 'Failed';

    const response: LogStreamResponse = {
      status: unifiedStatus,
      streamingRequired,
      podName: podInfo.podName,
    };

    // 6. Construct WebSocket Params
    if (podInfo.podName) {
      response.websocket = {
        endpoint: '/api/logs/stream',
        parameters: {
          podName: podInfo.podName,
          namespace: namespace,
          follow: unifiedStatus === 'Active' || unifiedStatus === 'Pending',
          timestamps: true,
        },
      };
    }

    // 7. Add Container Info
    if (podInfo.containers && podInfo.containers.length > 0) {
      response.containers = podInfo.containers.map((c) => ({
        name: c.name,
        state: c.state,
      }));
    }

    // 8. Add Status Messages
    if (unifiedStatus === 'Complete') {
      response.message = `Job pod ${podInfo.podName} has status: Completed. Streaming not active.`;
    } else if (unifiedStatus === 'Failed') {
      response.message = podInfo.message || `Job pod ${podInfo.podName} has status: Failed. Streaming not active.`;
      if (logType === 'deploy' && podInfo.message) {
        response.error = podInfo.message;
      }
    } else if (!podInfo.podName && (unifiedStatus === 'Active' || unifiedStatus === 'Pending')) {
      const errorMsg = 'Pod not found for job';
      if (logType === 'deploy') {
        response.error = errorMsg;
      } else {
        response.message = errorMsg;
      }
    }

    return response;
  }

  private detectLogType(jobName: string): LogType {
    if (jobName.includes('-buildkit-') || jobName.includes('-kaniko-')) {
      return 'build';
    }
    if (jobName.includes('-helm-')) {
      return 'deploy';
    }
    if (jobName.includes('webhook') || jobName.includes('wh-')) {
      return 'webhook';
    }
    return 'build';
  }

  private mapPodStatusToUnified(podStatus: string): LogStreamResponse['status'] {
    switch (podStatus) {
      case 'Running':
        return 'Active';
      case 'Succeeded':
        return 'Complete';
      case 'Failed':
        return 'Failed';
      case 'Pending':
        return 'Pending';
      case 'NotFound':
        return 'NotFound';
      default:
        return 'Pending';
    }
  }
}
