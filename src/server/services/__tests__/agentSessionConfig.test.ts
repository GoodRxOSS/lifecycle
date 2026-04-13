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

jest.mock('server/services/ai/mcp/config', () => ({
  McpConfigService: jest.fn().mockImplementation(() => ({
    listEffectiveDefinitions: jest.fn().mockResolvedValue([]),
  })),
}));

import AgentSessionConfigService from 'server/services/agentSessionConfig';
import AgentPolicyService from 'server/services/agent/PolicyService';
import { DEFAULT_AGENT_APPROVAL_POLICY } from 'server/services/agent/types';

function makeService() {
  const knex = Object.assign(jest.fn(), {
    fn: {
      now: jest.fn(() => 'now'),
    },
  });

  return new AgentSessionConfigService({ knex } as any, {} as any, {} as any, {} as any);
}

describe('AgentSessionConfigService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists only admin-visible sandbox tools in tool inventory', async () => {
    const service = makeService();

    jest.spyOn(service, 'getGlobalConfig').mockResolvedValue({});
    jest.spyOn(service, 'getEffectiveConfig').mockResolvedValue({
      systemPrompt: 'base',
      appendSystemPrompt: 'append',
      toolRules: [],
    });
    jest.spyOn(AgentPolicyService, 'getEffectivePolicy').mockResolvedValue(DEFAULT_AGENT_APPROVAL_POLICY);

    const entries = await service.listToolInventory('global');

    expect(entries.map((entry) => entry.toolName)).toEqual([
      'workspace.read_file',
      'workspace.glob',
      'workspace.grep',
      'workspace.exec',
      'git.status',
      'git.diff',
      'workspace.write_file',
      'workspace.edit_file',
      'workspace.exec_mutation',
      'git.add',
      'git.commit',
      'git.branch',
    ]);
    expect(entries.find((entry) => entry.toolName === 'skills.list')).toBeUndefined();
    expect(entries.find((entry) => entry.toolName === 'session.get_workspace_state')).toBeUndefined();
  });
});
