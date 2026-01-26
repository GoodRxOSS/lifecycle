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
import { ToolResult, ToolSafetyLevel } from '../../types/tool';
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

  constructor(private k8sClient: K8sClient) {
    super(
      'Fetch logs from the Lifecycle control plane services (lifecycle-worker or lifecycle-web pods in lifecycle-app namespace), filtered by build UUID and correlation ID. First finds logs matching the build UUID, extracts correlationId from matched structured log lines, then expands the search to include all logs sharing that correlationId. This gives a complete picture of the request lifecycle across services. For user service logs, use get_pod_logs instead.',
      {
        type: 'object',
        properties: {
          build_uuid: { type: 'string', description: 'The build UUID to filter logs for' },
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
        required: ['build_uuid'],
      },
      ToolSafetyLevel.SAFE,
      'k8s'
    );
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (this.checkAborted(signal)) {
      return this.createErrorResult('Operation cancelled', 'CANCELLED', false);
    }

    try {
      const buildUuid = args.build_uuid as string;
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
        const result = {
          success: true,
          message: `No logs found for build UUID ${buildUuid} in ${serviceType} service(s)`,
          buildUuid,
          serviceType,
          timeRange: `Last ${validatedSinceMinutes} minutes`,
          podsChecked: 0,
          totalMatchingLines: 0,
        };
        return this.createSuccessResult(JSON.stringify(result), `No logs found for ${buildUuid}`);
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

      const truncatedLogs = OutputLimiter.truncateLogOutput(combinedLogs.trim(), 30000, 50, 100);

      const displayContent = `Lifecycle logs: ${totalMatchingLines} lines from ${podsChecked} pods`;

      const result = {
        success: true,
        logs: truncatedLogs,
        buildUuid,
        serviceType,
        timeRange: `Last ${validatedSinceMinutes} minutes`,
        podsChecked,
        totalMatchingLines,
        ...(correlationIds.size > 0 && {
          correlationIds: Array.from(correlationIds),
          expandedByCorrelation,
        }),
        podDetails: finalLogs
          .filter((l) => l.logs.length > 0)
          .map((l) => ({
            pod: l.pod,
            service: l.service,
            matchingLines: l.logs.length,
          })),
        ...(errors.length > 0 && { warnings: errors }),
      };

      return this.createSuccessResult(JSON.stringify(result), displayContent);
    } catch (error: any) {
      return this.createErrorResult(`Failed to fetch Lifecycle logs: ${error.message}`, 'EXECUTION_ERROR', true);
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
