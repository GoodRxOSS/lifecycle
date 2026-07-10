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
import { OutputLimiter } from '../outputLimiter';
import { deduplicateConsecutiveLines, renderLogWindow, searchLogLines } from '../shared/logView';
import { fetchCodefreshLogCached } from './logFetchCache';

const PIPELINE_ID_RE = /^[a-f0-9]{24}$/i;
const DEFAULT_TAIL_LINES = 500;
const DEFAULT_WINDOW_LINES = 200;
const MAX_WINDOW_LINES = 500;
const VIEW_CHAR_CAP = 30000;

export class GetCodefreshLogsTool extends BaseTool {
  static readonly Name = 'get_codefresh_logs';

  constructor() {
    super(
      'Get logs from a Codefresh pipeline build. Use for CODEFRESH type deploys to debug both build and deploy failures. The full log stays server-side and repeat calls are cheap: start with the default tail view, then use search to find the failure signature anywhere in the log (e.g. "error|failed|exit code"), then start_line to read an exact region. CRITICAL: Copy the pipeline_id EXACTLY from the DEPLOYS section - do not retype or modify it. Use buildPipelineId for build failures or deployPipelineId for deploy failures.',
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
              'Tail view only: number of lines from the end of the log (default: 500). The response is still capped at ~30KB, so prefer search or start_line to reach a specific region.',
          },
          search: {
            type: 'string',
            description:
              'Case-insensitive regex matched against each line of the ENTIRE fetched log. Returns up to 50 matching lines with 2 lines of context and absolute line numbers. Use this to find failures that truncation would hide.',
          },
          start_line: {
            type: 'number',
            description:
              '1-based absolute line number to start reading from (search results and headers report these numbers). Returns max_lines lines from there.',
          },
          max_lines: {
            type: 'number',
            description: `With start_line: how many lines to return (default: ${DEFAULT_WINDOW_LINES}, max: ${MAX_WINDOW_LINES}).`,
          },
        },
        required: ['pipeline_id'],
      }
    );
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (this.checkAborted(signal)) {
      return this.createErrorResult('Operation cancelled', 'CANCELLED');
    }

    try {
      const pipelineId = typeof args.pipeline_id === 'string' ? args.pipeline_id.trim() : '';
      const serviceName = args.service_name as string | undefined;
      const search = typeof args.search === 'string' ? args.search.trim() : '';
      const startLine = typeof args.start_line === 'number' ? args.start_line : undefined;

      if (!pipelineId) {
        return this.createErrorResult('Pipeline ID is required', 'INVALID_PARAMETERS');
      }
      if (!PIPELINE_ID_RE.test(pipelineId)) {
        return this.createErrorResult(
          `pipeline_id "${pipelineId}" is not a Codefresh build id (24-character hex). Copy the buildPipelineId/deployPipelineId exactly from the DEPLOYS section.`,
          'INVALID_PARAMETERS'
        );
      }

      const fetched = await fetchCodefreshLogCached(pipelineId);
      if (fetched.ok === false) {
        return this.createErrorResult(
          `Could not fetch logs for pipeline_id ${pipelineId} (${fetched.reason.slice(
            0,
            300
          )}). The id may be wrong or expired, or the build has not started. Verify the buildPipelineId/deployPipelineId from the DEPLOYS section and retry; do NOT assume the build is clean.`,
          'LOGS_UNAVAILABLE'
        );
      }

      // Never report no-data as clean: blank output is retryable-unavailable.
      if (fetched.text.replace(/\s/g, '').length === 0) {
        return this.createErrorResult(
          `No logs returned for pipeline_id ${pipelineId}. It may be wrong, expired, or the build has not started. Verify the buildPipelineId/deployPipelineId from the DEPLOYS section and retry; do NOT assume the build is clean.`,
          'LOGS_UNAVAILABLE'
        );
      }

      const logLines = fetched.text.split('\n');
      const header = this.buildHeader(pipelineId, serviceName, logLines.length, fetched);

      if (search) {
        return this.renderSearchView(header, logLines, search);
      }
      if (startLine !== undefined) {
        const maxLines = Math.min(Math.max(1, (args.max_lines as number) || DEFAULT_WINDOW_LINES), MAX_WINDOW_LINES);
        return this.renderWindowView(header, logLines, startLine, maxLines);
      }
      return this.renderTailView(header, logLines, (args.lines as number) || DEFAULT_TAIL_LINES);
    } catch (error: any) {
      return this.createErrorResult(error.message || 'Failed to fetch Codefresh logs', 'EXECUTION_ERROR');
    }
  }

  private buildHeader(
    pipelineId: string,
    serviceName: string | undefined,
    totalLines: number,
    fetched: { truncatedAtSource: boolean; ageMs: number }
  ): string {
    const notes = [
      fetched.truncatedAtSource ? 'source log exceeded the 24MB fetch cap; oldest lines were dropped' : '',
      fetched.ageMs > 5000 ? `cached ${Math.round(fetched.ageMs / 1000)}s ago` : '',
    ].filter(Boolean);
    return `Codefresh logs for pipeline ${pipelineId}${
      serviceName ? ` (service ${serviceName})` : ''
    }: ${totalLines} lines fetched${notes.length ? ` (${notes.join('; ')})` : ''}.`;
  }

  private renderTailView(header: string, logLines: string[], tailLines: number): ToolResult {
    const dedupedLines = deduplicateConsecutiveLines(logLines);
    const returnedLineCount = Math.min(dedupedLines.length, tailLines);
    const returnedLogs =
      dedupedLines.length > tailLines ? dedupedLines.slice(-tailLines).join('\n') : dedupedLines.join('\n');
    const truncatedLogs = OutputLimiter.truncateLogOutput(returnedLogs, VIEW_CHAR_CAP, 50, 100);

    const agentContent = [
      header,
      `Showing last ${returnedLineCount} of ${dedupedLines.length} deduped lines. To inspect any omitted region, re-call with search="<regex>" (full-log, line-numbered) or start_line=<n>.`,
      `\`\`\`\n${truncatedLogs}\n\`\`\``,
    ].join('\n');
    return this.createSuccessResult(agentContent, `Codefresh logs: ${returnedLineCount} of ${logLines.length} lines`);
  }

  private renderSearchView(header: string, logLines: string[], search: string): ToolResult {
    let view;
    try {
      view = searchLogLines(logLines, search);
    } catch (error: any) {
      return this.createErrorResult(`Invalid search pattern: ${error.message}`, 'INVALID_PARAMETERS');
    }

    if (view.totalMatches === 0) {
      const scope = view.timedOut
        ? `search timed out after scanning ${view.scannedLines} of ${logLines.length} lines`
        : `searched all ${logLines.length} lines`;
      return this.createSuccessResult(
        `${header}\nNo lines match /${search}/i (${scope}). Try a broader pattern, or read a region with start_line.`,
        `Codefresh log search: 0 matches`
      );
    }

    const notes = [
      view.renderedMatches < view.totalMatches
        ? `showing first ${view.renderedMatches}; narrow the pattern or page with start_line`
        : '',
      view.timedOut ? `search timed out after ${view.scannedLines} of ${logLines.length} lines` : '',
    ].filter(Boolean);
    const agentContent = [
      header,
      `${view.totalMatches} lines match /${search}/i${
        notes.length ? ` (${notes.join('; ')})` : ''
      }. Format: "<line>:" match, "<line>-" context; use start_line=<line> to read more around a match.`,
      `\`\`\`\n${view.rendered}\n\`\`\``,
    ].join('\n');
    return this.createSuccessResult(agentContent, `Codefresh log search: ${view.totalMatches} matches`);
  }

  private renderWindowView(header: string, logLines: string[], startLine: number, maxLines: number): ToolResult {
    const view = renderLogWindow(logLines, startLine, maxLines);
    const note = view.charCapped ? ' (output capped at ~28KB; continue from the next line)' : '';
    const agentContent = [
      header,
      `Lines ${view.startLine}–${view.endLine} of ${logLines.length}${note}:`,
      `\`\`\`\n${view.rendered}\n\`\`\``,
    ].join('\n');
    return this.createSuccessResult(
      agentContent,
      `Codefresh logs: lines ${view.startLine}–${view.endLine} of ${logLines.length}`
    );
  }
}
