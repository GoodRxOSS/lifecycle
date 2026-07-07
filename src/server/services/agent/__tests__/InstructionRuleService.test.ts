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

function queryResult(rows: RuleRow[]) {
  const builder: any = Promise.resolve(rows);
  builder.whereIn = () => builder;
  builder.where = () => builder;
  builder.whereNull = () => builder;
  builder.orderBy = () => builder;
  return builder;
}

jest.mock('server/models/AgentInstructionRule', () => ({
  __esModule: true,
  default: {
    query: jest.fn(() => queryResult(mockRows)),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

import InstructionRuleService, {
  InstructionRuleServiceError,
  INSTRUCTION_RULE_MAX_CONTENT_LENGTH,
  INSTRUCTION_RULE_MAX_RULES_PER_SCOPE,
} from '../InstructionRuleService';
import { renderInstructionRulesBlock, buildSystemPrompt, INSTRUCTION_RULES_BLOCK_HEADER } from '../promptAssembly';

describe('InstructionRuleService.replaceRules validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.length = 0;
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
    mockTransaction.mockResolvedValue(undefined);
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

  it('exposes an AppError contract for route mapping', () => {
    const error = new InstructionRuleServiceError('invalid_agent_ref', 'bad ref');
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('instruction_rule_agent_ref_invalid');
  });
});

describe('InstructionRuleService.resolveForRun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRows.length = 0;
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
      repoFullName: 'org/repo',
    });

    expect(resolved.map((rule) => rule.content)).toEqual(['global rule', 'repo rule']);
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
