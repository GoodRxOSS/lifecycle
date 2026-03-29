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

import Model from './_Model';
import type { AgentSessionSelectedService, AgentSessionWorkspaceRepo } from 'server/lib/agentSession/workspace';

export type AgentPrewarmStatus = 'queued' | 'running' | 'ready' | 'error';

export default class AgentPrewarm extends Model {
  uuid!: string;
  buildUuid!: string;
  namespace!: string;
  repo!: string | null;
  branch!: string | null;
  revision!: string | null;
  pvcName!: string;
  jobName!: string;
  status!: AgentPrewarmStatus;
  services!: string[];
  workspaceRepos!: AgentSessionWorkspaceRepo[];
  serviceRefs!: AgentSessionSelectedService[];
  errorMessage!: string | null;
  completedAt!: string | null;

  static tableName = 'agent_prewarms';
  static timestamps = true;
  static idColumn = 'id';

  static jsonSchema = {
    type: 'object',
    required: ['uuid', 'buildUuid', 'namespace', 'pvcName', 'jobName', 'status'],
    properties: {
      id: { type: 'integer' },
      uuid: {
        type: 'string',
        pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      },
      buildUuid: { type: 'string' },
      namespace: { type: 'string' },
      repo: { type: ['string', 'null'] },
      branch: { type: ['string', 'null'] },
      revision: { type: ['string', 'null'] },
      pvcName: { type: 'string' },
      jobName: { type: 'string' },
      status: { type: 'string', enum: ['queued', 'running', 'ready', 'error'], default: 'queued' },
      services: { type: 'array', items: { type: 'string' }, default: [] },
      workspaceRepos: { type: 'array', items: { type: 'object' }, default: [] },
      serviceRefs: { type: 'array', items: { type: 'object' }, default: [] },
      errorMessage: { type: ['string', 'null'] },
      completedAt: { type: ['string', 'null'] },
    },
  };

  static get jsonAttributes() {
    return ['services', 'workspaceRepos', 'serviceRefs'];
  }
}
