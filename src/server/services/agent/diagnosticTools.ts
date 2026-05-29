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

import { createHash } from 'crypto';
import { dynamicTool, jsonSchema, type ToolSet } from 'ai';
import type AgentSession from 'server/models/AgentSession';
import * as models from 'server/models';
import { GetCodefreshLogsTool } from 'server/services/agent/tools/codefresh/getCodefreshLogs';
import { GetFileTool } from 'server/services/agent/tools/github/getFile';
import { GetIssueCommentTool } from 'server/services/agent/tools/github/getIssueComment';
import { ListDirectoryTool } from 'server/services/agent/tools/github/listDirectory';
import { UpdateFileTool } from 'server/services/agent/tools/github/updateFile';
import { UpdatePrLabelsTool } from 'server/services/agent/tools/github/updatePrLabels';
import { GetK8sResourcesTool } from 'server/services/agent/tools/k8s/getK8sResources';
import { GetLifecycleLogsTool } from 'server/services/agent/tools/k8s/getLifecycleLogs';
import { PatchK8sResourceTool } from 'server/services/agent/tools/k8s/patchK8sResource';
import { GetPodLogsTool } from 'server/services/agent/tools/k8s/getPodLogs';
import { QueryDatabaseTool } from 'server/services/agent/tools/k8s/queryDatabase';
import { DatabaseClient, type DatabaseBuildScope } from 'server/services/agent/tools/shared/databaseClient';
import { GitHubClient } from 'server/services/agent/tools/shared/githubClient';
import { K8sClient } from 'server/services/agent/tools/shared/k8sClient';
import type { Tool } from 'server/services/agent/tools/types';
import type {
  AgentApprovalMode,
  AgentApprovalPolicy,
  AgentCapabilityKey,
  AgentFileChangeData,
  AgentToolAuditRecord,
} from './types';
import type { AgentRuntimeToolMetadata } from './CapabilityService';
import AgentPolicyService from './PolicyService';
import type { ResolvedAgentCapabilityAccess } from './PolicyService';
import type { AgentCapabilityCatalogId } from './capabilityCatalog';
import type { AgentSessionToolRule } from 'server/services/types/agentSessionConfig';
import { buildAgentToolKey, LIFECYCLE_BUILTIN_SERVER_SLUG } from './toolKeys';
import { getLogger } from 'server/lib/logger';
import { DEFAULT_AGENT_SESSION_FILE_CHANGE_PREVIEW_CHARS } from 'server/lib/agentSession/runtimeConfig';

type ToolExecutionHooks = {
  onToolStarted?: (audit: AgentToolAuditRecord) => Promise<void>;
  onToolFinished?: (audit: AgentToolAuditRecord & { result: unknown; status: 'completed' | 'failed' }) => Promise<void>;
  onFileChange?: (change: AgentFileChangeData) => Promise<void>;
};

const LIFECYCLE_DIAGNOSTIC_READ_CAPABILITY: AgentCapabilityKey = 'read';
const FILE_CHANGE_PREVIEW_CHARS = DEFAULT_AGENT_SESSION_FILE_CHANGE_PREVIEW_CHARS;
const MAX_EXACT_DIFF_MATRIX_CELLS = 1_000_000;

function toAiJsonSchema(schema: unknown) {
  return jsonSchema(schema as any);
}

function toAiDynamicTool(config: unknown) {
  return dynamicTool(config as any);
}

type LifecycleDiagnosticToolSpec = {
  tool: Tool;
  capabilityKey: AgentCapabilityKey;
  catalogCapabilityId: AgentCapabilityCatalogId;
  forceApproval: boolean;
  shouldRequestApproval?: (input: Record<string, unknown>) => boolean | Promise<boolean>;
  buildProposedFileChanges?: (
    input: Record<string, unknown>,
    toolCallId: string,
    sourceTool: string
  ) => AgentFileChangeData[] | Promise<AgentFileChangeData[]>;
};

export type LifecycleDiagnosticGithubSafety = {
  allowedBranch?: string | null;
  referencedFiles?: string[];
  excludedFilePatterns?: string[];
  allowedWritePatterns?: string[];
  // SECURITY: the build's resolved scope. Every diagnostic tool is locked to these.
  allowedNamespace?: string | null;
  allowedRepos?: string[];
  buildUuid?: string | null;
  pullRequestId?: number | null;
  databaseScope?: DatabaseBuildScope | null;
};

function resolveToolMode({
  toolRules,
  toolKey,
  approvalPolicy,
  capabilityKey,
  forceApproval,
}: {
  toolRules?: AgentSessionToolRule[];
  toolKey: string;
  approvalPolicy: AgentApprovalPolicy;
  capabilityKey: AgentCapabilityKey;
  forceApproval: boolean;
}): AgentApprovalMode {
  const toolRule = toolRules?.find((rule) => rule.toolKey === toolKey);
  const capabilityMode = AgentPolicyService.modeForCapability(approvalPolicy, capabilityKey);

  if (toolRule?.mode === 'deny' || (!toolRule && capabilityMode === 'deny')) {
    return 'deny';
  }

  if (forceApproval) {
    return 'require_approval';
  }

  return toolRule?.mode || capabilityMode;
}

