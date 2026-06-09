/**
 * Copyright 2026 GoodRx, Inc.
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

import { BaseTool } from '../baseTool';
import { ToolResult } from '../types';

const MAX_LOG_CHARS = 15000;

const DESCRIPTION =
  'Get the persisted build or deploy logs for a service of THIS environment. This is the decisive evidence for build_failed and deploy_failed — prefer it over query_database/get_lifecycle_logs.';

const PARAMETERS = {
  type: 'object',
  properties: {
    service_name: {
      type: 'string',
      description: 'The service (Deploy) name exactly as listed in the DEPLOYS section of the snapshot.',
    },
    phase: {
      type: 'string',
      enum: ['build', 'deploy'],
      description: 'Optional: which job logs to prefer when falling back to live job pods.',
    },
  },
  required: ['service_name'],
};

function tailText(content: string, maxChars: number): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `[... truncated, showing last ${maxChars} of ${trimmed.length} chars]\n${trimmed.slice(-maxChars)}`;
}

export class GetBuildLogsTool extends BaseTool {
  static readonly Name = 'get_build_logs';

  // SECURITY: locked to this session's build; the model cannot read other environments' logs.
  private allowedBuildUuid: string | null = null;

  constructor() {
    // BaseTool constructor signature is in flux; keep super() one line.
    super(DESCRIPTION, PARAMETERS);
  }

  setAllowedBuildUuid(buildUuid: string | null | undefined): void {
    this.allowedBuildUuid = buildUuid?.trim() || null;
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (this.checkAborted(signal)) {
      return this.createErrorResult('Operation cancelled', 'CANCELLED');
    }

    const buildUuid = this.allowedBuildUuid;
    if (!buildUuid) {
      return this.createErrorResult('No build is associated with this session.', 'BUILD_NOT_ALLOWED');
    }

    const serviceName = typeof args.service_name === 'string' ? args.service_name.trim() : '';
    if (!serviceName) {
      return this.createErrorResult('service_name is required.', 'INVALID_ARGS');
    }
    const phase = args.phase === 'build' || args.phase === 'deploy' ? args.phase : undefined;

    try {
      const { default: Deploy } = await import('server/models/Deploy');
      const deploy = await Deploy.query()
        .findOne({ uuid: `${serviceName}-${buildUuid}` })
        .withGraphFetched('[build]');

      if (!deploy) {
        return this.createErrorResult(
          `No deploy named "${serviceName}" in this environment (looked up ${serviceName}-${buildUuid}).`,
          'DEPLOY_NOT_FOUND'
        );
      }

      const persisted = deploy.buildOutput?.trim();
      if (persisted) {
        const text = [
          `Persisted ${phase || 'build/deploy'} logs for ${serviceName} (status=${deploy.status}, tail of ${
            persisted.length
          } chars):`,
          '```',
          tailText(persisted, MAX_LOG_CHARS),
          '```',
        ].join('\n');
        return this.createSuccessResult(text, `Build logs: ${serviceName} (persisted, ${persisted.length} chars)`);
      }

      const liveLogs = await this.readJobPodLogs(deploy.uuid, deploy.build?.namespace, phase);
      if (liveLogs) {
        return this.createSuccessResult(liveLogs.text, liveLogs.display);
      }

      return this.createSuccessResult(
        `No logs available for ${serviceName}: buildOutput is empty and no live ${
          phase || 'build/deploy'
        } job pod logs could be read. The job pods may have been garbage-collected; try get_pod_logs on application pods or get_k8s_resources events instead.`,
        `Build logs: ${serviceName} (unavailable)`
      );
    } catch (error: any) {
      return this.createErrorResult(error.message || 'Failed to fetch build logs', 'EXECUTION_ERROR');
    }
  }

  private async readJobPodLogs(
    deployUuid: string,
    namespace: string | undefined,
    phase?: 'build' | 'deploy'
  ): Promise<{ text: string; display: string } | null> {
    if (!namespace) {
      return null;
    }

    try {
      const { K8sClient } = await import('../shared/k8sClient');
      const client = new K8sClient();
      const resp = await client.coreApi.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `deploy_uuid=${deployUuid}`
      );
      const markers = phase ? [`-${phase}-`] : ['-build-', '-deploy-'];
      const jobPods = (resp.body.items || [])
        .filter((pod) => markers.some((marker) => pod.metadata?.name?.includes(marker)))
        .sort(
          (a, b) =>
            new Date(b.metadata?.creationTimestamp || 0).getTime() -
            new Date(a.metadata?.creationTimestamp || 0).getTime()
        );

      const pod = jobPods[0];
      if (!pod?.metadata?.name) {
        return null;
      }

      const logResp = await client.coreApi.readNamespacedPodLog(pod.metadata.name, namespace);
      const logs = logResp.body?.trim();
      if (!logs) {
        return null;
      }

      const inferredPhase = phase || (pod.metadata.name.includes('-build-') ? 'build' : 'deploy');
      const text = [
        `Live ${inferredPhase} job logs from pod ${pod.metadata.name} (buildOutput not yet persisted, tail of ${logs.length} chars):`,
        '```',
        tailText(logs, MAX_LOG_CHARS),
        '```',
      ].join('\n');
      return { text, display: `Build logs: ${pod.metadata.name} (live job pod)` };
    } catch {
      return null;
    }
  }
}
