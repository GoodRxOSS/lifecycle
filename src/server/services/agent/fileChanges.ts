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

import { createHash } from 'node:crypto';
import { type DynamicToolUIPart, type ToolUIPart, type UITools } from 'ai';
import type { AgentFileChangeArtifact, AgentFileChangeData, AgentFileChangeStage, AgentUIMessage } from './types';
import { DEFAULT_AGENT_SESSION_FILE_CHANGE_PREVIEW_CHARS } from 'server/lib/agentSession/runtimeConfig';

const MAX_FILE_CHANGE_PREVIEW_CHARS = DEFAULT_AGENT_SESSION_FILE_CHANGE_PREVIEW_CHARS;

type ToolLikePart = ToolUIPart<UITools> | DynamicToolUIPart;

interface FileEditApprovalInput {
  path: string;
  oldText: string;
  newText: string;
}

interface FileWriteApprovalInput {
  path: string;
  content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToolKey(value: string): string {
  const lastSegment = value.split('__').pop() || value;
  return lastSegment.trim().toLowerCase().replace(/[.-]/g, '_');
}

function asFileEditApprovalInput(value: unknown): FileEditApprovalInput | null {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.oldText !== 'string' ||
    typeof value.newText !== 'string'
  ) {
    return null;
  }

  return {
    path: value.path,
    oldText: value.oldText,
    newText: value.newText,
  };
}

function asFileWriteApprovalInput(value: unknown): FileWriteApprovalInput | null {
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.content !== 'string') {
    return null;
  }

  return {
    path: value.path,
    content: value.content,
  };
}

