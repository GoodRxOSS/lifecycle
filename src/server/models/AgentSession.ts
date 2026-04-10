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
import { BuildKind } from 'shared/constants';

export default class AgentSession extends Model {
  uuid!: string;
  buildUuid!: string | null;
  buildKind!: BuildKind;
  userId!: string;
  ownerGithubUsername!: string | null;
  podName!: string;
  namespace!: string;
  pvcName!: string;
  model!: string;
  status!: 'starting' | 'active' | 'ended' | 'error';
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
    required: ['userId', 'podName', 'namespace', 'pvcName', 'model'],
    properties: {
      id: { type: 'integer' },
      uuid: {
        type: 'string',
        pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      },
      buildUuid: { type: ['string', 'null'] },
      buildKind: { type: 'string', enum: Object.values(BuildKind), default: BuildKind.ENVIRONMENT },
      userId: { type: 'string' },
      ownerGithubUsername: { type: ['string', 'null'] },
      podName: { type: 'string' },
      namespace: { type: 'string' },
      pvcName: { type: 'string' },
      model: { type: 'string' },
      status: { type: 'string', enum: ['starting', 'active', 'ended', 'error'], default: 'starting' },
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
    return {
      deploys: {
        relation: Model.HasManyRelation,
        modelClass: Deploy,
        join: {
          from: 'agent_sessions.id',
          to: 'deploys.devModeSessionId',
        },
      },
    };
  }
}