function configureGithubClient(client: GitHubClient, safety?: LifecycleDiagnosticGithubSafety): GitHubClient {
  const allowedBranch = safety?.allowedBranch?.trim();
  if (allowedBranch) {
    client.setAllowedBranch(allowedBranch);
  }

  client.setReferencedFiles(safety?.referencedFiles || []);
  client.setExcludedFilePatterns(safety?.excludedFilePatterns || []);
  client.setAllowedWritePatterns(safety?.allowedWritePatterns || []);
  // SECURITY: lock GitHub reads/writes to the build's repositories.
  client.setAllowedRepos(safety?.allowedRepos || null);

  return client;
}

function configureK8sClient(client: K8sClient, safety?: LifecycleDiagnosticGithubSafety): K8sClient {
  // SECURITY: lock k8s reads/patches to the build's namespace.
  client.setAllowedNamespace(safety?.allowedNamespace || null);
  return client;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeUpdateFileContent(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
}

export async function shouldRequestUpdateFileApproval(
  client: GitHubClient,
  input: Record<string, unknown>
): Promise<boolean> {
  const filePath = readString(input.file_path);
  const branch = readString(input.branch);
  const newContent = typeof input.new_content === 'string' ? input.new_content : null;
  if (!filePath || !branch) {
    return false;
  }

  if (!client.isFilePathAllowed(filePath, 'write') || !client.validateBranch(branch).valid) {
    return false;
  }

  if (newContent === null) {
    return false;
  }

  const currentContent = await readGithubFileContent(client, input, normalizeFilePath(filePath));
  return currentContent === null || currentContent !== normalizeUpdateFileContent(newContent);
}

function createLifecycleDiagnosticReadToolSpecs(
  safety?: LifecycleDiagnosticGithubSafety
): LifecycleDiagnosticToolSpec[] {
  const k8sClient = configureK8sClient(new K8sClient(), safety);
  const githubClient = configureGithubClient(new GitHubClient(), safety);
  const databaseClient = new DatabaseClient({ models });
  // SECURITY: constrain DB reads to the build's own records.
  databaseClient.setBuildScope(safety?.databaseScope || null);

  const lifecycleLogsTool = new GetLifecycleLogsTool(k8sClient);
  lifecycleLogsTool.setAllowedBuildUuid(safety?.buildUuid || null);

  const specs: Array<{ tool: Tool; catalogCapabilityId: AgentCapabilityCatalogId }> = [
    { tool: new GetCodefreshLogsTool(), catalogCapabilityId: 'diagnostics_codefresh' },
    { tool: new GetK8sResourcesTool(k8sClient), catalogCapabilityId: 'diagnostics_kubernetes' },
    { tool: new GetPodLogsTool(k8sClient), catalogCapabilityId: 'diagnostics_logs' },
    { tool: lifecycleLogsTool, catalogCapabilityId: 'diagnostics_logs' },
    { tool: new QueryDatabaseTool(databaseClient), catalogCapabilityId: 'diagnostics_database' },
    { tool: new GetFileTool(githubClient), catalogCapabilityId: 'github_read' },
    { tool: new ListDirectoryTool(githubClient), catalogCapabilityId: 'github_read' },
    { tool: new GetIssueCommentTool(githubClient), catalogCapabilityId: 'github_read' },
  ];

  return specs.map(({ tool, catalogCapabilityId }) => ({
    tool,
    catalogCapabilityId,
    capabilityKey: LIFECYCLE_DIAGNOSTIC_READ_CAPABILITY,
    forceApproval: false,
  }));
}

function trimPreview(value: string): string {
  return value.length > FILE_CHANGE_PREVIEW_CHARS
    ? `${value.slice(0, FILE_CHANGE_PREVIEW_CHARS)}\n\n[truncated]`
    : value;
}

function countLines(value: string): number {
  return value ? value.split('\n').length : 0;
}

function splitLines(value: string): string[] {
  return value.length === 0 ? [] : value.split('\n');
}

function normalizeFilePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/^\.\//, '');
}

