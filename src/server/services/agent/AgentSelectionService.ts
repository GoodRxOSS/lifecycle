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

import type { Transaction } from 'objection';
import AgentRun from 'server/models/AgentRun';
import AgentThread from 'server/models/AgentThread';
import type AgentSession from 'server/models/AgentSession';
import type AgentSource from 'server/models/AgentSource';
import type { RequestUserIdentity } from 'server/lib/get-user';
import { ConflictError } from 'server/lib/appError';
import AgentCapabilityService from './CapabilityService';
import * as AgentDefinitionRegistry from './AgentDefinitionRegistry';
import {
  CUSTOM_AGENT_NEEDS_CONVERSION_MESSAGE,
  customAgentDefinitionNeedsOneAgentConversion,
  customAgentDefinitionService,
} from './CustomAgentDefinitionService';
import AgentMessageStore from './MessageStore';
import AgentPolicyService from './PolicyService';
import { TERMINAL_RUN_STATUSES } from './RunService';
import AgentSourceService from './SourceService';
import AgentThreadService from './ThreadService';
import type { AgentDefinitionContract } from './agentDefinitionTypes';
import type { AgentCapabilitySourceKind } from './capabilityCatalog';
import { SYSTEM_VISIBLE_AGENT_DEFINITION_IDS, type SystemAgentDefinitionId } from './systemAgentDefinitions';

export type AgentSelectionGroupId = 'built_in' | 'my_agents';

export type AgentSelectionUnavailableReason =
  | 'unknown_agent'
  | 'active_run'
  | 'disabled_agent'
  | 'requires_workspace'
  | 'needs_conversion'
  | 'source_incompatible'
  | 'disabled_by_policy';

export class AgentThreadAgentSwitchError extends ConflictError {
  readonly reason: AgentSelectionUnavailableReason;
  constructor(reason: AgentSelectionUnavailableReason, message: string, extra: Record<string, unknown> = {}) {
    super(message, 'agent_switch_blocked', { reason, ...extra });
    this.name = 'AgentThreadAgentSwitchError';
    this.reason = reason;
  }
}

export type AgentSelectionSummary = {
  id: string;
  ownerKind: AgentDefinitionContract['owner']['kind'];
  label: string;
  description: string | null;
  available: boolean;
  unavailableReason: AgentSelectionUnavailableReason | null;
  unavailableMessage: string | null;
  group: AgentSelectionGroupId;
};

export type AgentSelectionGroup = {
  id: AgentSelectionGroupId;
  label: string;
  agents: AgentSelectionSummary[];
};

export type AgentSelectionState = {
  selectedId: string | null;
  defaultId: SystemAgentDefinitionId;
  currentId: string;
  groups: AgentSelectionGroup[];
};

export type SwitchThreadAgentInput = {
  threadId: string;
  userIdentity: RequestUserIdentity;
  agentId: string;
};

export type SwitchThreadAgentResult = {
  previousAgent: AgentSelectionSummary;
  nextAgent: AgentSelectionSummary;
  switched: boolean;
  state: AgentSelectionState;
};

type ValidationContext = {
  sourceKind: AgentCapabilitySourceKind;
  capabilityPolicy: Awaited<ReturnType<typeof AgentCapabilityService.resolveSessionContext>>['capabilityPolicy'];
  customAgentCreationPolicy: Awaited<
    ReturnType<typeof AgentCapabilityService.resolveSessionContext>
  >['customAgentCreationPolicy'];
  approvalPolicy: Awaited<ReturnType<typeof AgentCapabilityService.resolveSessionContext>>['approvalPolicy'];
  activeRun: boolean;
};

function orderSystemDefinitions(definitions: AgentDefinitionContract[]): AgentDefinitionContract[] {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  return SYSTEM_VISIBLE_AGENT_DEFINITION_IDS.flatMap((agentId) => {
    const definition = byId.get(agentId);
    return definition ? [definition] : [];
  });
}

function actorLabel(userIdentity: RequestUserIdentity): string {
  return (
    userIdentity.displayName ||
    userIdentity.preferredUsername ||
    userIdentity.githubUsername ||
    userIdentity.email ||
    'You'
  );
}

