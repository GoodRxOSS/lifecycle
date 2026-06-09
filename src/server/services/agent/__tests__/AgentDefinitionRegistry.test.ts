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

const mockUpsert = jest.fn();
const mockFindOne = jest.fn();
const mockOrderBy = jest.fn();
const mockWhere = jest.fn();
const mockWhereIn = jest.fn();

jest.mock('server/models/AgentDefinition', () => ({
  __esModule: true,
  default: {
    upsert: (...args: unknown[]) => mockUpsert(...args),
    query: jest.fn(() => ({
      findOne: (...args: unknown[]) => mockFindOne(...args),
      whereIn: (...args: unknown[]) => {
        mockWhereIn(...args);
        return {
          where: (...whereArgs: unknown[]) => {
            mockWhere(...whereArgs);
            return {
              orderBy: (...orderArgs: unknown[]) => mockOrderBy(...orderArgs),
            };
          },
        };
      },
    })),
  },
}));

import {
  assertAgentDefinitionMutable,
  ensureSystemAgentDefinitionsSeeded,
  inferDefaultAgentSourceKind,
  getSystemAgentDefinition,
  inferDefaultSystemAgentDefinitionId,
  listSystemAgentDefinitions,
  serializeAgentDefinitionSummary,
} from '../AgentDefinitionRegistry';
import { SYSTEM_AGENT_DEFINITIONS } from '../systemAgentDefinitions';
import { AgentSessionKind, AgentWorkspaceStatus } from 'shared/constants';

function buildRow(agentId: keyof typeof SYSTEM_AGENT_DEFINITIONS) {
  const definition = SYSTEM_AGENT_DEFINITIONS[agentId];
  return {
    definitionId: definition.id,
    version: definition.version,
    ownerKind: definition.owner.kind,
    ownerUserId: null,
    ownerOrganizationId: null,
    name: definition.name,
    description: definition.description || null,
    instructionRefs: definition.instructionRefs,
    instructionAddendum: definition.instructionAddendum || null,
    capabilityRefs: definition.capabilityRefs,
    requiredCapabilityRefs: definition.requiredCapabilityRefs,
    optionalCapabilityRefs: definition.optionalCapabilityRefs,
    resourcePolicy: definition.resourcePolicy,
    modelPreference: definition.modelPreference || null,
    status: definition.status,
    codeOwned: definition.codeOwned,
    readOnly: definition.readOnly,
  };
}

describe('AgentDefinitionRegistry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpsert.mockImplementation(async (row) => row);
    mockFindOne.mockResolvedValue(buildRow('system.agent'));
    mockOrderBy.mockResolvedValue([
      buildRow('system.agent'),
      buildRow('system.debug'),
      buildRow('system.develop'),
      buildRow('system.freeform'),
    ]);
  });

  it('seeds exactly the first-party system agent definition definitions as code-owned read-only rows', async () => {
    const rows = await ensureSystemAgentDefinitionsSeeded();

    expect(mockUpsert).toHaveBeenCalledTimes(4);
    expect(mockUpsert.mock.calls.map(([row]) => (row as { definitionId: string }).definitionId).sort()).toEqual([
      'system.agent',
      'system.debug',
      'system.develop',
      'system.freeform',
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'system.debug',
          owner: { kind: 'system', userId: null, organizationId: null },
          codeOwned: true,
          readOnly: true,
          status: 'active',
          requiredCapabilityRefs: expect.arrayContaining(['diagnostics_codefresh', 'diagnostics_kubernetes']),
          optionalCapabilityRefs: [],
        }),
      ])
    );
  });

  it('loads persisted system agent definitions by public id and lists summaries', async () => {
    const definition = await getSystemAgentDefinition('system.agent');
    const summary = serializeAgentDefinitionSummary(definition);

    expect(mockFindOne).toHaveBeenCalledWith({
      definitionId: 'system.agent',
      ownerKind: 'system',
    });
    expect(summary).toEqual(
      expect.objectContaining({
        id: 'system.agent',
        ownerKind: 'system',
        codeOwned: true,
        readOnly: true,
      })
    );

    await expect(listSystemAgentDefinitions()).resolves.toHaveLength(4);
    expect(mockWhereIn).toHaveBeenCalledWith('definitionId', [
      'system.agent',
      'system.debug',
      'system.develop',
      'system.freeform',
    ]);
  });

  it('rejects mutations for code-owned system definitions', () => {
    expect(() => assertAgentDefinitionMutable(SYSTEM_AGENT_DEFINITIONS['system.debug'])).toThrow(
      'code-owned and read-only'
    );
  });

  it('infers the one-agent default system id and source kind from launch source', () => {
    expect(
      inferDefaultSystemAgentDefinitionId(
        { sessionKind: AgentSessionKind.CHAT } as any,
        { input: { buildUuid: 'build-1' } } as any
      )
    ).toBe('system.agent');
    expect(
      inferDefaultSystemAgentDefinitionId({ sessionKind: AgentSessionKind.CHAT } as any, { input: {} } as any)
    ).toBe('system.agent');
    expect(
      inferDefaultSystemAgentDefinitionId(
        { sessionKind: AgentSessionKind.CHAT, workspaceStatus: AgentWorkspaceStatus.READY } as any,
        { input: {} } as any
      )
    ).toBe('system.agent');
    expect(
      inferDefaultSystemAgentDefinitionId({ sessionKind: AgentSessionKind.SANDBOX } as any, { input: {} } as any)
    ).toBe('system.agent');

    expect(
      inferDefaultAgentSourceKind(
        { sessionKind: AgentSessionKind.CHAT } as any,
        { input: { buildUuid: 'build-1' } } as any
      )
    ).toBe('build_context_chat');
    expect(inferDefaultAgentSourceKind({ sessionKind: AgentSessionKind.CHAT } as any, { input: {} } as any)).toBe(
      'freeform_chat'
    );
    expect(
      inferDefaultAgentSourceKind(
        { sessionKind: AgentSessionKind.CHAT, workspaceStatus: AgentWorkspaceStatus.READY } as any,
        { input: {} } as any
      )
    ).toBe('workspace_session');
    expect(inferDefaultAgentSourceKind({ sessionKind: AgentSessionKind.SANDBOX } as any, { input: {} } as any)).toBe(
      'workspace_session'
    );
  });
});
