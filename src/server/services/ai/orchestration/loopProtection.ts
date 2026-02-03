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

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  iteration: number;
  timestamp: number;
}

export interface LoopProtection {
  maxIterations: number;
  maxToolCalls: number;
  maxRepeatedCalls: number;
  toolCallHistory: ToolCallRecord[];
}

export class LoopDetector {
  private protection: LoopProtection;

  constructor(options?: Partial<LoopProtection>) {
    this.protection = {
      maxIterations: options?.maxIterations || 20,
      maxToolCalls: options?.maxToolCalls || 50,
      maxRepeatedCalls: options?.maxRepeatedCalls || 1,
      toolCallHistory: [],
    };
  }

  recordCall(toolName: string, args: Record<string, unknown>, iteration: number): void {
    this.protection.toolCallHistory.push({
      tool: toolName,
      args,
      iteration,
      timestamp: Date.now(),
    });
  }

  countRepeatedCalls(toolName: string, args: Record<string, unknown>, currentIteration: number): number {
    return this.protection.toolCallHistory.filter((record) => {
      if (currentIteration - record.iteration > 5) {
        return false;
      }

      if (record.tool !== toolName) {
        return false;
      }

      if (JSON.stringify(record.args) === JSON.stringify(args)) {
        return true;
      }

      if (toolName === 'get_file' && args.file_path && record.args.file_path === args.file_path) {
        return true;
      }

      return false;
    }).length;
  }

  getLoopHint(toolName: string, args: Record<string, unknown>): string {
    if (toolName === 'get_file') {
      return (
        `You already read ${args.file_path || 'this file'}. ` +
        'Use the content from the previous result instead of re-fetching.'
      );
    }

    if (toolName === 'get_k8s_resources' && !args.name) {
      return (
        'You keep searching for resources with the same criteria. ' +
        "If resources don't exist, check deployment status instead."
      );
    }

    if (toolName === 'get_pod_logs') {
      return (
        "Repeatedly fetching logs suggests the pattern isn't found. " +
        'Try a different search term or check a different service.'
      );
    }

    return 'Consider trying a different tool or different arguments.';
  }

  getProtection(): LoopProtection {
    return this.protection;
  }

  reset(): void {
    this.protection.toolCallHistory = [];
  }
}
