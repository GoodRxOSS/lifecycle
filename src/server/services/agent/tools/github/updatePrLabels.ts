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
import { ToolExecutionContext, ToolResult } from '../types';
import { GitHubClient, GitHubUserAuthRequiredError, isGitHubUserAuthorizationError } from '../shared/githubClient';
import { GITHUB_USER_AUTH_REQUIRED_CODE } from 'server/services/agent/githubAuth';
import { FallbackLabels } from 'shared/constants';

type LabelAction = 'add' | 'remove' | 'set';
const VALID_ACTIONS: LabelAction[] = ['add', 'remove', 'set'];

// Removing a deploy label tears the whole environment down — never allow it from the agent.
const PROTECTED_LABELS = new Set<string>(
  [FallbackLabels.DEPLOY, FallbackLabels.DEPLOY_STG, FallbackLabels.KEEP].map((label) => label.toLowerCase())
);

function isLabelAction(value: unknown): value is LabelAction {
  return typeof value === 'string' && (VALID_ACTIONS as string[]).includes(value);
}

function normalizeLabelList(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const byLower = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!byLower.has(key)) {
      byLower.set(key, trimmed);
    }
  }
  return Array.from(byLower.values());
}

function applyLabelAction(currentLabels: string[], labels: string[], action: LabelAction): string[] {
  if (action === 'set') {
    return labels;
  }

  if (action === 'add') {
    const byLower = new Map<string, string>();
    for (const label of currentLabels) {
      byLower.set(label.toLowerCase(), label);
    }
    for (const label of labels) {
      const key = label.toLowerCase();
      if (!byLower.has(key)) {
        byLower.set(key, label);
      }
    }
    return Array.from(byLower.values());
  }

  const removeSet = new Set(labels.map((label) => label.toLowerCase()));
  return currentLabels.filter((label) => !removeSet.has(label.toLowerCase()));
}

export class UpdatePrLabelsTool extends BaseTool {
  static readonly Name = 'update_pr_labels';

  constructor(private githubClient: GitHubClient) {
    super(
      'Update pull request labels in GitHub. Supports add/remove/set actions for labels on a PR. Labels must be non-empty. For remove-and-readd, use two calls: remove then add with the specific label name.',
      {
        type: 'object',
        properties: {
          repository_owner: { type: 'string', description: 'Repository owner' },
          repository_name: { type: 'string', description: 'Repository name' },
          pull_request_number: { type: 'number', description: 'Pull request number' },
          action: {
            type: 'string',
            enum: ['add', 'remove', 'set'],
            description: 'Label operation: add, remove, or set (replace all labels)',
          },
          labels: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Labels to add/remove/set',
          },
        },
        required: ['repository_owner', 'repository_name', 'pull_request_number', 'action', 'labels'],
      }
    );
  }

  async execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolExecutionContext
  ): Promise<ToolResult> {
    if (this.checkAborted(signal)) {
      return this.createErrorResult('Operation cancelled', 'CANCELLED');
    }

    let auth: ToolResult['auth'];
    try {
      const owner = args.repository_owner as string;
      const repo = args.repository_name as string;
      const prNumber = args.pull_request_number as number;
      const action = args.action;
      const labels = normalizeLabelList(args.labels);

      if (!this.githubClient.isRepoAllowed(owner, repo)) {
        return this.createErrorResult(
          `Repository "${owner}/${repo}" is outside this environment's repositories and cannot be modified.`,
          'REPO_NOT_ALLOWED'
        );
      }

      // SECURITY: lock label mutations to this build's own pull request.
      const allowedPrNumber = this.githubClient.getAllowedPullRequestNumber();
      if (allowedPrNumber !== null && prNumber !== allowedPrNumber) {
        return this.createErrorResult(
          `Pull request #${prNumber} is outside this environment's pull request #${allowedPrNumber} and cannot be modified.`,
          'PR_NOT_ALLOWED'
        );
      }

      if (!isLabelAction(action)) {
        return this.createErrorResult('Invalid action. Expected one of: add, remove, set', 'INVALID_ACTION');
      }

      if (labels.length === 0) {
        return this.createErrorResult('At least one non-empty label is required', 'INVALID_LABELS');
      }

      const octokitWithAuth = await this.githubClient.getOctokitWithAuth('agent-runtime-update-pr-labels', {
        requireUserAuth: true,
        toolCallId: context?.toolCallId,
      });
      const octokit = octokitWithAuth.octokit;
      auth = octokitWithAuth.auth;

      const current = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner,
        repo,
        issue_number: prNumber,
      });
      const currentLabels: string[] = (current.data.labels || []).map((label: any) => label.name).filter(Boolean);

      const updatedLabels = applyLabelAction(currentLabels, labels, action);

      const updatedSet = new Set(updatedLabels.map((label) => label.toLowerCase()));
      const droppedProtected = currentLabels.filter(
        (label) => PROTECTED_LABELS.has(label.toLowerCase()) && !updatedSet.has(label.toLowerCase())
      );
      if (droppedProtected.length > 0) {
        return {
          ...this.createErrorResult(
            `Refusing to remove protected label(s) [${droppedProtected.join(
              ', '
            )}]: removing a deploy label tears down this environment. Use trigger_redeploy to redeploy instead.`,
            'PROTECTED_LABEL'
          ),
          auth,
        };
      }

      await octokit.request('PUT /repos/{owner}/{repo}/issues/{issue_number}/labels', {
        owner,
        repo,
        issue_number: prNumber,
        labels: updatedLabels,
      });

      const result = {
        success: true,
        action,
        labelsBefore: currentLabels,
        labelsAfter: updatedLabels,
      };
      const displayContent = `Updated PR #${prNumber} labels (${updatedLabels.length} total)`;
      return { ...this.createSuccessResult(JSON.stringify(result), displayContent), auth };
    } catch (error: any) {
      if (error instanceof GitHubUserAuthRequiredError) {
        return { ...this.createErrorResult(error.message, GITHUB_USER_AUTH_REQUIRED_CODE), auth: error.auth };
      }
      if (isGitHubUserAuthorizationError(error)) {
        return {
          ...this.createErrorResult(
            'GitHub authorization is required to apply this repair. Reconnect GitHub and approve again.',
            GITHUB_USER_AUTH_REQUIRED_CODE
          ),
          auth,
        };
      }
      return {
        ...this.createErrorResult(error.message || 'Failed to update pull request labels', 'EXECUTION_ERROR'),
        auth,
      };
    }
  }
}