function trimWorkspacePrefix(path: string): string {
  return path.replace(/^\/workspace\//, '').replace(/^\.\//, '');
}

function trimPreview(value: string | null | undefined, maxChars = MAX_FILE_CHANGE_PREVIEW_CHARS): string | null {
  if (!value) {
    return null;
  }

  return value.length > maxChars ? `${value.slice(0, maxChars)}\n\n[truncated]` : value;
}

function countChangedLines(value: string): number {
  if (!value) {
    return 0;
  }

  return value.split('\n').length;
}

function unwrapToolPayload(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return value;
  }

  const textPart = value.content.find(
    (item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string'
  ) as { text?: string } | undefined;

  if (!textPart?.text?.trim()) {
    return null;
  }

  try {
    return JSON.parse(textPart.text);
  } catch {
    return textPart.text;
  }
}

function summarizeChange(kind: AgentFileChangeArtifact['kind'], path: string): string {
  const displayPath = trimWorkspacePrefix(path);
  switch (kind) {
    case 'created':
      return `Created ${displayPath}`;
    case 'deleted':
      return `Deleted ${displayPath}`;
    default:
      return `Updated ${displayPath}`;
  }
}

function buildFileChangeId(toolCallId: string, path: string): string {
  return `${toolCallId}:${trimWorkspacePrefix(path)}`;
}

function mapArtifactToData({
  artifact,
  toolCallId,
  sourceTool,
  stage,
  previewChars,
}: {
  artifact: AgentFileChangeArtifact;
  toolCallId: string;
  sourceTool: string;
  stage: AgentFileChangeStage;
  previewChars?: number;
}): AgentFileChangeData {
  return {
    ...artifact,
    id: buildFileChangeId(toolCallId, artifact.path),
    toolCallId,
    sourceTool,
    displayPath: trimWorkspacePrefix(artifact.path),
    stage,
    unifiedDiff: artifact.unifiedDiff ?? null,
    beforeTextPreview: trimPreview(artifact.beforeTextPreview, previewChars),
    afterTextPreview: trimPreview(artifact.afterTextPreview, previewChars),
    summary: artifact.summary ?? summarizeChange(artifact.kind, artifact.path),
  };
}

function countPatchStats(
  unifiedDiff: string | null | undefined
): Pick<AgentFileChangeArtifact, 'additions' | 'deletions'> {
  if (!unifiedDiff) {
    return { additions: 0, deletions: 0 };
  }

  let additions = 0;
  let deletions = 0;
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue;
    }

    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

function asFileChangeArtifact(value: unknown): AgentFileChangeArtifact | null {
  if (!isRecord(value) || typeof value.path !== 'string') {
    return null;
  }

  const kind = value.kind === 'created' || value.kind === 'deleted' || value.kind === 'edited' ? value.kind : 'edited';
  const unifiedDiff = typeof value.unifiedDiff === 'string' ? value.unifiedDiff : null;
  const stats = countPatchStats(unifiedDiff);

  return {
    path: value.path,
    kind,
    additions:
      typeof value.additions === 'number' && Number.isFinite(value.additions) ? value.additions : stats.additions,
    deletions:
      typeof value.deletions === 'number' && Number.isFinite(value.deletions) ? value.deletions : stats.deletions,
    truncated: value.truncated === true,
    unifiedDiff,
    beforeTextPreview: typeof value.beforeTextPreview === 'string' ? value.beforeTextPreview : null,
    afterTextPreview: typeof value.afterTextPreview === 'string' ? value.afterTextPreview : null,
    summary: typeof value.summary === 'string' ? value.summary : null,
    encoding: typeof value.encoding === 'string' ? value.encoding : null,
    oldSizeBytes:
      typeof value.oldSizeBytes === 'number' && Number.isFinite(value.oldSizeBytes) ? value.oldSizeBytes : null,
    newSizeBytes:
      typeof value.newSizeBytes === 'number' && Number.isFinite(value.newSizeBytes) ? value.newSizeBytes : null,
    oldSha256: typeof value.oldSha256 === 'string' ? value.oldSha256 : null,
    newSha256: typeof value.newSha256 === 'string' ? value.newSha256 : null,
  };
}

function isLogicalToolFailure(value: unknown): boolean {
  const payload = unwrapToolPayload(value);
  if (!isRecord(payload)) {
    return false;
  }

  return (
    payload.ok === false ||
    payload.success === false ||
    payload.isError === true ||
    payload.error === true ||
    (typeof payload.error === 'string' && payload.error.trim().length > 0) ||
    (typeof payload.status === 'string' && /^(error|failed|denied)$/i.test(payload.status))
  );
}

export function didToolResultFail(value: unknown): boolean {
  return isLogicalToolFailure(value);
}

export function buildProposedFileChanges({
  toolCallId,
  sourceTool,
  input,
  previewChars,
}: {
  toolCallId: string;
  sourceTool: string;
  input: Record<string, unknown>;
  previewChars?: number;
}): AgentFileChangeData[] {
  const toolKey = normalizeToolKey(sourceTool);

  if (toolKey === 'workspace_edit_file') {
    const args = asFileEditApprovalInput(input);
    if (!args) {
      return [];
    }

    const artifact: AgentFileChangeArtifact = {
      path: args.path,
      kind: 'edited',
      additions: countChangedLines(args.newText),
      deletions: countChangedLines(args.oldText),
      truncated: false,
      unifiedDiff: null,
      beforeTextPreview: args.oldText,
      afterTextPreview: args.newText,
      summary: `Proposed update to ${trimWorkspacePrefix(args.path)}`,
      encoding: 'utf-8',
      oldSizeBytes: Buffer.byteLength(args.oldText, 'utf8'),
      newSizeBytes: Buffer.byteLength(args.newText, 'utf8'),
      oldSha256: createHash('sha256').update(args.oldText).digest('hex'),
      newSha256: createHash('sha256').update(args.newText).digest('hex'),
    };

    return [
      mapArtifactToData({
        artifact,
        toolCallId,
        sourceTool,
        stage: 'awaiting-approval',
        previewChars,
      }),
    ];
  }

  if (toolKey === 'workspace_write_file') {
    const args = asFileWriteApprovalInput(input);
    if (!args) {
      return [];
    }

    const artifact: AgentFileChangeArtifact = {
      path: args.path,
      kind: 'edited',
      additions: countChangedLines(args.content),
      deletions: 0,
      truncated: false,
      unifiedDiff: null,
      beforeTextPreview: null,
      afterTextPreview: args.content,
      summary: `Proposed write to ${trimWorkspacePrefix(args.path)}`,
      encoding: 'utf-8',
      oldSizeBytes: null,
      newSizeBytes: Buffer.byteLength(args.content, 'utf8'),
      oldSha256: null,
      newSha256: createHash('sha256').update(args.content).digest('hex'),
    };

    return [
      mapArtifactToData({
        artifact,
        toolCallId,
        sourceTool,
        stage: 'awaiting-approval',
        previewChars,
      }),
    ];
  }

  return [];
}

export function buildResultFileChanges({
  toolCallId,
  sourceTool,
  input,
  result,
  failed,
  previewChars,
}: {
  toolCallId: string;
  sourceTool: string;
  input: Record<string, unknown>;
  result: unknown;
  failed: boolean;
  previewChars?: number;
}): AgentFileChangeData[] {
  const payload = unwrapToolPayload(result);
  const artifacts =
    isRecord(payload) && Array.isArray(payload.fileChanges)
      ? payload.fileChanges
          .map((candidate) => asFileChangeArtifact(candidate))
          .filter((candidate): candidate is AgentFileChangeArtifact => !!candidate)
      : [];

  if (artifacts.length > 0) {
    return artifacts.map((artifact) =>
      mapArtifactToData({
        artifact,
        toolCallId,
        sourceTool,
        stage: failed ? 'failed' : 'applied',
        previewChars,
      })
    );
  }

  if (!failed) {
    return [];
  }

  return buildProposedFileChanges({
    toolCallId,
    sourceTool,
    input,
    previewChars,
  }).map((change) => ({
    ...change,
    stage: 'failed',
  }));
}

function isToolLikePart(part: unknown): part is ToolLikePart {
  return (
    isRecord(part) &&
    typeof part.type === 'string' &&
    typeof part.state === 'string' &&
    ('toolCallId' in part || 'approval' in part || 'input' in part || 'output' in part)
  );
}

function asFileChangeData(value: unknown): AgentFileChangeData | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.toolCallId !== 'string' ||
    typeof value.sourceTool !== 'string' ||
    typeof value.displayPath !== 'string' ||
    typeof value.path !== 'string'
  ) {
    return null;
  }

  const artifact = asFileChangeArtifact(value);
  if (!artifact) {
    return null;
  }

  const stage =
    value.stage === 'approved' ||
    value.stage === 'applied' ||
    value.stage === 'denied' ||
    value.stage === 'failed' ||
    value.stage === 'awaiting-approval'
      ? value.stage
      : 'awaiting-approval';

  return {
    ...artifact,
    id: value.id,
    toolCallId: value.toolCallId,
    sourceTool: value.sourceTool,
    displayPath: value.displayPath,
    stage,
  };
}

