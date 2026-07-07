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
import { OutputLimiter } from '../outputLimiter';
import { sanitizeLogText, searchLogLines } from '../shared/logView';

const MAX_LOG_CHARS = 15000;

const DESCRIPTION =
  'Get the persisted build or deploy logs for a service of THIS environment. This is the decisive evidence for build_failed and deploy_failed — prefer it over query_database/get_lifecycle_logs. The full log stays server-side: use search to find failures the truncated view omits.';

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
    search: {
      type: 'string',
      description:
        'Case-insensitive regex matched against each line of the ENTIRE log. Returns matching lines with context and absolute line numbers instead of the truncated view.',
    },
  },
  required: ['service_name'],
};

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
    const search = typeof args.search === 'string' ? args.search.trim() : '';

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
        return this.renderLogs(
          sanitizeLogText(persisted),
          `Persisted ${phase || 'build/deploy'} logs for ${serviceName} (status=${deploy.status})`,
          `Build logs: ${serviceName} (persisted, ${persisted.length} chars)`,
          search
        );
      }

      const liveLogs = await this.readJobPodLogs(deploy.uuid, deploy.build?.namespace, phase);
      if (liveLogs) {
        return this.renderLogs(
          sanitizeLogText(liveLogs.logs),
          `Live ${liveLogs.phase} job logs from pod ${liveLogs.podName} (buildOutput not yet persisted)`,
          `Build logs: ${liveLogs.podName} (live job pod)`,
          search
        );
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

  private renderLogs(text: string, headerLabel: string, display: string, search: string): ToolResult {
    const logLines = text.split('\n');

    if (search) {
      let view;
      try {
        view = searchLogLines(logLines, search, { maxChars: MAX_LOG_CHARS - 2000 });
      } catch (error: any) {
        return this.createErrorResult(`Invalid search pattern: ${error.message}`, 'INVALID_PARAMETERS');
      }
      if (view.totalMatches === 0) {
        return this.createSuccessResult(
          `${headerLabel}: no lines match /${search}/i (searched all ${logLines.length} lines). Try a broader pattern, or drop search for the truncated view.`,
          `Build log search: 0 matches`
        );
      }
      const capNote =
        view.renderedMatches < view.totalMatches ? ` (showing first ${view.renderedMatches}; narrow the pattern)` : '';
      const agentContent = [
        `${headerLabel}: ${view.totalMatches} of ${logLines.length} lines match /${search}/i${capNote}. Format: "<line>:" match, "<line>-" context.`,
        `\`\`\`\n${view.rendered}\n\`\`\``,
      ].join('\n');
      return this.createSuccessResult(agentContent, `Build log search: ${view.totalMatches} matches`);
    }

    const truncated = OutputLimiter.truncateLogOutput(text, MAX_LOG_CHARS, 25, 60);
    const agentContent = [
      `${headerLabel}: ${logLines.length} lines total. To inspect omitted regions, re-call with search="<regex>".`,
      `\`\`\`\n${truncated}\n\`\`\``,
    ].join('\n');
    return this.createSuccessResult(agentContent, display);
  }

  private async readJobPodLogs(
    deployUuid: string,
    namespace: string | undefined,
    phase?: 'build' | 'deploy'
  ): Promise<{ logs: string; podName: string; phase: string } | null> {
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
      return { logs, podName: pod.metadata.name, phase: inferredPhase };
    } catch {
      return null;
    }
  }
}
