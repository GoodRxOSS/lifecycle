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

import { BaseTool } from '../baseTool';
import { ToolResult } from '../types';
import { K8sClient } from '../shared/k8sClient';
import { OutputLimiter } from '../outputLimiter';

function stripAnsi(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07]*\x07/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  );
}

function deduplicateLines(lines: string[]): string[] {
  const result: string[] = [];
  let lastLine = '';
  let count = 1;
  for (const line of lines) {
    if (line === lastLine) {
      count++;
    } else {
      if (count > 1) result.push(`[repeated ${count}x] ${lastLine}`);
      else if (lastLine) result.push(lastLine);
      lastLine = line;
      count = 1;
    }
  }
  if (count > 1) result.push(`[repeated ${count}x] ${lastLine}`);
  else if (lastLine) result.push(lastLine);
  return result;
}

export class GetLifecycleLogsTool extends BaseTool {
  static readonly Name = 'get_lifecycle_logs';

  // SECURITY: filter logs to this build's UUID so a model can't read another build's logs.
  private allowedBuildUuid: string | null = null;

  constructor(private k8sClient: K8sClient) {
    super(
      'LAST RESORT: fetch Lifecycle CONTROL-PLANE (orchestrator) logs filtered to this build. These are internal scheduling/webhook/queue logs — they rarely contain the application or build error itself. Use ONLY when deploy statuses, pod logs, k8s events, and persisted buildOutput do not explain the failure (e.g. suspected webhook or orchestration problem). For service/build errors use get_pod_logs or query_database deploys select:["buildOutput"] instead. build_uuid defaults to this build; any other build UUID is rejected.',
      {
        type: 'object',
        properties: {
          build_uuid: {
            type: 'string',
            description:
              "Optional. Defaults to this build's UUID. If provided, it MUST equal this build's UUID; any other value is rejected.",
          },
          service_type: {
            type: 'string',
            description:
              'Which Lifecycle service to get logs from: "worker" (handles builds/deploys), "web" (handles webhooks), or "all" (both). Default: "worker"',
            enum: ['worker', 'web', 'all'],
          },
          tail_lines: { type: 'number', description: 'Number of recent log lines per pod to fetch (default: 200)' },
          since_minutes: { type: 'number', description: 'Get logs from the last N minutes (default: 30, max: 60)' },
          correlation_id: {
            type: 'string',
            description:
              'Optional: directly filter by correlation ID instead of discovering it from build UUID. Useful for follow-up queries.',
          },
        },
        required: [],
      }
    );
  }

  setAllowedBuildUuid(buildUuid: string | null | undefined): void {
    this.allowedBuildUuid = buildUuid?.trim() || null;
  }

