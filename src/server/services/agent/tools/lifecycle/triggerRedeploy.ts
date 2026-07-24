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

import { nanoid } from 'nanoid';
import { BaseTool } from '../baseTool';
import { ToolResult } from '../types';

export class TriggerRedeployTool extends BaseTool {
  static readonly Name = 'trigger_redeploy';

  // SECURITY: locked to this session's build; the model cannot redeploy other environments.
  private allowedBuildUuid: string | null = null;

  // The watch outcome must post to the initiating chat, not the most-recently-active session on the build.
  private watchTarget: { threadUuid: string; sessionUuid: string | null } | null = null;

  constructor() {
    super(
      'Queue a rebuild+redeploy of THIS environment from its current PR branch, without a new commit. Use after a repair commit when no webhook rebuild was observed, or when a failure looks transient (timeout, registry hiccup) and the configuration is already correct. Do not use it to apply config changes — commit those with update_file first.',
      {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'One short sentence on why a redeploy should resolve the issue.',
          },
        },
        required: ['reason'],
      }
    );
  }

  setAllowedBuildUuid(buildUuid: string | null | undefined): void {
    this.allowedBuildUuid = buildUuid?.trim() || null;
  }

  setWatchTarget(target: { threadUuid: string; sessionUuid: string | null } | null): void {
    this.watchTarget = target?.threadUuid ? target : null;
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (this.checkAborted(signal)) {
      return this.createErrorResult('Operation cancelled', 'CANCELLED');
    }

    const buildUuid = this.allowedBuildUuid;
    if (!buildUuid) {
      return this.createErrorResult('No build is associated with this session.', 'BUILD_NOT_ALLOWED');
    }

    try {
      // Lazy imports keep BuildService out of the agent tool module graph.
      const [{ default: Build }, { default: BuildService }] = await Promise.all([
        import('server/models/Build'),
        import('server/services/build'),
      ]);

      const build = await Build.query().findOne({ uuid: buildUuid });
      if (!build) {
        return this.createErrorResult(`Build not found for ${buildUuid}`, 'BUILD_NOT_FOUND');
      }

      const correlationId = `agent-redeploy-${Date.now()}-${nanoid(8)}`;
      await new BuildService().resolveAndDeployBuildQueue.add('resolve-deploy', {
        buildId: build.id,
        runUUID: nanoid(),
        correlationId,
      });

      const { default: EnvironmentWatchService } = await import('server/services/agent/EnvironmentWatchService');
      void EnvironmentWatchService.scheduleEnvironmentWatch({
        buildId: build.id,
        buildUuid,
        reason: 'trigger_redeploy',
        baselineStatus: build.status ? String(build.status) : null,
        ...(this.watchTarget
          ? { threadUuid: this.watchTarget.threadUuid, sessionUuid: this.watchTarget.sessionUuid }
          : {}),
      });

      const result = {
        success: true,
        message: `Redeploy queued for ${buildUuid}. The rebuild outcome will be reported in this chat when it finishes.`,
        buildUuid,
        statusBefore: build.status,
        reason: typeof args.reason === 'string' ? args.reason : null,
      };
      return this.createSuccessResult(JSON.stringify(result), `Redeploy queued for ${buildUuid}`);
    } catch (error: any) {
      return this.createErrorResult(error.message || 'Failed to queue redeploy', 'EXECUTION_ERROR');
    }
  }
}
