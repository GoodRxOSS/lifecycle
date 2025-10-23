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

export class GetPodLogsTool extends BaseTool {
  static readonly Name = 'get_pod_logs';

  constructor(private k8sClient: K8sClient) {
    super(
      'Fetch recent logs from a specific pod. Use this to diagnose application errors.',
      {
        type: 'object',
        properties: {
          pod_name: { type: 'string', description: 'The pod name' },
          namespace: { type: 'string', description: 'The Kubernetes namespace' },
          container: { type: 'string', description: 'Optional specific container name' },
          tail_lines: { type: 'number', description: 'Number of log lines to fetch (default: 100)' },
        },
        required: ['pod_name', 'namespace'],
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
      const podName = args.pod_name as string;
      const namespace = args.namespace as string;
      const container = args.container as string | undefined;
      const tailLines = (args.tail_lines as number) || 100;

      const response = await this.k8sClient.coreApi.readNamespacedPodLog(
        podName,
        namespace,
        container,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tailLines
      );

      const result = {
        success: true,
        logs: response.body,
      };

      return this.createSuccessResult(JSON.stringify(result));
    } catch (error: any) {
      return this.createErrorResult(error.message || 'Failed to fetch pod logs', 'EXECUTION_ERROR');
    }
  }
}
