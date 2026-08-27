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

type RuleRow = {
  id: number;
  agentRef: string;
  repositoryFullName: string | null;
  content: string;
  position: number;
  updatedBy: string | null;
  updatedAt: string;
};

const mockRows: RuleRow[] = [];
const mockTransaction = jest.fn();
const mockQuery = jest.fn();
const mockLoggerInfo = jest.fn();
const mockQueryBuilders: any[] = [];

function queryResult(rows: RuleRow[]) {
  const builder: any = Promise.resolve(rows);
  builder.delete = jest.fn(() => builder);
  builder.insert = jest.fn(() => builder);
  builder.whereIn = jest.fn(() => builder);
  builder.where = jest.fn((...args: unknown[]) => {
    if (typeof args[0] === 'function') {
      args[0](builder);
    }
    return builder;
  });
  builder.whereNull = jest.fn(() => builder);
  builder.orWhere = jest.fn(() => builder);
  builder.orderBy = jest.fn(() => builder);
  mockQueryBuilders.push(builder);
  return builder;
}

jest.mock('server/models/AgentInstructionRule', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ info: mockLoggerInfo }),
}));

import InstructionRuleService, {
  INSTRUCTION_RULE_AGENT_REFS,
  INSTRUCTION_RULE_ALL_AGENTS_REF,
  InstructionRuleServiceError,
  INSTRUCTION_RULE_MAX_CONTENT_LENGTH,
  INSTRUCTION_RULE_MAX_RULES_PER_SCOPE,
} from '../InstructionRuleService';
import { renderInstructionRulesBlock, buildSystemPrompt, INSTRUCTION_RULES_BLOCK_HEADER } from '../promptAssembly';

describe('InstructionRuleService.replaceRules validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.length = 0;
    mockQueryBuilders.length = 0;
    mockQuery.mockImplementation(() => queryResult(mockRows));
    mockTransaction.mockImplementation(async (callback) => callback('transaction'));
  });

  it('rejects unknown agent refs before touching the database', async () => {
    await expect(
      InstructionRuleService.replaceRules({ rules: [{ agentRef: 'system:bogus', content: 'x' }] })
    ).rejects.toMatchObject({ ruleCode: 'invalid_agent_ref' });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects empty and oversized rule content', async () => {
    await expect(
      InstructionRuleService.replaceRules({ rules: [{ agentRef: 'all', content: '   ' }] })
    ).rejects.toMatchObject({ ruleCode: 'invalid_content' });

    await expect(
      InstructionRuleService.replaceRules({
        rules: [{ agentRef: 'all', content: 'x'.repeat(INSTRUCTION_RULE_MAX_CONTENT_LENGTH + 1) }],
      })
    ).rejects.toMatchObject({ ruleCode: 'invalid_content' });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects non-string content received across a runtime boundary', async () => {
    await expect(
      InstructionRuleService.replaceRules({
        rules: [{ agentRef: 'all', content: null as unknown as string }],
      })
    ).rejects.toMatchObject({ ruleCode: 'invalid_content' });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects more rules than the per-scope limit', async () => {
    const rules = Array.from({ length: INSTRUCTION_RULE_MAX_RULES_PER_SCOPE + 1 }, (_, index) => ({
      agentRef: 'all',
      content: `rule ${index}`,
    }));
    await expect(InstructionRuleService.replaceRules({ rules })).rejects.toMatchObject({
      ruleCode: 'too_many_rules',
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('accepts every built-in agent ref and the all scope', async () => {
    expect(INSTRUCTION_RULE_AGENT_REFS).toEqual([
      INSTRUCTION_RULE_ALL_AGENTS_REF,
      'system:debug',
      'system:develop',
      'system:freeform',
    ]);
    await expect(
      InstructionRuleService.replaceRules({
        rules: [
          { agentRef: 'all', content: 'a' },
          { agentRef: 'system:debug', content: 'b' },
          { agentRef: 'system:develop', content: 'c' },
          { agentRef: 'system:freeform', content: 'd' },
        ],
      })
    ).resolves.toEqual([]);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('normalizes a repository scope, replaces its rules atomically, and returns the stored view', async () => {
    mockRows.push({
      id: 7,
      agentRef: 'system:debug',
      repositoryFullName: 'org/repo',
      content: 'stored content',
      position: 0,
      updatedBy: 'owner@example.com',
      updatedAt: '2026-08-27T12:00:00.000Z',
    });

    await expect(
      InstructionRuleService.replaceRules({
        repositoryFullName: ' Org/Repo ',
        rules: [{ agentRef: 'system:debug', content: '  stored content  ' }],
        updatedBy: 'owner@example.com',
      })
    ).resolves.toEqual([
      {
        id: 7,
        agentRef: 'system:debug',
        repositoryFullName: 'org/repo',
        content: 'stored content',
        position: 0,
        updatedBy: 'owner@example.com',
        updatedAt: '2026-08-27T12:00:00.000Z',
      },
    ]);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenNthCalledWith(1, 'transaction');
    expect(mockQuery).toHaveBeenNthCalledWith(2, 'transaction');
    expect(mockQuery).toHaveBeenNthCalledWith(3);
    expect(mockQueryBuilders[0].delete).toHaveBeenCalledTimes(1);
    expect(mockQueryBuilders[0].where).toHaveBeenCalledWith('repositoryFullName', 'org/repo');
    expect(mockQueryBuilders[0].whereNull).not.toHaveBeenCalled();
    expect(mockQueryBuilders[1].insert).toHaveBeenCalledWith([
      {
        agentRef: 'system:debug',
        repositoryFullName: 'org/repo',
        content: 'stored content',
        position: 0,
        updatedBy: 'owner@example.com',
      },
    ]);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'AgentExec: instruction rules replaced scope=org/repo count=1 by=owner@example.com'
    );
  });

  it('clears the global scope without issuing an insert for an empty replacement', async () => {
    await expect(
      InstructionRuleService.replaceRules({ repositoryFullName: '   ', rules: [], updatedBy: '' })
    ).resolves.toEqual([]);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQueryBuilders[0].delete).toHaveBeenCalledTimes(1);
    expect(mockQueryBuilders[0].whereNull).toHaveBeenCalledWith('repositoryFullName');
    expect(mockQueryBuilders[0].insert).not.toHaveBeenCalled();
    expect(mockQueryBuilders[1].whereNull).toHaveBeenCalledWith('repositoryFullName');
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'AgentExec: instruction rules replaced scope=global count=0 by=unknown'
    );
  });

  it('exposes an AppError contract for route mapping', () => {
    const error = new InstructionRuleServiceError('invalid_agent_ref', 'bad ref');
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('instruction_rule_agent_ref_invalid');
  });
});

describe('InstructionRuleService.listRules', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.length = 0;
    mockQueryBuilders.length = 0;
    mockQuery.mockImplementation(() => queryResult(mockRows));
  });

  it('normalizes a repository scope, applies stable ordering, and maps nullable timestamps', async () => {
    mockRows.push({
      id: 3,
      agentRef: 'all',
      repositoryFullName: 'org/repo',
      content: 'rule',
      position: 2,
      updatedBy: null,
      updatedAt: '',
    });

    await expect(InstructionRuleService.listRules(' Org/Repo ')).resolves.toEqual([
      {
        id: 3,
        agentRef: 'all',
        repositoryFullName: 'org/repo',
        content: 'rule',
        position: 2,
        updatedBy: null,
        updatedAt: null,
      },
    ]);

    const builder = mockQueryBuilders[0];
    expect(builder.orderBy.mock.calls).toEqual([
      ['position', 'asc'],
      ['id', 'asc'],
    ]);
    expect(builder.where).toHaveBeenCalledWith('repositoryFullName', 'org/repo');
    expect(builder.whereNull).not.toHaveBeenCalled();
  });

  it('queries the global scope when the repository is absent', async () => {
    await expect(InstructionRuleService.listRules()).resolves.toEqual([]);

    expect(mockQueryBuilders[0].whereNull).toHaveBeenCalledWith('repositoryFullName');
    expect(mockQueryBuilders[0].where).not.toHaveBeenCalled();
  });
});

