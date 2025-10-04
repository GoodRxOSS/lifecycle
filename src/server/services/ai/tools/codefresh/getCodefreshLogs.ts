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
import { getLogs } from 'server/lib/codefresh';

export class GetCodefreshLogsTool extends BaseTool {
  static readonly Name = 'get_codefresh_logs';

  constructor() {
    super(
      'Get logs from a Codefresh pipeline build. Use for CODEFRESH type deploys to debug both build and deploy failures. CRITICAL: Copy the pipeline_id EXACTLY from the DEPLOYS section - do not retype or modify it. Use buildPipelineId for build failures or deployPipelineId for deploy failures.',
      {
        type: 'object',
        properties: {
          pipeline_id: {
            type: 'string',
            description:
              'Codefresh pipeline ID (buildPipelineId or deployPipelineId from deploy). MUST be copied exactly - it is a 24-character hex ObjectId. Do NOT retype it.',
          },
          service_name: {
            type: 'string',
            description: 'Optional service name for context',
          },
          lines: {
            type: 'number',
            description:
              'Number of lines to fetch from the end of logs (default: 1000). Use more if you need additional context.',
          },
        },
        required: ['pipeline_id'],
      },
      ToolSafetyLevel.SAFE,
      'codefresh'
    );
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (this.checkAborted(signal)) {
      return this.createErrorResult('Operation cancelled', 'CANCELLED', false);
    }

    try {
      const pipelineId = args.pipeline_id as string;
      const serviceName = args.service_name as string | undefined;
      const lines = args.lines as number | undefined;

      if (!pipelineId) {
        return this.createErrorResult('Pipeline ID is required', 'INVALID_PARAMETERS');
      }

      const maxLines = lines || 1000;

      const logs = await getLogs(pipelineId);

      const sanitizedLogs = String(logs)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

      const logLines = sanitizedLogs.split('\n');
      const totalLines = logLines.length;

      let returnedLogs: string;
      if (totalLines > maxLines) {
        const lastLines = logLines.slice(-maxLines);
        returnedLogs = lastLines.join('\n');
      } else {
        returnedLogs = sanitizedLogs;
      }

      const result = {
        success: true,
        logs: returnedLogs,
        pipelineId,
        serviceName: serviceName || undefined,
        totalLines,
        returnedLines: Math.min(totalLines, maxLines),
      };

      return this.createSuccessResult(JSON.stringify(result));
    } catch (error: any) {
      return this.createErrorResult(error.message || 'Failed to fetch Codefresh logs', 'EXECUTION_ERROR');
    }
  }
}
