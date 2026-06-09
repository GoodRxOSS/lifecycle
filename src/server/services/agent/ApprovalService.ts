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

import AgentPendingAction from 'server/models/AgentPendingAction';
import AgentRun from 'server/models/AgentRun';
import type AgentThread from 'server/models/AgentThread';
import type { Transaction } from 'objection';
import type {
  AgentApprovalPolicy,
  AgentCapabilityKey,
  AgentFileChangeData,
  AgentPendingActionStatus,
  AgentUIMessage,
} from './types';
import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';
import { listMessageFileChanges } from './fileChanges';
import AgentThreadService from './ThreadService';
import AgentRunQueueService from './RunQueueService';
import ApprovalGitHubAuthHandoffService from './ApprovalGitHubAuthHandoffService';
import AgentRunEventService from './RunEventService';
import AgentPolicyService from './PolicyService';
import { buildAgentToolKey, LIFECYCLE_BUILTIN_SERVER_SLUG } from './toolKeys';
import type { AgentRuntimeToolMetadata } from './toolMetadata';
import {
  getWorkspaceCoreToolDefinition,
  WORKSPACE_CORE_SERVER_SLUG,
} from 'server/services/workspaceCoreMcp/toolDefinitions';
import { ConflictError } from 'server/lib/appError';
import type { AgentRequestGitHubAuth } from './githubAuth';
import {
  buildAgentRequestGitHubAuthFromToken,
  GITHUB_USER_AUTH_REQUIRED_CODE,
  GITHUB_USER_AUTH_REQUIRED_MESSAGE,
  GITHUB_USER_AUTH_REQUIRED_PERMISSION,
  hasWriteAuthorizedUserGitHubAuth,
  markGitHubAuthWriteAuthorized,
  normalizeAgentRequestGitHubAuth,
} from './githubAuth';
import {
  fetchGitHubAuthenticatedUser,
  fetchGitHubRepositoryWritePermission,
} from 'server/lib/agentSession/githubToken';

type ToolLikePart = {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  state?: string;
  approval?: { id?: string | null } | null;
};
const FORCE_APPROVAL_TOOL_CAPABILITIES: Record<string, AgentCapabilityKey> = {
  [buildAgentToolKey(LIFECYCLE_BUILTIN_SERVER_SLUG, 'update_file')]: 'git_write',
  [buildAgentToolKey(LIFECYCLE_BUILTIN_SERVER_SLUG, 'update_pr_labels')]: 'git_write',
  [buildAgentToolKey(LIFECYCLE_BUILTIN_SERVER_SLUG, 'patch_k8s_resource')]: 'deploy_k8s_mutation',
  [buildAgentToolKey(LIFECYCLE_BUILTIN_SERVER_SLUG, 'trigger_redeploy')]: 'deploy_k8s_mutation',
};
const WORKSPACE_CORE_TOOL_KEY_PREFIX = buildAgentToolKey(WORKSPACE_CORE_SERVER_SLUG, '');
const ARGUMENT_PREVIEW_MAX_LENGTH = 160;
const PENDING_ACTION_RESPONSE_FIELDS = new Set(['approved', 'reason', 'alwaysAllow']);
// git_write approvals double as a per-action GitHub auth handoff, so they can never be auto-approved.
const ALWAYS_ALLOW_INELIGIBLE_CAPABILITIES = new Set<AgentCapabilityKey>(['git_write']);

type PendingActionResponseBody = {
  approved: boolean;
  reason: string | null;
  alwaysAllow: boolean;
};

type ApprovalRequestSyncResult = {
  pendingActions: AgentPendingAction[];
  resolvedActionCount: number;
};

type ApprovalRequestSyncOptions = {
  thread: AgentThread;
  run: AgentRun;
  messages: AgentUIMessage[];
  capabilityKey?: AgentCapabilityKey;
  approvalPolicy?: AgentApprovalPolicy;
  toolRules?: AgentSessionToolRule[];
  toolMetadata?: AgentRuntimeToolMetadata[];
  trx?: Transaction;
};