describe('InstructionRuleService.resolveForRun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.length = 0;
    mockQueryBuilders.length = 0;
    mockQuery.mockImplementation(() => queryResult(mockRows));
  });

  it('orders global rules before repository rules regardless of position interleaving', async () => {
    mockRows.push(
      {
        id: 1,
        agentRef: 'all',
        repositoryFullName: 'org/repo',
        content: 'repo rule',
        position: 0,
        updatedBy: null,
        updatedAt: 't',
      },
      {
        id: 2,
        agentRef: 'system:debug',
        repositoryFullName: null,
        content: 'global rule',
        position: 1,
        updatedBy: null,
        updatedAt: 't',
      }
    );

    const resolved = await InstructionRuleService.resolveForRun({
      instructionRefs: ['system:debug'],
      repoFullName: ' Org/Repo ',
    });

    expect(resolved.map((rule) => rule.content)).toEqual(['global rule', 'repo rule']);
    const builder = mockQueryBuilders[0];
    expect(builder.whereIn).toHaveBeenCalledWith('agentRef', ['all', 'system:debug']);
    expect(builder.whereNull).toHaveBeenCalledWith('repositoryFullName');
    expect(builder.orWhere).toHaveBeenCalledWith('repositoryFullName', 'org/repo');
    expect(builder.orderBy.mock.calls).toEqual([
      ['position', 'asc'],
      ['id', 'asc'],
    ]);
  });

  it('queries only global rules when no repository scope is present', async () => {
    mockRows.push({
      id: 2,
      agentRef: 'all',
      repositoryFullName: null,
      content: 'global rule',
      position: 0,
      updatedBy: null,
      updatedAt: 't',
    });

    await expect(InstructionRuleService.resolveForRun({ instructionRefs: [] })).resolves.toEqual([
      { id: 2, agentRef: 'all', repositoryFullName: null, content: 'global rule' },
    ]);

    expect(mockQueryBuilders[0].whereIn).toHaveBeenCalledWith('agentRef', ['all']);
    expect(mockQueryBuilders[0].whereNull).toHaveBeenCalledWith('repositoryFullName');
    expect(mockQueryBuilders[0].orWhere).not.toHaveBeenCalled();
  });
});

describe('renderInstructionRulesBlock', () => {
  it('returns undefined for no rules', () => {
    expect(renderInstructionRulesBlock([])).toBeUndefined();
    expect(renderInstructionRulesBlock(['   '])).toBeUndefined();
  });

  it('renders bullets under the admin header and indents continuation lines', () => {
    const block = renderInstructionRulesBlock(['Answer briefly.', 'First line\nsecond line']);
    expect(block).toBe(`${INSTRUCTION_RULES_BLOCK_HEADER}\n- Answer briefly.\n- First line\n  second line`);
  });

  it('joins prompt parts with blank lines and drops empties', () => {
    expect(buildSystemPrompt(['a', undefined, ' ', 'b'])).toBe('a\n\nb');
    expect(buildSystemPrompt([undefined])).toBeUndefined();
  });
});
