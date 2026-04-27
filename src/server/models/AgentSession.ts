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

import Model from './_Model';
import type { DevModeResourceSnapshot } from 'server/lib/agentSession/devModeManager';
import type { AgentSessionSkillPlan } from 'server/lib/agentSession/skillPlan';
import { EMPTY_AGENT_SESSION_SKILL_PLAN } from 'server/lib/agentSession/skillPlan';
import type { AgentSessionSelectedService, AgentSessionWorkspaceRepo } from 'server/lib/agentSession/workspace';
import { AgentChatStatus, AgentSessionKind, AgentWorkspaceStatus, BuildKind } from 'shared/constants';

export default class AgentSession extends Model {
  uuid!: string;
  defaultThreadId!: number | null;
  defaultModel!: string;
  defaultHarness!: string | null;
  buildUuid!: string | null;
  buildKind!: BuildKind | null;
  sessionKind!: AgentSessionKind;
  userId!: string;
  ownerGithubUsername!: string | null;
  podName!: string | null;
  namespace!: string | null;
  pvcName!: string | null;
  model!: string;
  status!: 'starting' | 'active' | 'ended' | 'error';
  chatStatus!: AgentChatStatus;
  workspaceStatus!: AgentWorkspaceStatus;
  keepAttachedServicesOnSessionNode!: boolean | null;
  lastActivity!: string;
  endedAt!: string | null;
  devModeSnapshots!: Record<string, DevModeResourceSnapshot>;
  forwardedAgentSecretProviders!: string[];
  workspaceRepos!: AgentSessionWorkspaceRepo[];
  selectedServices!: AgentSessionSelectedService[];
  skillPlan!: AgentSessionSkillPlan;

  static tableName = 'agent_sessions';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['userId', 'model', 'sessionKind', 'chatStatus', 'workspaceStatus'],
    properties: {
      id: { type: 'integer' },
      uuid: {
        type: 'string',
        pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      },
      defaultThreadId: { type: ['integer', 'null'] },
      defaultModel: { type: 'string' },
      defaultHarness: { type: ['string', 'null'] },
      buildUuid: { type: ['string', 'null'] },
      buildKind: {
        type: ['string', 'null'],
        enum: [...Object.values(BuildKind), null],
        default: BuildKind.ENVIRONMENT,
      },
      sessionKind: { type: 'string', enum: Object.values(AgentSessionKind), default: AgentSessionKind.ENVIRONMENT },
      userId: { type: 'string' },
      ownerGithubUsername: { type: ['string', 'null'] },
      podName: { type: ['string', 'null'] },
      namespace: { type: ['string', 'null'] },
      pvcName: { type: ['string', 'null'] },
      model: { type: 'string' },
      status: { type: 'string', enum: ['starting', 'active', 'ended', 'error'], default: 'starting' },
      chatStatus: { type: 'string', enum: Object.values(AgentChatStatus), default: AgentChatStatus.READY },
      workspaceStatus: {
        type: 'string',
        enum: Object.values(AgentWorkspaceStatus),
        default: AgentWorkspaceStatus.READY,
      },
      keepAttachedServicesOnSessionNode: { type: ['boolean', 'null'] },
      lastActivity: { type: 'string' },
      endedAt: { type: ['string', 'null'] },
      devModeSnapshots: { type: 'object', default: {} },
      forwardedAgentSecretProviders: { type: 'array', items: { type: 'string' }, default: [] },
      workspaceRepos: { type: 'array', items: { type: 'object' }, default: [] },
      selectedServices: { type: 'array', items: { type: 'object' }, default: [] },
      skillPlan: {
        type: 'object',
        properties: {
          version: { type: 'integer', enum: [1], default: 1 },
          skills: { type: 'array', items: { type: 'object' }, default: [] },
        },
        default: EMPTY_AGENT_SESSION_SKILL_PLAN,
      },
    },
  };

  static get jsonAttributes() {
    return ['devModeSnapshots', 'forwardedAgentSecretProviders', 'workspaceRepos', 'selectedServices', 'skillPlan'];
  }

  static get relationMappings() {
    const Deploy = require('./Deploy').default;
    const AgentThread = require('./AgentThread').default;
    const AgentSource = require('./AgentSource').default;
    const AgentSandbox = require('./AgentSandbox').default;
    return {
      deploys: {
        relation: Model.HasManyRelation,
        modelClass: Deploy,
        join: {
          from: 'agent_sessions.id',
          to: 'deploys.devModeSessionId',
        },
      },
      defaultThread: {
        relation: Model.BelongsToOneRelation,
        modelClass: AgentThread,
        join: {
          from: 'agent_sessions.defaultThreadId',
          to: 'agent_threads.id',
        },
      },
      source: {
        relation: Model.HasOneRelation,
        modelClass: AgentSource,
        join: {
          from: 'agent_sessions.id',
          to: 'agent_sources.sessionId',
        },
      },
      sandboxes: {
        relation: Model.HasManyRelation,
        modelClass: AgentSandbox,
        join: {
          from: 'agent_sessions.id',
          to: 'agent_sandboxes.sessionId',
        },
      },
    };
  }
}
