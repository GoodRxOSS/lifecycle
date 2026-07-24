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

import AgentInstructionRule from 'server/models/AgentInstructionRule';
import { getLogger } from 'server/lib/logger';
import { AppError } from 'server/lib/appError';
import { SYSTEM_INSTRUCTION_TEMPLATE_DEFINITIONS } from './systemInstructionTemplates';

export const INSTRUCTION_RULE_ALL_AGENTS_REF = 'all';
export const INSTRUCTION_RULE_MAX_CONTENT_LENGTH = 2000;
export const INSTRUCTION_RULE_MAX_RULES_PER_SCOPE = 50;

export const INSTRUCTION_RULE_AGENT_REFS = [
  INSTRUCTION_RULE_ALL_AGENTS_REF,
  ...SYSTEM_INSTRUCTION_TEMPLATE_DEFINITIONS.map((definition) => definition.ref),
] as const;

export type InstructionRuleView = {
  id: number;
  agentRef: string;
  repositoryFullName: string | null;
  content: string;
  position: number;
  updatedBy: string | null;
  updatedAt: string | null;
};

export type InstructionRuleInput = {
  agentRef: string;
  content: string;
};

export type ResolvedInstructionRule = {
  id: number;
  agentRef: string;
  repositoryFullName: string | null;
  content: string;
};

export type InstructionRuleServiceErrorCode = 'invalid_agent_ref' | 'invalid_content' | 'too_many_rules';

const INSTRUCTION_RULE_ERROR_CONTRACT: Record<InstructionRuleServiceErrorCode, { httpStatus: number; code: string }> = {
  invalid_agent_ref: { httpStatus: 400, code: 'instruction_rule_agent_ref_invalid' },
  invalid_content: { httpStatus: 400, code: 'instruction_rule_content_invalid' },
  too_many_rules: { httpStatus: 400, code: 'instruction_rule_limit_exceeded' },
};

export class InstructionRuleServiceError extends AppError {
  readonly statusCode: number;
  readonly ruleCode: InstructionRuleServiceErrorCode;

  constructor(ruleCode: InstructionRuleServiceErrorCode, message: string, details?: Record<string, unknown>) {
    const contract = INSTRUCTION_RULE_ERROR_CONTRACT[ruleCode];
    super({ httpStatus: contract.httpStatus, code: contract.code, message, details: { ruleCode, ...(details || {}) } });
    this.name = 'InstructionRuleServiceError';
    this.ruleCode = ruleCode;
    this.statusCode = contract.httpStatus;
  }
}

function normalizeRepositoryFullName(repositoryFullName?: string | null): string | null {
  const normalized = repositoryFullName?.trim().toLowerCase();
  return normalized || null;
}

function assertValidRuleInput(rule: InstructionRuleInput): void {
  if (!INSTRUCTION_RULE_AGENT_REFS.includes(rule.agentRef as (typeof INSTRUCTION_RULE_AGENT_REFS)[number])) {
    throw new InstructionRuleServiceError(
      'invalid_agent_ref',
      `Instruction rule agent ref is invalid: ${rule.agentRef}`,
      {
        agentRef: rule.agentRef,
        allowed: [...INSTRUCTION_RULE_AGENT_REFS],
      }
    );
  }
  const content = typeof rule.content === 'string' ? rule.content.trim() : '';
  if (!content) {
    throw new InstructionRuleServiceError('invalid_content', 'Instruction rule content must be non-empty.');
  }
  if (content.length > INSTRUCTION_RULE_MAX_CONTENT_LENGTH) {
    throw new InstructionRuleServiceError(
      'invalid_content',
      `Instruction rule content exceeds ${INSTRUCTION_RULE_MAX_CONTENT_LENGTH} characters.`,
      { length: content.length }
    );
  }
}

function toView(row: AgentInstructionRule): InstructionRuleView {
  return {
    id: row.id,
    agentRef: row.agentRef,
    repositoryFullName: row.repositoryFullName,
    content: row.content,
    position: row.position,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt || null,
  };
}

export default class InstructionRuleService {
  static async listRules(repositoryFullName?: string | null): Promise<InstructionRuleView[]> {
    const scope = normalizeRepositoryFullName(repositoryFullName);
    const query = AgentInstructionRule.query().orderBy('position', 'asc').orderBy('id', 'asc');
    if (scope) {
      query.where('repositoryFullName', scope);
    } else {
      query.whereNull('repositoryFullName');
    }
    const rows = await query;
    return rows.map(toView);
  }

  static async replaceRules({
    repositoryFullName,
    rules,
    updatedBy,
  }: {
    repositoryFullName?: string | null;
    rules: InstructionRuleInput[];
    updatedBy?: string | null;
  }): Promise<InstructionRuleView[]> {
    if (rules.length > INSTRUCTION_RULE_MAX_RULES_PER_SCOPE) {
      throw new InstructionRuleServiceError(
        'too_many_rules',
        `A scope may hold at most ${INSTRUCTION_RULE_MAX_RULES_PER_SCOPE} instruction rules.`,
        { count: rules.length }
      );
    }
    for (const rule of rules) {
      assertValidRuleInput(rule);
    }

    const scope = normalizeRepositoryFullName(repositoryFullName);
    await AgentInstructionRule.transaction(async (trx) => {
      const scopedDelete = AgentInstructionRule.query(trx).delete();
      if (scope) {
        scopedDelete.where('repositoryFullName', scope);
      } else {
        scopedDelete.whereNull('repositoryFullName');
      }
      await scopedDelete;

      if (rules.length > 0) {
        await AgentInstructionRule.query(trx).insert(
          rules.map((rule, index) => ({
            agentRef: rule.agentRef,
            repositoryFullName: scope,
            content: rule.content.trim(),
            position: index,
            updatedBy: updatedBy || null,
          }))
        );
      }
    });

    getLogger().info(
      `AgentExec: instruction rules replaced scope=${scope || 'global'} count=${rules.length} by=${
        updatedBy || 'unknown'
      }`
    );
    return this.listRules(scope);
  }

  static async resolveForRun({
    instructionRefs,
    repoFullName,
  }: {
    instructionRefs: readonly string[];
    repoFullName?: string | null;
  }): Promise<ResolvedInstructionRule[]> {
    const scope = normalizeRepositoryFullName(repoFullName);
    const agentRefs = [INSTRUCTION_RULE_ALL_AGENTS_REF, ...instructionRefs];

    const query = AgentInstructionRule.query()
      .whereIn('agentRef', agentRefs)
      .where((builder) => {
        builder.whereNull('repositoryFullName');
        if (scope) {
          builder.orWhere('repositoryFullName', scope);
        }
      })
      .orderBy('position', 'asc')
      .orderBy('id', 'asc');

    const rows = await query;
    const globalRules = rows.filter((row) => row.repositoryFullName === null);
    const repoRules = rows.filter((row) => row.repositoryFullName !== null);
    return [...globalRules, ...repoRules].map((row) => ({
      id: row.id,
      agentRef: row.agentRef,
      repositoryFullName: row.repositoryFullName,
      content: row.content,
    }));
  }
}