async function hasActiveRun(sessionId: number, trx?: Transaction): Promise<boolean> {
  const activeRun = await AgentRun.query(trx).where({ sessionId }).whereNotIn('status', TERMINAL_RUN_STATUSES).first();

  return Boolean(activeRun);
}

function validateDefinition(
  definition: AgentDefinitionContract,
  context: ValidationContext
): Pick<AgentSelectionSummary, 'available' | 'unavailableReason' | 'unavailableMessage'> {
  if (context.activeRun) {
    return {
      available: false,
      unavailableReason: 'active_run',
      unavailableMessage: 'Wait for the current run to finish before switching agents.',
    };
  }

  if (definition.status !== 'active') {
    return {
      available: false,
      unavailableReason: 'disabled_agent',
      unavailableMessage: `${definition.name} is unavailable.`,
    };
  }

  if (customAgentDefinitionNeedsOneAgentConversion(definition)) {
    return {
      available: false,
      unavailableReason: 'needs_conversion',
      unavailableMessage: CUSTOM_AGENT_NEEDS_CONVERSION_MESSAGE,
    };
  }

  if (definition.resourcePolicy.workspaceRequired && context.sourceKind !== 'workspace_session') {
    return {
      available: false,
      unavailableReason: 'requires_workspace',
      unavailableMessage: 'Requires a prepared workspace.',
    };
  }

  if (!definition.resourcePolicy.sourceKinds.includes(context.sourceKind)) {
    return {
      available: false,
      unavailableReason: 'source_incompatible',
      unavailableMessage: `${definition.name} is unavailable for this conversation.`,
    };
  }

  const requiredCapabilityRefs = definition.requiredCapabilityRefs || definition.capabilityRefs;
  const blockedCapability = AgentPolicyService.resolveCapabilitySetAccess(requiredCapabilityRefs, {
    capabilityPolicy: context.capabilityPolicy,
    customAgentCreationPolicy: context.customAgentCreationPolicy,
    approvalPolicy: context.approvalPolicy,
    definitionOwnerKind: definition.owner.kind,
    sourceKind: context.sourceKind,
  }).find((capability) => !capability.allowed);

  if (blockedCapability) {
    return {
      available: false,
      unavailableReason: 'disabled_by_policy',
      unavailableMessage: `${definition.name} is unavailable because a required capability is disabled.`,
    };
  }

  return {
    available: true,
    unavailableReason: null,
    unavailableMessage: null,
  };
}

function summarizeDefinition(
  definition: AgentDefinitionContract,
  context: ValidationContext,
  group: AgentSelectionGroupId
): AgentSelectionSummary {
  return {
    id: definition.id,
    ownerKind: definition.owner.kind,
    label: definition.name,
    description: definition.description || null,
    group,
    ...validateDefinition(definition, context),
  };
}

function flattenGroups(groups: AgentSelectionGroup[]): AgentSelectionSummary[] {
  return groups.flatMap((group) => group.agents);
}

export default class AgentSelectionService {
  static async getThreadAgentState({
    threadId,
    userIdentity,
  }: {
    threadId: string;
    userIdentity: RequestUserIdentity;
  }): Promise<AgentSelectionState> {
    const { thread, session } = await AgentThreadService.getOwnedThreadWithSession(threadId, userIdentity.userId);
    return this.getThreadAgentStateForThread({ thread, session, userIdentity });
  }

  static async getThreadAgentStateForThread({
    thread,
    session,
    userIdentity,
  }: {
    thread: AgentThread;
    session: AgentSession;
    userIdentity: RequestUserIdentity;
  }): Promise<AgentSelectionState> {
    const source = await AgentSourceService.getSessionSource(session.id);
    if (!source || source.status !== 'ready') {
      throw new AgentThreadAgentSwitchError('source_incompatible', 'Session source is not ready yet.');
    }

    return this.buildThreadAgentState({ thread, session, source, userIdentity });
  }