function buildSingleHunkUnifiedDiff(path: string, oldContent: string, newContent: string) {
  if (oldContent === newContent) {
    return {
      unifiedDiff: null,
      additions: 0,
      deletions: 0,
    };
  }

  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);

  if (oldLines.length * newLines.length > MAX_EXACT_DIFF_MATRIX_CELLS) {
    return {
      unifiedDiff: [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`),
      ].join('\n'),
      additions: newLines.length,
      deletions: oldLines.length,
    };
  }

  const dp = Array.from({ length: oldLines.length + 1 }, () => Array(newLines.length + 1).fill(0));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      dp[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? dp[oldIndex + 1][newIndex + 1] + 1
          : Math.max(dp[oldIndex + 1][newIndex], dp[oldIndex][newIndex + 1]);
    }
  }

  let oldIndex = 0;
  let newIndex = 0;
  let additions = 0;
  let deletions = 0;
  const diffLines: string[] = [];

  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      diffLines.push(` ${oldLines[oldIndex]}`);
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (
      newIndex < newLines.length &&
      (oldIndex >= oldLines.length || dp[oldIndex][newIndex + 1] >= dp[oldIndex + 1][newIndex])
    ) {
      diffLines.push(`+${newLines[newIndex]}`);
      additions += 1;
      newIndex += 1;
      continue;
    }

    if (oldIndex < oldLines.length) {
      diffLines.push(`-${oldLines[oldIndex]}`);
      deletions += 1;
      oldIndex += 1;
    }
  }

  return {
    unifiedDiff: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...diffLines,
    ].join('\n'),
    additions,
    deletions,
  };
}

async function readGithubFileContent(
  githubClient: GitHubClient,
  input: Record<string, unknown>,
  path: string
): Promise<string | null> {
  const owner = readString(input.repository_owner);
  const repo = readString(input.repository_name);
  const branch = readString(input.branch);
  if (!owner || !repo || !branch) {
    return null;
  }

  try {
    const octokit = await githubClient.getOctokit('agent-runtime-update-file-preview');
    const currentFile = await octokit.request(`GET /repos/${owner}/${repo}/contents/${path}`, {
      ref: branch,
    });
    const data = currentFile.data;
    if (!data || Array.isArray(data) || !('content' in data) || typeof data.content !== 'string') {
      return null;
    }

    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

export async function buildUpdateFilePreview(
  githubClient: GitHubClient,
  input: Record<string, unknown>,
  toolCallId: string,
  sourceTool: string
): Promise<AgentFileChangeData[]> {
  if (typeof input.file_path !== 'string' || typeof input.new_content !== 'string') {
    return [];
  }

  const path = normalizeFilePath(input.file_path);
  const content = normalizeUpdateFileContent(input.new_content);
  const oldContent = await readGithubFileContent(githubClient, input, path);
  if (oldContent !== null && oldContent === content) {
    return [];
  }

  const diff = oldContent === null ? null : buildSingleHunkUnifiedDiff(path, oldContent, content);
  const beforeTextPreview = oldContent === null ? null : trimPreview(oldContent);
  const afterTextPreview = trimPreview(content);

  return [
    {
      id: `${toolCallId}:${path}`,
      toolCallId,
      sourceTool,
      path,
      displayPath: path,
      kind: oldContent === null ? 'created' : 'edited',
      stage: 'awaiting-approval',
      additions: diff?.additions ?? countLines(content),
      deletions: diff?.deletions ?? 0,
      truncated:
        content.length > FILE_CHANGE_PREVIEW_CHARS ||
        (oldContent !== null && oldContent.length > FILE_CHANGE_PREVIEW_CHARS),
      unifiedDiff: diff?.unifiedDiff ?? null,
      beforeTextPreview,
      afterTextPreview,
      summary: `Proposed update to ${path}`,
      encoding: 'utf-8',
      oldSizeBytes: oldContent === null ? null : Buffer.byteLength(oldContent, 'utf8'),
      newSizeBytes: Buffer.byteLength(content, 'utf8'),
      oldSha256: oldContent === null ? null : createHash('sha256').update(oldContent).digest('hex'),
      newSha256: createHash('sha256').update(content).digest('hex'),
    },
  ];
}

function createLifecycleDiagnosticFixToolSpecs(
  safety?: LifecycleDiagnosticGithubSafety
): LifecycleDiagnosticToolSpec[] {
  const k8sClient = configureK8sClient(new K8sClient(), safety);
  const githubClient = configureGithubClient(new GitHubClient(), safety);

  return [
    {
      tool: new UpdateFileTool(githubClient),
      capabilityKey: 'git_write',
      catalogCapabilityId: 'github_write',
      forceApproval: true,
      shouldRequestApproval: (input) => shouldRequestUpdateFileApproval(githubClient, input),
      buildProposedFileChanges: (input, toolCallId, sourceTool) =>
        buildUpdateFilePreview(githubClient, input, toolCallId, sourceTool),
    },
    {
      tool: new UpdatePrLabelsTool(githubClient),
      capabilityKey: 'git_write',
      catalogCapabilityId: 'github_write',
      forceApproval: true,
    },
    {
      tool: new PatchK8sResourceTool(k8sClient),
      capabilityKey: 'deploy_k8s_mutation',
      catalogCapabilityId: 'diagnostics_kubernetes',
      forceApproval: true,
    },
  ];
}

function isCatalogCapabilityAllowed(
  resolvedCapabilityAccess: ResolvedAgentCapabilityAccess[] | undefined,
  capabilityId: AgentCapabilityCatalogId
): boolean {
  if (!resolvedCapabilityAccess) {
    return false;
  }

  return resolvedCapabilityAccess.some((entry) => entry.capabilityId === capabilityId && entry.allowed);
}

function registerLifecycleDiagnosticToolSpecs({
  tools,
  session,
  approvalPolicy,
  hooks,
  toolRules,
  specs,
  resolvedCapabilityAccess,
  toolMetadata,
}: {
  tools: ToolSet;
  session: AgentSession;
  approvalPolicy: AgentApprovalPolicy;
  hooks?: ToolExecutionHooks;
  toolRules?: AgentSessionToolRule[];
  specs: LifecycleDiagnosticToolSpec[];
  resolvedCapabilityAccess?: ResolvedAgentCapabilityAccess[];
  githubSafety?: LifecycleDiagnosticGithubSafety;
  toolMetadata?: AgentRuntimeToolMetadata[];
}) {
  if (!session.buildUuid) {
    return;
  }

  for (const {
    tool: diagnosticTool,
    capabilityKey,
    catalogCapabilityId,
    forceApproval,
    shouldRequestApproval,
    buildProposedFileChanges,
  } of specs) {
    if (!isCatalogCapabilityAllowed(resolvedCapabilityAccess, catalogCapabilityId)) {
      continue;
    }

    const toolKey = buildAgentToolKey(LIFECYCLE_BUILTIN_SERVER_SLUG, diagnosticTool.name);
    const mode = resolveToolMode({
      toolRules,
      toolKey,
      approvalPolicy,
      capabilityKey,
      forceApproval,
    });

    if (mode === 'deny') {
      continue;
    }

    tools[toolKey] = toAiDynamicTool({
      description: diagnosticTool.description,
      inputSchema: toAiJsonSchema(diagnosticTool.parameters as Record<string, unknown>),
      needsApproval:
        mode === 'require_approval'
          ? shouldRequestApproval
            ? async (input: unknown) =>
                shouldRequestApproval(((input as Record<string, unknown>) || {}) as Record<string, unknown>)
            : true
          : false,
      onInputAvailable: buildProposedFileChanges
        ? async ({ input, toolCallId }) => {
            if (!toolCallId) {
              return;
            }

            const args = (input as Record<string, unknown>) || {};
            for (const change of await buildProposedFileChanges(args, toolCallId, diagnosticTool.name)) {
              await hooks?.onFileChange?.(change);
            }
          }
        : undefined,
      execute: async (input, context) => {
        const args = (input as Record<string, unknown>) || {};
        const toolCallId = context?.toolCallId;
        const audit: AgentToolAuditRecord = {
          source: 'mcp',
          serverSlug: LIFECYCLE_BUILTIN_SERVER_SLUG,
          toolName: diagnosticTool.name,
          toolCallId,
          args,
          capabilityKey,
        };

        await hooks?.onToolStarted?.(audit);

        try {
          const abortSignal = (context as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          const result = await diagnosticTool.execute(args, abortSignal);
          await hooks?.onToolFinished?.({
            ...audit,
            result,
            status: result.success ? 'completed' : 'failed',
          });
          return result;
        } catch (error) {
          const result = {
            error: error instanceof Error ? error.message : String(error),
          };
          getLogger().warn(
            { error },
            `AgentExec: lifecycle diagnostic tool failed sessionId=${session.uuid} tool=${diagnosticTool.name}`
          );
          await hooks?.onToolFinished?.({
            ...audit,
            result,
            status: 'failed',
          });
          throw error;
        }
      },
    });
    toolMetadata?.push({
      toolKey,
      catalogCapabilityId,
      capabilityKey,
      approvalMode: mode,
      exposure: capabilityKey === 'read' || capabilityKey === 'external_mcp_read' ? 'read' : 'repair',
    });
  }
}

export function registerLifecycleDiagnosticReadTools(
  options: Omit<Parameters<typeof registerLifecycleDiagnosticToolSpecs>[0], 'specs'>
) {
  registerLifecycleDiagnosticToolSpecs({
    ...options,
    specs: createLifecycleDiagnosticReadToolSpecs(options.githubSafety),
  });
}

export function registerLifecycleDiagnosticFixTools(
  options: Omit<Parameters<typeof registerLifecycleDiagnosticToolSpecs>[0], 'specs'>
) {
  registerLifecycleDiagnosticToolSpecs({
    ...options,
    specs: createLifecycleDiagnosticFixToolSpecs(options.githubSafety),
  });
}