function isToolLikePart(part: unknown): part is ToolLikePart {
  if (!part || typeof part !== 'object') {
    return false;
  }

  const type = (part as ToolLikePart).type;
  return type === 'dynamic-tool' || (typeof type === 'string' && type.startsWith('tool-'));
}

function getToolPartName(part: ToolLikePart): string | null {
  if (part.toolName?.trim()) {
    return part.toolName;
  }

  return part.type?.startsWith('tool-') ? part.type.slice('tool-'.length) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readGitHubRepository(input: unknown): { owner: string; repo: string; fullName: string } | null {
  if (!isRecord(input)) {
    return null;
  }

  const owner = readString(input.repository_owner) || readString(input.owner);
  const repoName = readString(input.repository_name) || readString(input.name);
  const repoFullName = readString(input.repository) || readString(input.repo);

  if (owner && repoName) {
    return { owner, repo: repoName, fullName: `${owner}/${repoName}` };
  }

  if (repoFullName?.includes('/')) {
    const [repoOwner, repo] = repoFullName.split('/');
    if (repoOwner?.trim() && repo?.trim()) {
      return { owner: repoOwner.trim(), repo: repo.trim(), fullName: `${repoOwner.trim()}/${repo.trim()}` };
    }
  }

  return null;
}

function readGitHubRepositoryFromApprovalPayload(
  payload: unknown
): { owner: string; repo: string; fullName: string } | null {
  if (!isRecord(payload)) {
    return null;
  }

  return readGitHubRepository(payload.input) || readGitHubRepository(payload);
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readFileChangeKind(value: unknown): AgentFileChangeData['kind'] | null {
  return value === 'created' || value === 'edited' || value === 'deleted' ? value : null;
}

function readFileChangeStage(value: unknown): AgentFileChangeData['stage'] | null {
  return value === 'awaiting-approval' ||
    value === 'approved' ||
    value === 'applied' ||
    value === 'denied' ||
    value === 'failed'
    ? value
    : null;
}

function truncatePreview(value: string): string {
  return value.length > ARGUMENT_PREVIEW_MAX_LENGTH ? `${value.slice(0, ARGUMENT_PREVIEW_MAX_LENGTH - 3)}...` : value;
}

function formatArgumentValue(value: unknown): string {
  if (typeof value === 'string') {
    return truncatePreview(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value == null) {
    return 'null';
  }

  try {
    return truncatePreview(JSON.stringify(value));
  } catch {
    return '[unserializable]';
  }
}

function summarizeArguments(input: unknown): Array<{ name: string; value: string }> {
  if (!isRecord(input)) {
    return [];
  }

  return Object.entries(input)
    .filter(
      ([name]) =>
        !['content', 'new_content', 'oldText', 'newText', 'old_text', 'new_text', 'command', 'cmd'].includes(name)
    )
    .slice(0, 6)
    .map(([name, value]) => ({
      name,
      value: formatArgumentValue(value),
    }));
}

function getCommandPreview(input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }

  const command = readString(input.command) || readString(input.cmd);
  if (command) {
    return truncatePreview(command);
  }

  if (Array.isArray(input.command)) {
    const commandParts = input.command.filter(
      (part): part is string => typeof part === 'string' && part.trim().length > 0
    );
    return commandParts.length > 0 ? truncatePreview(commandParts.join(' ')) : null;
  }

  return null;
}

function summarizeFileChanges({
  value,
  fallbackToolCallId,
  fallbackSourceTool,
}: {
  value: unknown;
  fallbackToolCallId: string | null;
  fallbackSourceTool: string | null;
}): AgentFileChangeData[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .slice(0, 10)
    .flatMap((change) => {
      const path = readString(change.path);
      const kind = readFileChangeKind(change.kind);
      if (!path || !kind) {
        return [];
      }

      const displayPath = readString(change.displayPath) || path;
      const toolCallId = readString(change.toolCallId) || fallbackToolCallId || `${path}:file-change`;
      const sourceTool = readString(change.sourceTool) || fallbackSourceTool || 'tool';
      const stage = readFileChangeStage(change.stage) || 'awaiting-approval';

      return {
        id: readString(change.id) || `${toolCallId}:${path}`,
        toolCallId,
        sourceTool,
        path,
        displayPath,
        kind,
        stage,
        additions: readNumber(change.additions) ?? 0,
        deletions: readNumber(change.deletions) ?? 0,
        truncated: change.truncated === true,
        unifiedDiff: readString(change.unifiedDiff),
        beforeTextPreview: readString(change.beforeTextPreview),
        afterTextPreview: readString(change.afterTextPreview),
        summary: readString(change.summary) || `${kind} ${displayPath}`,
        encoding: readString(change.encoding),
        oldSizeBytes: readNumber(change.oldSizeBytes),
        newSizeBytes: readNumber(change.newSizeBytes),
        oldSha256: readString(change.oldSha256),
        newSha256: readString(change.newSha256),
        ...(isRecord(change.schemaValidation) && typeof change.schemaValidation.valid === 'boolean'
          ? {
              schemaValidation: {
                valid: change.schemaValidation.valid,
                error: readString(change.schemaValidation.error),
              },
            }
          : {}),
      };
    });
}

function getRiskLabels(capabilityKey: string | null | undefined): string[] {
  switch (capabilityKey) {
    case 'workspace_write':
      return ['Workspace write'];
    case 'shell_exec':
      return ['Shell command'];
    case 'git_write':
      return ['Git write'];
    case 'network_access':
      return ['Network access'];
    case 'deploy_k8s_mutation':
      return ['Deployment change'];
    case 'external_mcp_write':
      return ['MCP write'];
    case 'external_mcp_read':
      return ['MCP read'];
    case 'read':
      return ['Read-only'];
    default:
      return [];
  }
}

function resolveApprovalCapabilityKey(
  toolName: string,
  fallback: AgentCapabilityKey,
  toolMetadata?: AgentRuntimeToolMetadata[]
): AgentCapabilityKey {
  const forcedApprovalCapabilityKey = FORCE_APPROVAL_TOOL_CAPABILITIES[toolName];
  if (forcedApprovalCapabilityKey) {
    return forcedApprovalCapabilityKey;
  }

  if (toolName.startsWith(WORKSPACE_CORE_TOOL_KEY_PREFIX)) {
    return (
      getWorkspaceCoreToolDefinition(toolName.slice(WORKSPACE_CORE_TOOL_KEY_PREFIX.length))?.capabilityKey ?? fallback
    );
  }

  // The run's registered metadata is the source of truth; without it every stream approval used to
  // get stamped external_mcp_write, mislabeling read-only tools as writes.
  const registered = toolMetadata?.find((entry) => entry.toolKey === toolName);
  if (registered) {
    return registered.capabilityKey;
  }

  return fallback;
}

function shouldPersistApprovalRequest({
  toolName,
  fallbackCapabilityKey,
  approvalPolicy,
  toolRules,
  toolMetadata,
}: {
  toolName: string;
  fallbackCapabilityKey: AgentCapabilityKey;
  approvalPolicy?: AgentApprovalPolicy;
  toolRules?: AgentSessionToolRule[];
  toolMetadata?: AgentRuntimeToolMetadata[];
}): boolean {
  if (!approvalPolicy) {
    return true;
  }

  const capabilityKey = resolveApprovalCapabilityKey(toolName, fallbackCapabilityKey, toolMetadata);
  const toolRule = toolRules?.find((rule) => rule.toolKey === toolName);
  const capabilityMode = AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey);

  if (toolRule?.mode === 'deny' || (!toolRule && capabilityMode === 'deny')) {
    return false;
  }

  // Once the runtime emits an approval request, Lifecycle must preserve it so the run can pause
  // and resume. The policy decides whether a request should be produced upstream; this guard only
  // blocks explicitly denied tools from becoming approve-able.
  return true;
}

async function upsertApprovalRequestRecord({
  thread,
  run,
  approvalId,
  toolCallId,
  toolName,
  input,
  fileChanges,
  capabilityKey,
  toolMetadata,
  trx,
}: {
  thread: AgentThread;
  run: AgentRun;
  approvalId: string;
  toolCallId: string | null;
  toolName: string;
  input: unknown;
  fileChanges?: AgentFileChangeData[];
  capabilityKey: AgentCapabilityKey;
  toolMetadata?: AgentRuntimeToolMetadata[];
  trx?: Transaction;
}): Promise<AgentPendingAction | null> {
  const existing = await AgentPendingAction.query(trx)
    .where({ runId: run.id, threadId: thread.id })
    .whereRaw(`payload->>'approvalId' = ?`, [approvalId])
    .first();

  const payload = {
    approvalId,
    toolCallId,
    toolName,
    input: input ?? null,
    ...(fileChanges?.length ? { fileChanges } : {}),
  };
  const resolvedCapabilityKey = resolveApprovalCapabilityKey(toolName, capabilityKey, toolMetadata);

  if (existing) {
    if (existing.status !== 'pending') {
      return null;
    }

    return AgentPendingAction.query(trx).patchAndFetchById(existing.id, {
      capabilityKey: resolvedCapabilityKey,
      payload,
    } as Partial<AgentPendingAction>);
  }

  return AgentPendingAction.query(trx).insertAndFetch({
    threadId: thread.id,
    runId: run.id,
    kind: 'tool_approval',
    status: 'pending',
    capabilityKey: resolvedCapabilityKey,
    title: `Approve ${toolName}`,
    description: `${toolName} requires approval before it can run.`,
    payload,
    resolution: null,
    resolvedAt: null,
  } as Partial<AgentPendingAction>);
}

export default class ApprovalService {
  static normalizePendingActionResponseBody(body: unknown): PendingActionResponseBody | Error {
    if (!isRecord(body)) {
      return new Error('Request body must be a JSON object');
    }

    const unsupportedFields = Object.keys(body).filter((field) => !PENDING_ACTION_RESPONSE_FIELDS.has(field));
    if (unsupportedFields.length > 0) {
      return new Error(`Unsupported pending action response fields: ${unsupportedFields.join(', ')}`);
    }

    if (typeof body.approved !== 'boolean') {
      return new Error('approved must be a boolean');
    }

    if (body.reason != null && typeof body.reason !== 'string') {
      return new Error('reason must be a string when provided');
    }

    if (body.alwaysAllow != null && typeof body.alwaysAllow !== 'boolean') {
      return new Error('alwaysAllow must be a boolean when provided');
    }

    return {
      approved: body.approved,
      reason: typeof body.reason === 'string' ? body.reason : null,
      alwaysAllow: body.alwaysAllow === true,
    };
  }

  static isAlwaysAllowEligible(action: Pick<AgentPendingAction, 'kind' | 'capabilityKey' | 'payload'>): boolean {
    if (action.kind !== 'tool_approval') {
      return false;
    }

    const toolName = isRecord(action.payload) ? readString(action.payload.toolName) : null;
    if (!toolName) {
      return false;
    }

    return !action.capabilityKey || !ALWAYS_ALLOW_INELIGIBLE_CAPABILITIES.has(action.capabilityKey);
  }

  static async requireGitHubWriteAuthorization(
    auth: AgentRequestGitHubAuth,
    actionId: string,
    toolCallId: string | null,
    repository: { owner: string; repo: string; fullName: string } | null
  ): Promise<void> {
    if (!hasWriteAuthorizedUserGitHubAuth(auth)) {
      throw new ConflictError(GITHUB_USER_AUTH_REQUIRED_MESSAGE, GITHUB_USER_AUTH_REQUIRED_CODE, {
        actionId,
        toolCallId,
      });
    }

    const probe = await fetchGitHubAuthenticatedUser(auth.githubToken).catch(() => null);
    if (!probe?.ok) {
      throw new ConflictError(GITHUB_USER_AUTH_REQUIRED_MESSAGE, GITHUB_USER_AUTH_REQUIRED_CODE, {
        actionId,
        toolCallId,
        githubStatus: probe?.status ?? null,
        requiredPermission: GITHUB_USER_AUTH_REQUIRED_PERMISSION,
        scopes: probe?.scopes ?? [],
      });
    }

    if (!repository) {
      return;
    }

    const repositoryProbe = await fetchGitHubRepositoryWritePermission(
      auth.githubToken,
      repository.owner,
      repository.repo
    ).catch(() => null);
    if (repositoryProbe?.permission === 'denied') {
      throw new ConflictError(GITHUB_USER_AUTH_REQUIRED_MESSAGE, GITHUB_USER_AUTH_REQUIRED_CODE, {
        actionId,
        toolCallId,
        repository: repository.fullName,
        githubStatus: repositoryProbe.status,
        requiredPermission: GITHUB_USER_AUTH_REQUIRED_PERMISSION,
        permission: repositoryProbe.permission,
        permissions: repositoryProbe.permissions,
        scopes: repositoryProbe.scopes,
      });
    }
  }

  static async listPendingActions(threadUuid: string, userId: string): Promise<AgentPendingAction[]> {
    const thread = await AgentThreadService.getOwnedThread(threadUuid, userId);
    return AgentPendingAction.query()
      .alias('action')
      .leftJoinRelated('[thread, run]')
      .where('action.threadId', thread.id)
      .where('action.status', 'pending')
      .select('action.*', 'thread.uuid as threadUuid', 'run.uuid as runUuid')
      .orderBy('action.createdAt', 'asc');
  }

  static async upsertApprovalRequest({
    thread,
    run,
    message,
    toolPart,
    capabilityKey,
    toolMetadata,
    trx,
  }: {
    thread: AgentThread;
    run: AgentRun;
    message: AgentUIMessage;
    toolPart: ToolLikePart;
    capabilityKey: AgentCapabilityKey;
    toolMetadata?: AgentRuntimeToolMetadata[];
    trx?: Transaction;
  }): Promise<AgentPendingAction | null> {
    const approvalId = toolPart.approval?.id;
    if (!approvalId) {
      throw new Error('Missing approval id');
    }

    const toolCallId = toolPart.toolCallId || null;
    const fileChanges = toolCallId
      ? listMessageFileChanges(message).filter((change) => change.toolCallId === toolCallId)
      : [];

    return upsertApprovalRequestRecord({
      thread,
      run,
      approvalId,
      toolCallId,
      toolName: getToolPartName(toolPart) || 'tool',
      input: toolPart.input,
      fileChanges,
      capabilityKey,
      toolMetadata,
      trx,
    });
  }

  static async upsertApprovalRequestFromStream({
    thread,
    run,
    approvalId,
    toolCallId,
    toolName,
    input,
    fileChanges,
    capabilityKey = 'external_mcp_write',
    approvalPolicy,
    toolRules,
    toolMetadata,
    trx,
  }: {
    thread: AgentThread;
    run: AgentRun;
    approvalId: string;
    toolCallId: string;
    toolName?: string | null;
    input?: unknown;
    fileChanges?: AgentFileChangeData[];
    capabilityKey?: AgentCapabilityKey;
    approvalPolicy?: AgentApprovalPolicy;
    toolRules?: AgentSessionToolRule[];
    toolMetadata?: AgentRuntimeToolMetadata[];
    trx?: Transaction;
  }): Promise<AgentPendingAction | null> {
    const resolvedToolName = toolName?.trim() || 'tool';

    if (
      !shouldPersistApprovalRequest({
        toolName: resolvedToolName,
        fallbackCapabilityKey: capabilityKey,
        approvalPolicy,
        toolRules,
        toolMetadata,
      })
    ) {
      return null;
    }

    return upsertApprovalRequestRecord({
      thread,
      run,
      approvalId,
      toolCallId,
      toolName: resolvedToolName,
      input,
      fileChanges,
      capabilityKey,
      toolMetadata,
      trx,
    });
  }

  static async syncApprovalRequestStateFromMessages({
    thread,
    run,
    messages,
    capabilityKey = 'external_mcp_write',
    approvalPolicy,
    toolRules,
    toolMetadata,
    trx,
  }: ApprovalRequestSyncOptions): Promise<ApprovalRequestSyncResult> {
    const pendingActions: AgentPendingAction[] = [];
    let resolvedActionCount = 0;

    for (const message of messages) {
      if (message.role !== 'assistant') {
        continue;
      }

      for (const part of message.parts || []) {
        if (!isToolLikePart(part) || part.state !== 'approval-requested' || !part.approval?.id) {
          continue;
        }

        const toolName = getToolPartName(part) || 'tool';
        if (
          !shouldPersistApprovalRequest({
            toolName,
            fallbackCapabilityKey: capabilityKey,
            approvalPolicy,
            toolRules,
            toolMetadata,
          })
        ) {
          continue;
        }

        const action = await this.upsertApprovalRequest({
          thread,
          run,
          message,
          toolPart: part,
          capabilityKey,
          toolMetadata,
          trx,
        });
        if (action?.status === 'pending') {
          pendingActions.push(action);
        } else if (!action) {
          resolvedActionCount += 1;
        }
      }
    }

    return {
      pendingActions,
      resolvedActionCount,
    };
  }

  static async syncApprovalRequestsFromMessages(options: ApprovalRequestSyncOptions): Promise<AgentPendingAction[]> {
    const result = await this.syncApprovalRequestStateFromMessages(options);
    return result.pendingActions;
  }

  static async resolvePendingAction(
    actionUuid: string,
    userId: string,
    status: Extract<AgentPendingActionStatus, 'approved' | 'denied'>,
    resolution?: Record<string, unknown>,
    options: {
      githubToken?: string | null;
      githubAuth?: AgentRequestGitHubAuth | null;
      alwaysAllow?: boolean;
    } = {}
  ): Promise<AgentPendingAction> {
    const resolvedAt = new Date().toISOString();
    const resolvedActionPatch = {
      status,
      resolvedAt,
      resolution: resolution || {
        approved: status === 'approved',
      },
    } as Partial<AgentPendingAction>;
    const approved = status === 'approved';
    const eventNotifications: Array<{ runUuid: string; sequence: number }> = [];
    let runToEnqueue: string | null = null;
    let runToEnqueueAuth: AgentRequestGitHubAuth | null = null;
    const storedHandoffRefs: Array<{ runUuid: string; actionUuid: string; toolCallId?: string | null }> = [];
    const incomingGitHubAuth = {
      ...normalizeAgentRequestGitHubAuth(
        options.githubAuth || buildAgentRequestGitHubAuthFromToken(options.githubToken, 'user')
      ),
      writeAuthorized: false,
    };

    const requireGitWriteApprovalAuth = async (
      action: AgentPendingAction & { runUuid?: string },
      actionRun: AgentRun
    ): Promise<AgentRequestGitHubAuth> => {
      if (action.capabilityKey !== 'git_write') {
        return incomingGitHubAuth;
      }
      if (!approved) {
        return incomingGitHubAuth;
      }

      const gitWriteGitHubAuth = markGitHubAuthWriteAuthorized(incomingGitHubAuth);
      const toolCallId =
        typeof action.payload?.toolCallId === 'string' && action.payload.toolCallId.trim()
          ? action.payload.toolCallId
          : null;
      const repository = readGitHubRepositoryFromApprovalPayload(action.payload);
      const existingHandoff = await ApprovalGitHubAuthHandoffService.getByAction(actionRun.uuid, action.uuid).catch(
        () => null
      );
      if (existingHandoff) {
        await ApprovalService.requireGitHubWriteAuthorization(existingHandoff, action.uuid, toolCallId, repository);
        return existingHandoff;
      }

      if (!hasWriteAuthorizedUserGitHubAuth(gitWriteGitHubAuth)) {
        throw new ConflictError(GITHUB_USER_AUTH_REQUIRED_MESSAGE, GITHUB_USER_AUTH_REQUIRED_CODE, {
          actionId: action.uuid,
          toolCallId,
        });
      }
      await ApprovalService.requireGitHubWriteAuthorization(gitWriteGitHubAuth, action.uuid, toolCallId, repository);

      await ApprovalGitHubAuthHandoffService.store({
        runUuid: actionRun.uuid,
        actionUuid: action.uuid,
        toolCallId,
        approvedByUserId: userId,
        auth: gitWriteGitHubAuth,
      });
      storedHandoffRefs.push({ runUuid: actionRun.uuid, actionUuid: action.uuid, toolCallId });
      return gitWriteGitHubAuth;
    };

    const resumeRunIfApprovalBlocked = async (actionRun: AgentRun, runId: number, trx: Transaction) => {
      const remainingPendingAction = await AgentPendingAction.query(trx).where({ runId, status: 'pending' }).first();

      if (remainingPendingAction) {
        return;
      }

      // Denied repairs resume like every other denial: the model reads the denial (and the
      // user's feedback) and closes or adjusts. Completing the run here left the thread with a
      // dead-end card, no acknowledgment, and a feedback box whose text went nowhere.
      if (actionRun.status === 'queued') {
        runToEnqueue = actionRun.uuid;
        runToEnqueueAuth = runToEnqueueAuth || incomingGitHubAuth;
        return;
      }

      if (actionRun.status !== 'waiting_for_approval') {
        return;
      }

      const queuedRun = await AgentRun.query(trx).patchAndFetchById(actionRun.id, {
        status: 'queued',
        queuedAt: resolvedAt,
        executionOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
      } as Partial<AgentRun>);
      const queuedSequence = await AgentRunEventService.appendStatusEventForRunInTransaction(
        queuedRun,
        'run.queued',
        {
          status: 'queued',
          error: queuedRun.error || null,
          usageSummary: queuedRun.usageSummary || {},
        },
        trx
      );
      if (queuedSequence) {
        eventNotifications.push({ runUuid: queuedRun.uuid, sequence: queuedSequence });
      }
      runToEnqueue = queuedRun.uuid;
      runToEnqueueAuth = runToEnqueueAuth || incomingGitHubAuth;
    };

    const actionSeed = await AgentPendingAction.query()
      .alias('action')
      .joinRelated('[thread.session, run]')
      .where('action.uuid', actionUuid)
      .where('thread:session.userId', userId)
      .select('action.*', 'thread.uuid as threadUuid', 'run.uuid as runUuid')
      .first();

    if (!actionSeed) {
      throw new Error('Pending action not found');
    }

    // GitHub write probes are network round-trips; resolve them before taking the run row lock
    // so the transaction (and any concurrent approval on the same run) is not held on GitHub.
    let preResolvedGitWriteAuth: AgentRequestGitHubAuth | null = null;
    if (approved && actionSeed.status === 'pending' && actionSeed.capabilityKey === 'git_write') {
      preResolvedGitWriteAuth = await requireGitWriteApprovalAuth(actionSeed, {
        uuid: actionSeed.runUuid,
      } as AgentRun);
    }

    let updatedAction: AgentPendingAction;
    try {
      updatedAction = await AgentPendingAction.transaction(async (trx) => {
        const actionRun = await AgentRun.query(trx).findById(actionSeed.runId).forUpdate();
        if (!actionRun) {
          throw new Error('Agent run not found');
        }

        const action = await AgentPendingAction.query(trx)
          .alias('action')
          .joinRelated('[thread, run]')
          .where('action.id', actionSeed.id)
          .select('action.*', 'thread.uuid as threadUuid', 'run.uuid as runUuid')
          .forUpdate()
          .first();

        if (!action) {
          throw new Error('Pending action not found');
        }

        if (action.status !== 'pending') {
          if (
            approved &&
            action.status === 'approved' &&
            ['queued', 'waiting_for_approval', 'running'].includes(actionRun.status)
          ) {
            runToEnqueueAuth = preResolvedGitWriteAuth ?? (await requireGitWriteApprovalAuth(action, actionRun));
          }
          await resumeRunIfApprovalBlocked(actionRun, action.runId, trx);
          return action;
        }

        if (approved) {
          runToEnqueueAuth = preResolvedGitWriteAuth ?? (await requireGitWriteApprovalAuth(action, actionRun));
        }

        await AgentPendingAction.query(trx).patchAndFetchById(action.id, resolvedActionPatch);

        const approvalId =
          typeof action.payload?.approvalId === 'string' && action.payload.approvalId.trim()
            ? action.payload.approvalId
            : null;
        const toolCallId =
          typeof action.payload?.toolCallId === 'string' && action.payload.toolCallId.trim()
            ? action.payload.toolCallId
            : null;

        if (approvalId) {
          const approvalEventPayload = {
            actionId: action.uuid,
            approvalId,
            toolCallId,
            approved,
            reason:
              resolution && typeof resolution.reason === 'string' && resolution.reason.trim()
                ? String(resolution.reason)
                : null,
          };
          const resolvedSequence = await AgentRunEventService.appendStatusEventForRunInTransaction(
            actionRun,
            'approval.resolved',
            approvalEventPayload,
            trx
          );
          if (resolvedSequence) {
            eventNotifications.push({ runUuid: actionRun.uuid, sequence: resolvedSequence });
          }
          const respondedSequence = await AgentRunEventService.appendStatusEventForRunInTransaction(
            actionRun,
            'approval.responded',
            approvalEventPayload,
            trx
          );
          if (respondedSequence) {
            eventNotifications.push({ runUuid: actionRun.uuid, sequence: respondedSequence });
          }
        }

        if (approved && options.alwaysAllow && ApprovalService.isAlwaysAllowEligible(action)) {
          const allowlistToolName = isRecord(action.payload) ? readString(action.payload.toolName) : null;
          if (allowlistToolName) {
            await AgentThreadService.addToolApprovalAllowlistEntry(action.threadId, allowlistToolName, trx);
            const allowlistSequence = await AgentRunEventService.appendStatusEventForRunInTransaction(
              actionRun,
              'approval.always_allowed',
              { actionId: action.uuid, toolCallId, toolName: allowlistToolName },
              trx
            );
            if (allowlistSequence) {
              eventNotifications.push({ runUuid: actionRun.uuid, sequence: allowlistSequence });
            }
          }
        }

        await resumeRunIfApprovalBlocked(actionRun, action.runId, trx);

        const currentAction = await AgentPendingAction.query(trx)
          .alias('action')
          .joinRelated('[thread, run]')
          .where('action.id', action.id)
          .select('action.*', 'thread.uuid as threadUuid', 'run.uuid as runUuid')
          .first();

        if (!currentAction) {
          throw new Error('Pending action not found');
        }

        return currentAction;
      });
    } catch (error) {
      await Promise.all(
        storedHandoffRefs.map((ref) =>
          ApprovalGitHubAuthHandoffService.clearAction(ref.runUuid, ref.actionUuid, ref.toolCallId)
        )
      );
      throw error;
    }

    // Pre-resolved handoffs are only valid for an approval that actually landed; a concurrent
    // deny between the probe and the lock would otherwise leave a stale token handoff behind.
    if (updatedAction.status !== 'approved' && storedHandoffRefs.length > 0) {
      await Promise.all(
        storedHandoffRefs.map((ref) =>
          ApprovalGitHubAuthHandoffService.clearAction(ref.runUuid, ref.actionUuid, ref.toolCallId)
        )
      );
    }

    for (const notification of eventNotifications) {
      await AgentRunEventService.notifyRunEventsInserted(notification.runUuid, notification.sequence);
    }

    if (runToEnqueue) {
      await AgentRunQueueService.enqueueRun(runToEnqueue, 'approval_resolved', {
        githubAuth: runToEnqueueAuth || incomingGitHubAuth,
      });
    }

    return updatedAction;
  }

  static serializePendingAction(action: AgentPendingAction) {
    const enrichedAction = action as AgentPendingAction & {
      threadUuid?: string;
      runUuid?: string;
      expiresAt?: string | null;
    };
    const payload = isRecord(action.payload) ? action.payload : {};
    const toolName = readString(payload.toolName);
    const input = payload.input;

    return {
      id: action.uuid,
      kind: action.kind,
      status: action.status,
      threadId: enrichedAction.threadUuid || String(action.threadId),
      runId: enrichedAction.runUuid || String(action.runId),
      title: action.title,
      description: action.description,
      requestedAt: action.createdAt || null,
      expiresAt: enrichedAction.expiresAt || null,
      toolName,
      argumentsSummary: summarizeArguments(input),
      commandPreview: getCommandPreview(input),
      fileChangePreview: summarizeFileChanges({
        value: payload.fileChanges,
        fallbackToolCallId: readString(payload.toolCallId),
        fallbackSourceTool: toolName,
      }),
      riskLabels: getRiskLabels(action.capabilityKey),
      alwaysAllowEligible: ApprovalService.isAlwaysAllowEligible(action),
    };
  }
}