  static async switchThreadAgent({
    threadId,
    userIdentity,
    agentId,
  }: SwitchThreadAgentInput): Promise<SwitchThreadAgentResult> {
    const { thread, session } = await AgentThreadService.getOwnedThreadWithSession(threadId, userIdentity.userId);
    const source = await AgentSourceService.getSessionSource(session.id);
    if (!source || source.status !== 'ready') {
      throw new AgentThreadAgentSwitchError('source_incompatible', 'Session source is not ready yet.');
    }

    const state = await this.buildThreadAgentState({ thread, session, source, userIdentity });
    const agents = flattenGroups(state.groups);
    const previousAgent = agents.find((agent) => agent.id === state.currentId);
    const nextAgent = agents.find((agent) => agent.id === agentId);
    if (!previousAgent || !nextAgent) {
      throw new AgentThreadAgentSwitchError('unknown_agent', 'Unknown agent.', { agentId });
    }

    if (!nextAgent.available) {
      throw new AgentThreadAgentSwitchError(
        nextAgent.unavailableReason || 'source_incompatible',
        nextAgent.unavailableMessage || `${nextAgent.label} is unavailable.`,
        { agentId }
      );
    }

    if (state.currentId === agentId) {
      return {
        previousAgent,
        nextAgent,
        switched: false,
        state,
      };
    }

    return AgentThread.transaction(async (trx) => {
      if (await hasActiveRun(session.id, trx)) {
        throw new AgentThreadAgentSwitchError(
          'active_run',
          'Wait for the current run to finish before switching agents.',
          { agentId }
        );
      }

      const patchedThread = await AgentThread.query(trx).patchAndFetchById(thread.id, {
        metadata: {
          ...(thread.metadata || {}),
          ...AgentThreadService.buildSelectedAgentDefinitionMetadataPatch(agentId),
        },
      } as Partial<AgentThread>);

      await AgentMessageStore.createAgentSwitchEvent({
        thread: patchedThread,
        actor: {
          userId: userIdentity.userId,
          label: actorLabel(userIdentity),
        },
        beforeAgent: {
          id: previousAgent.id,
          label: previousAgent.label,
        },
        afterAgent: {
          id: nextAgent.id,
          label: nextAgent.label,
        },
        trx,
      });

      return {
        previousAgent,
        nextAgent,
        switched: true,
        state: {
          ...state,
          selectedId: agentId,
          currentId: agentId,
        },
      };
    });
  }

  private static async buildThreadAgentState({
    thread,
    session,
    source,
    userIdentity,
  }: {
    thread: AgentThread;
    session: AgentSession;
    source: AgentSource;
    userIdentity: RequestUserIdentity;
  }): Promise<AgentSelectionState> {
    await AgentDefinitionRegistry.ensureSystemAgentDefinitionsSeeded();
    const systemDefinitions = orderSystemDefinitions(await AgentDefinitionRegistry.listSystemAgentDefinitions());
    const customDefinitions = (
      await customAgentDefinitionService.listUserDefinitions({ userId: userIdentity.userId })
    ).filter((definition) => definition.status === 'active');
    const defaultId = AgentDefinitionRegistry.inferDefaultSystemAgentDefinitionId(session, source);
    const selectedId = AgentThreadService.getSelectedAgentDefinitionId(thread);
    const { approvalPolicy, capabilityPolicy, customAgentCreationPolicy } =
      await AgentCapabilityService.resolveSessionContext(session.uuid, userIdentity);
    const activeRun = await hasActiveRun(session.id);
    const context: ValidationContext = {
      sourceKind: AgentDefinitionRegistry.inferDefaultAgentSourceKind(session, source),
      capabilityPolicy,
      customAgentCreationPolicy,
      approvalPolicy,
      activeRun,
    };
    const groups: AgentSelectionGroup[] = [
      {
        id: 'built_in',
        label: 'Built in',
        agents: systemDefinitions.map((definition) => summarizeDefinition(definition, context, 'built_in')),
      },
      {
        id: 'my_agents',
        label: 'My agents',
        agents: customDefinitions.map((definition) => summarizeDefinition(definition, context, 'my_agents')),
      },
    ];
    const agents = flattenGroups(groups);
    const selectedAgent = selectedId ? agents.find((agent) => agent.id === selectedId) : null;

    return {
      selectedId: selectedAgent ? selectedId : null,
      defaultId,
      currentId: selectedAgent ? selectedId! : defaultId,
      groups,
    };
  }
}
