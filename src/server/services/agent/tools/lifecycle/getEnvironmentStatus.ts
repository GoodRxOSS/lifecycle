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

const MAX_STATE_BLOCK_CHARS = 20000;

export type EnvironmentStatusSessionContext = {
  sessionDbId: number;
  namespace?: string | null;
  buildUuid?: string | null;
};

export class GetEnvironmentStatusTool extends BaseTool {
  static readonly Name = 'get_environment_status';

  // SECURITY: locked to this session's build; the model cannot read other environments' state.
  private sessionContext: EnvironmentStatusSessionContext | null = null;

  constructor() {
    super(
      'Re-check the CURRENT state of THIS environment: build status, each Deploy status, pull request, and fresh failure evidence (triage). Returns a timestamped state block in the same shape as the environment-state conversation events. Use it when state may have changed since the latest state event (a rebuild started, a fix landed, results look stale) instead of assembling state from query_database and get_k8s_resources.',
      { type: 'object', properties: {}, required: [] }
    );
  }

  setSessionContext(context: EnvironmentStatusSessionContext | null): void {
    this.sessionContext = context;
  }

  async execute(_args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (this.checkAborted(signal)) {
      return this.createErrorResult('Operation cancelled', 'CANCELLED');
    }

    if (!this.sessionContext) {
      return this.createErrorResult(
        'Environment status is unavailable: no build is attached to this session.',
        'NO_BUILD_CONTEXT'
      );
    }

    try {
      // Dynamic import: the state service reaches back into agent services that transitively load this tool set.
      const { default: EnvironmentStateService } = await import('server/services/agent/EnvironmentStateService');
      const block = await EnvironmentStateService.renderCurrentState(this.sessionContext);
      return this.createSuccessResult(
        OutputLimiter.truncate(block, MAX_STATE_BLOCK_CHARS),
        'Fetched current environment state'
      );
    } catch (error: any) {
      return this.createErrorResult(
        `${error?.message || 'Failed to fetch environment state'} — fall back to query_database for build/deploy rows.`,
        'EXECUTION_ERROR'
      );
    }
  }
}
