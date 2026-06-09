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

import type AgentRun from 'server/models/AgentRun';
import type AgentSession from 'server/models/AgentSession';
import type AgentThread from 'server/models/AgentThread';
import type { RequestUserIdentity } from 'server/lib/get-user';
import type { AgentApprovalPolicy } from './types';
import type { AgentDebugRunIntent, AgentRunPlanSnapshotV1 } from './runPlanTypes';
import type { AgentRuntimeToolMetadata } from './toolMetadata';
import { buildAgentRuntimeToolMetadata } from './toolMetadata';

export type AgentRuntimeContext = {
  sessionUuid: string;
  sessionKind: string | null;
  threadUuid: string;
  runUuid: string;
  userId: string;
  repoFullName: string | null;
  provider: string;
  modelId: string;
  approvalPolicy: AgentApprovalPolicy;
  agentId: string | null;
  sourceKind: string | null;
  debugIntent: AgentDebugRunIntent | null;
};

export type AgentRuntimeToolContext = Required<
  Pick<AgentRuntimeToolMetadata, 'toolKey' | 'serverSlug' | 'sourceToolName'>
> &
  Pick<
    AgentRuntimeToolMetadata,
    | 'catalogCapabilityId'
    | 'capabilityKey'
    | 'approvalMode'
    | 'effect'
    | 'resourceDomain'
    | 'workspaceNeed'
    | 'exposure'
  >;

export type AgentRuntimeToolsContext = Record<string, AgentRuntimeToolContext>;

export const AGENT_RUNTIME_TOOL_CONTEXT_JSON_SCHEMA = {
  type: 'object',
  required: ['toolKey', 'serverSlug', 'sourceToolName', 'catalogCapabilityId', 'capabilityKey', 'approvalMode'],
  additionalProperties: false,
  properties: {
    toolKey: { type: 'string' },
    serverSlug: { type: 'string' },
    sourceToolName: { type: 'string' },
    catalogCapabilityId: { type: 'string' },
    capabilityKey: { type: 'string' },
    approvalMode: { type: 'string' },
    effect: { type: 'string' },
    resourceDomain: { type: 'string' },
    workspaceNeed: { type: 'string' },
    exposure: { type: 'string' },
  },
} as const;

export function buildAgentRuntimeContext({
  session,
  thread,
  run,
  userIdentity,
  repoFullName,
  provider,
  modelId,
  approvalPolicy,
  runPlanSnapshot,
}: {
  session: AgentSession;
  thread: AgentThread;
  run: AgentRun;
  userIdentity: RequestUserIdentity;
  repoFullName?: string | null;
  provider: string;
  modelId: string;
  approvalPolicy: AgentApprovalPolicy;
  runPlanSnapshot?: AgentRunPlanSnapshotV1 | null;
}): AgentRuntimeContext {
  return {
    sessionUuid: session.uuid,
    sessionKind: (session as { sessionKind?: string | null }).sessionKind ?? null,
    threadUuid: thread.uuid,
    runUuid: run.uuid,
    userId: userIdentity.userId,
    repoFullName: repoFullName ?? null,
    provider,
    modelId,
    approvalPolicy,
    agentId: runPlanSnapshot?.agent.id ?? null,
    sourceKind: runPlanSnapshot?.agent.sourceKind ?? null,
    debugIntent: runPlanSnapshot?.debug?.resolvedIntent ?? null,
  };
}

export function buildAgentRuntimeToolContext(metadata: AgentRuntimeToolMetadata): AgentRuntimeToolContext {
  const context: AgentRuntimeToolContext = {
    toolKey: metadata.toolKey,
    serverSlug: metadata.serverSlug || '',
    sourceToolName: metadata.sourceToolName || metadata.toolKey,
    catalogCapabilityId: metadata.catalogCapabilityId,
    capabilityKey: metadata.capabilityKey,
    approvalMode: metadata.approvalMode,
  };

  if (metadata.effect) {
    context.effect = metadata.effect;
  }
  if (metadata.resourceDomain) {
    context.resourceDomain = metadata.resourceDomain;
  }
  if (metadata.workspaceNeed) {
    context.workspaceNeed = metadata.workspaceNeed;
  }
  if (metadata.exposure) {
    context.exposure = metadata.exposure;
  }

  return context;
}

export function buildAgentRuntimeToolContextFromMetadataInput(
  metadata: Omit<AgentRuntimeToolMetadata, 'effect' | 'resourceDomain' | 'workspaceNeed' | 'exposure'>
): AgentRuntimeToolContext {
  return buildAgentRuntimeToolContext(buildAgentRuntimeToolMetadata(metadata));
}

export function buildAgentRuntimeToolsContext(metadata: AgentRuntimeToolMetadata[]): AgentRuntimeToolsContext {
  return Object.fromEntries(
    metadata.map((entry) => [entry.toolKey, buildAgentRuntimeToolContext(entry)])
  ) as AgentRuntimeToolsContext;
}

export function resolveAgentRuntimeToolContext(
  context: unknown,
  fallback: AgentRuntimeToolContext
): AgentRuntimeToolContext {
  if (context && typeof context === 'object') {
    const candidate = context as Partial<AgentRuntimeToolContext>;
    if (
      typeof candidate.toolKey === 'string' &&
      typeof candidate.serverSlug === 'string' &&
      typeof candidate.sourceToolName === 'string'
    ) {
      return {
        ...fallback,
        ...candidate,
      };
    }
  }

  return fallback;
}