  private resolveBuildUuid(requested: string | null | undefined): string {
    const allowed = this.allowedBuildUuid;
    const requestedTrimmed = requested?.trim() || null;

    if (!allowed) {
      if (!requestedTrimmed) {
        throw new Error('build_uuid is required');
      }
      return requestedTrimmed;
    }

    if (!requestedTrimmed) {
      return allowed;
    }

    if (requestedTrimmed !== allowed) {
      throw new Error(
        `build_uuid "${requestedTrimmed}" is outside this environment's build "${allowed}" and cannot be accessed.`
      );
    }

    return allowed;
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (this.checkAborted(signal)) {
      return this.createErrorResult('Operation cancelled', 'CANCELLED');
    }

    let buildUuid: string;
    try {
      // SECURITY: lock to this build's UUID; reject any foreign build UUID.
      buildUuid = this.resolveBuildUuid(args.build_uuid as string | undefined);
    } catch (error: any) {
      return this.createErrorResult(error.message || 'build_uuid not allowed', 'BUILD_NOT_ALLOWED');
    }

    try {
      const serviceType = (args.service_type as string) || 'worker';
      const tailLines = (args.tail_lines as number) || 200;
      const sinceMinutes = (args.since_minutes as number) || 30;
      const providedCorrelationId = args.correlation_id as string | undefined;

      const namespace = 'lifecycle-app';
      const deployments: string[] = [];

      if (serviceType === 'worker' || serviceType === 'all') {
        deployments.push('worker');
      }
      if (serviceType === 'web' || serviceType === 'all') {
        deployments.push('web');
      }

      const validatedSinceMinutes = Math.min(sinceMinutes, 60);
      const sinceSeconds = validatedSinceMinutes * 60;

      const errors: string[] = [];

      const rawLogsByPod = await this.fetchPodLogs(namespace, deployments, sinceSeconds, tailLines, errors);

      const buildMatchedLines = this.filterLines(
        rawLogsByPod,
        (line) =>
          line.includes(buildUuid) ||
          line.includes(`[${buildUuid}]`) ||
          line.includes(`[BUILD ${buildUuid}]`) ||
          line.includes(`[DEPLOY ${buildUuid}]`)
      );

      const correlationIds = new Set<string>();
      if (providedCorrelationId) {
        correlationIds.add(providedCorrelationId);
      }
      for (const entry of buildMatchedLines) {
        for (const line of entry.logs) {
          const extracted = this.extractCorrelationId(line);
          if (extracted) correlationIds.add(extracted);
        }
      }

      let correlationMatchedLines: Array<{ pod: string; service: string; logs: string[] }> = [];
      let expandedByCorrelation = false;

      if (correlationIds.size > 0) {
        correlationMatchedLines = this.filterLines(rawLogsByPod, (line) => {
          for (const cid of correlationIds) {
            if (line.includes(cid)) return true;
          }
          return false;
        });
        expandedByCorrelation = correlationMatchedLines.some((entry) => entry.logs.length > 0);
      }

      const finalLogs = expandedByCorrelation ? correlationMatchedLines : buildMatchedLines;
      let totalMatchingLines = 0;
      for (const entry of finalLogs) {
        totalMatchingLines += entry.logs.length;
      }

      if (totalMatchingLines === 0 && errors.length === 0) {
        return this.createSuccessResult(
          `No control-plane logs found for build UUID ${buildUuid} in ${serviceType} service(s) over the last ${validatedSinceMinutes} minutes.`,
          `No logs found for ${buildUuid}`
        );
      }

      let combinedLogs = '';
      const podsChecked = finalLogs.filter((l) => l.logs.length > 0).length;
      for (const logEntry of finalLogs) {
        const podPrefix = `[${logEntry.service}/${logEntry.pod}]`;
        const cleanLines = deduplicateLines(logEntry.logs.map(stripAnsi));
        for (const line of cleanLines) {
          combinedLogs += `${podPrefix} ${line}\n`;
        }
      }

      const truncatedLogs = OutputLimiter.truncateLogOutput(combinedLogs.trim(), 12000, 30, 60);

      const displayContent = `Lifecycle logs: ${totalMatchingLines} lines from ${podsChecked} pods`;

      const headerNotes = [
        ...(correlationIds.size > 0
          ? [`correlationIds=${Array.from(correlationIds).join(',')} expandedByCorrelation=${expandedByCorrelation}`]
          : []),
        ...(errors.length > 0 ? [`warnings: ${errors.join('; ')}`] : []),
      ];
      const agentContent = [
        `Lifecycle control-plane logs for build ${buildUuid} (${serviceType}, last ${validatedSinceMinutes} minutes): ${totalMatchingLines} matching lines from ${podsChecked} pod(s).`,
        ...headerNotes,
        `\`\`\`\n${truncatedLogs}\n\`\`\``,
      ].join('\n');

      return this.createSuccessResult(agentContent, displayContent);
    } catch (error: any) {
      return this.createErrorResult(`Failed to fetch Lifecycle logs: ${error.message}`, 'EXECUTION_ERROR');
    }
  }

  private async fetchPodLogs(
    namespace: string,
    deployments: string[],
    sinceSeconds: number,
    tailLines: number,
    errors: string[]
  ): Promise<Array<{ pod: string; service: string; lines: string[] }>> {
    const results: Array<{ pod: string; service: string; lines: string[] }> = [];

    for (const deploymentName of deployments) {
      try {
        const podsResponse = await this.k8sClient.coreApi.listNamespacedPod(
          namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `app.kubernetes.io/instance=lifecycle,app.kubernetes.io/component=${deploymentName}`
        );

        if (!podsResponse.body.items || podsResponse.body.items.length === 0) {
          errors.push(`No pods found for ${deploymentName}`);
          continue;
        }

        for (const pod of podsResponse.body.items) {
          if (!pod.metadata?.name) continue;

          try {
            const logResponse = await this.k8sClient.coreApi.readNamespacedPodLog(
              pod.metadata.name,
              namespace,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              sinceSeconds,
              tailLines
            );

            if (logResponse.body) {
              results.push({
                pod: pod.metadata.name,
                service: deploymentName,
                lines: logResponse.body.split('\n'),
              });
            }
          } catch (podError: any) {
            errors.push(`Failed to get logs from pod ${pod.metadata.name}: ${podError.message}`);
          }
        }
      } catch (deploymentError: any) {
        errors.push(`Failed to process deployment ${deploymentName}: ${deploymentError.message}`);
      }
    }

    return results;
  }

  private filterLines(
    rawLogs: Array<{ pod: string; service: string; lines: string[] }>,
    predicate: (line: string) => boolean
  ): Array<{ pod: string; service: string; logs: string[] }> {
    const results: Array<{ pod: string; service: string; logs: string[] }> = [];

    for (const entry of rawLogs) {
      const matched = entry.lines.filter(predicate);
      results.push({ pod: entry.pod, service: entry.service, logs: matched });
    }

    return results;
  }

  private extractCorrelationId(line: string): string | null {
    try {
      const parsed = JSON.parse(line);
      if (parsed.correlationId && parsed.correlationId !== 'unknown') {
        return parsed.correlationId;
      }
    } catch {
      const match = line.match(/"correlationId"\s*:\s*"([^"]+)"/);
      if (match && match[1] !== 'unknown') return match[1];
    }
    return null;
  }
}
