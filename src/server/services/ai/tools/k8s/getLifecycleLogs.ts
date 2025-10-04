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

export class GetLifecycleLogsTool extends BaseTool {
  static readonly Name = 'get_lifecycle_logs';

  constructor(private k8sClient: K8sClient) {
    super(
      'Fetch logs from the Lifecycle control plane services (lifecycle-worker or lifecycle-web pods in lifecycle-app namespace), filtered by build UUID. Use this to diagnose issues with Lifecycle itself - environment provisioning, build orchestration, or deployment coordination. For user service logs, use get_pod_logs instead.',
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
          tail_lines: { type: 'number', description: 'Number of recent log lines per pod to fetch (default: 500)' },
          since_minutes: { type: 'number', description: 'Get logs from the last N minutes (default: 30, max: 60)' },
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
      const tailLines = (args.tail_lines as number) || 500;
      const sinceMinutes = (args.since_minutes as number) || 30;

      const namespace = 'lifecycle-app';
      const deployments: string[] = [];

      if (serviceType === 'worker' || serviceType === 'all') {
        deployments.push('lifecycle-worker');
      }
      if (serviceType === 'web' || serviceType === 'all') {
        deployments.push('lifecycle-web');
      }

      const validatedSinceMinutes = Math.min(sinceMinutes, 60);
      const sinceSeconds = validatedSinceMinutes * 60;

      const allLogs: Array<{ pod: string; service: string; logs: string[] }> = [];
      let totalMatchingLines = 0;
      const errors: string[] = [];

      for (const deploymentName of deployments) {
        try {
          const podsResponse = await this.k8sClient.coreApi.listNamespacedPod(
            namespace,
            undefined,
            undefined,
            undefined,
            undefined,
            `app=${deploymentName}`
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
                const lines = logResponse.body.split('\n');
                const filteredLines = lines.filter(
                  (line) =>
                    line.includes(buildUuid) ||
                    line.includes(`[${buildUuid}]`) ||
                    line.includes(`[BUILD ${buildUuid}]`) ||
                    line.includes(`[DEPLOY ${buildUuid}]`)
                );

                if (filteredLines.length > 0) {
                  allLogs.push({
                    pod: pod.metadata.name,
                    service: deploymentName,
                    logs: filteredLines,
                  });
                  totalMatchingLines += filteredLines.length;
                }
              }
            } catch (podError: any) {
              errors.push(`Failed to get logs from pod ${pod.metadata.name}: ${podError.message}`);
            }
          }
        } catch (deploymentError: any) {
          errors.push(`Failed to process deployment ${deploymentName}: ${deploymentError.message}`);
        }
      }

      if (allLogs.length === 0 && errors.length === 0) {
        const result = {
          success: true,
          message: `No logs found for build UUID ${buildUuid} in ${serviceType} service(s)`,
          buildUuid,
          serviceType,
          timeRange: `Last ${validatedSinceMinutes} minutes`,
          podsChecked: 0,
          totalMatchingLines: 0,
        };
        return this.createSuccessResult(JSON.stringify(result));
      }

      let combinedLogs = '';
      for (const logEntry of allLogs) {
        const podPrefix = `[${logEntry.service}/${logEntry.pod}]`;
        for (const line of logEntry.logs) {
          combinedLogs += `${podPrefix} ${line}\n`;
        }
      }

      const result = {
        success: true,
        logs: combinedLogs.trim(),
        buildUuid,
        serviceType,
        timeRange: `Last ${validatedSinceMinutes} minutes`,
        podsChecked: allLogs.length,
        totalMatchingLines,
        podDetails: allLogs.map((l) => ({
          pod: l.pod,
          service: l.service,
          matchingLines: l.logs.length,
        })),
        ...(errors.length > 0 && { warnings: errors }),
      };

      return this.createSuccessResult(JSON.stringify(result));
    } catch (error: any) {
      return this.createErrorResult(`Failed to fetch Lifecycle logs: ${error.message}`, 'EXECUTION_ERROR', true);
    }
  }
}
