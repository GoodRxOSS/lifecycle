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
          tail_lines: { type: 'number', description: 'Number of lines from the end of logs (default: 100)' },
          head_lines: {
            type: 'number',
            description:
              'Number of lines from the start of logs (default: 50). Combined with tail_lines for head+tail truncation.',
          },
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
      const headLines = (args.head_lines as number) || 50;

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

      const rawLines = response.body.split('\n');
      const cleanLines = rawLines.map(stripAnsi);
      const dedupedLines = deduplicateLines(cleanLines);

      let finalLines: string[];
      if (dedupedLines.length > headLines + tailLines) {
        const omitted = dedupedLines.length - headLines - tailLines;
        finalLines = [
          ...dedupedLines.slice(0, headLines),
          `... [${omitted} lines omitted of ${dedupedLines.length} total] ...`,
          ...dedupedLines.slice(-tailLines),
        ];
      } else {
        finalLines = dedupedLines;
      }

      const processedLogs = OutputLimiter.truncateLogOutput(finalLines.join('\n'), 30000, headLines, tailLines);

      const displayContent = `Pod logs: ${finalLines.length} lines from ${podName} (${dedupedLines.length} total, head=${headLines} tail=${tailLines})`;

      const result = {
        success: true,
        logs: processedLogs,
      };

      return this.createSuccessResult(JSON.stringify(result), displayContent);
    } catch (error: any) {
      return this.createErrorResult(error.message || 'Failed to fetch pod logs', 'EXECUTION_ERROR');
    }
  }
}