export function listMessageFileChanges(message: AgentUIMessage): AgentFileChangeData[] {
  const latestById = new Map<string, AgentFileChangeData>();

  for (const rawPart of message.parts) {
    if (!isRecord(rawPart) || rawPart.type !== 'data-file-change') {
      continue;
    }

    const data = asFileChangeData(rawPart.data);
    if (!data) {
      continue;
    }

    latestById.set(data.id, data);
  }

  return [...latestById.values()];
}

export function addFileChangesToApprovalPayload({
  payload,
  message,
  toolCallId,
}: {
  payload: Record<string, unknown>;
  message: AgentUIMessage;
  toolCallId: string | null;
}): Record<string, unknown> {
  if (!toolCallId) {
    return payload;
  }

  const fileChanges = listMessageFileChanges(message).filter((change) => change.toolCallId === toolCallId);
  if (fileChanges.length === 0) {
    return payload;
  }

  return {
    ...payload,
    fileChanges,
  };
}

export function applyApprovalResponsesToFileChangeParts(messages: AgentUIMessage[]): AgentUIMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') {
      return message;
    }

    const stageByToolCallId = new Map<string, AgentFileChangeStage>();
    for (const rawPart of message.parts) {
      if (!isToolLikePart(rawPart) || !rawPart.toolCallId) {
        continue;
      }

      if (rawPart.state !== 'approval-responded') {
        continue;
      }

      stageByToolCallId.set(rawPart.toolCallId, rawPart.approval?.approved === false ? 'denied' : 'approved');
    }

    if (stageByToolCallId.size === 0) {
      return message;
    }

    return {
      ...message,
      parts: message.parts.map((rawPart) => {
        if (!isRecord(rawPart) || rawPart.type !== 'data-file-change') {
          return rawPart;
        }

        const data = asFileChangeData(rawPart.data);
        if (!data) {
          return rawPart;
        }

        const stage = stageByToolCallId.get(data.toolCallId);
        if (!stage) {
          return rawPart;
        }

        return {
          ...rawPart,
          data: {
            ...data,
            stage,
          },
        };
      }),
    };
  });
}
