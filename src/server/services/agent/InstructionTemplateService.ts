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

import { createHash } from 'crypto';
import AgentInstructionTemplate from 'server/models/AgentInstructionTemplate';
import { getLogger } from 'server/lib/logger';
import {
  SYSTEM_INSTRUCTION_TEMPLATE_DEFINITIONS,
  type SystemInstructionTemplateDefinition,
} from './systemInstructionTemplates';

export type InstructionTemplateEffectiveSource = 'default' | 'override';

export type InstructionTemplateServiceErrorCode = 'invalid_ref' | 'unknown_ref' | 'invalid_content';

export type InstructionTemplateView = {
  ref: string;
  name: string;
  description: string | null;
  default: {
    content: string;
    version: number;
    hash: string;
  };
  override: {
    content: string;
    version: number;
    hash: string;
    baseDefaultVersion: number;
    baseDefaultHash: string;
    updatedBy: string | null;
    updatedAt: string | null;
  } | null;
  effective: {
    source: InstructionTemplateEffectiveSource;
    content: string;
    version: number;
    hash: string;
  };
};

export type ResolvedInstructionTemplate = {
  ref: string;
  source: InstructionTemplateEffectiveSource;
  content: string;
  version: number;
  hash: string;
};

export type UpdateInstructionTemplateOverrideInput = {
  content: string;
  updatedBy?: string | null;
};

export class InstructionTemplateServiceError extends Error {
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    public readonly code: InstructionTemplateServiceErrorCode,
    message: string,
    options: { statusCode?: number; details?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = 'InstructionTemplateServiceError';
    this.statusCode = options.statusCode || (code === 'unknown_ref' ? 404 : 400);
    this.details = options.details;
  }
}

const TEMPLATE_REF_PATTERN = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;

export function computeInstructionTemplateContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function assertValidTemplateRef(ref: string): void {
  if (typeof ref !== 'string' || !TEMPLATE_REF_PATTERN.test(ref)) {
    throw new InstructionTemplateServiceError('invalid_ref', 'Instruction template ref is invalid.', {
      details: { ref },
    });
  }
}

function assertValidContent(content: string): void {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new InstructionTemplateServiceError('invalid_content', 'Instruction template content must be non-empty.');
  }
}

function templateNotFound(ref: string): InstructionTemplateServiceError {
  return new InstructionTemplateServiceError('unknown_ref', `Instruction template not found: ${ref}`, {
    details: { ref },
  });
}

function toView(row: AgentInstructionTemplate): InstructionTemplateView {
  const override =
    typeof row.overrideContent === 'string'
      ? {
          content: row.overrideContent,
          version: row.overrideVersion as number,
          hash: row.overrideHash as string,
          baseDefaultVersion: row.overrideBaseDefaultVersion as number,
          baseDefaultHash: row.overrideBaseDefaultHash as string,
          updatedBy: row.overrideUpdatedBy || null,
          updatedAt: row.overrideUpdatedAt || null,
        }
      : null;

  return {
    ref: row.ref,
    name: row.name,
    description: row.description || null,
    default: {
      content: row.defaultContent,
      version: row.defaultVersion,
      hash: row.defaultHash,
    },
    override,
    effective: override
      ? {
          source: 'override',
          content: override.content,
          version: override.version,
          hash: override.hash,
        }
      : {
          source: 'default',
          content: row.defaultContent,
          version: row.defaultVersion,
          hash: row.defaultHash,
        },
  };
}

function toResolved(row: AgentInstructionTemplate): ResolvedInstructionTemplate {
  const view = toView(row);
  return {
    ref: view.ref,
    source: view.effective.source,
    content: view.effective.content,
    version: view.effective.version,
    hash: view.effective.hash,
  };
}

export default class InstructionTemplateService {
  static async seedSystemTemplates(
    definitions: readonly SystemInstructionTemplateDefinition[] = SYSTEM_INSTRUCTION_TEMPLATE_DEFINITIONS
  ): Promise<InstructionTemplateView[]> {
    const rows = await Promise.all(
      definitions.map((definition) => {
        assertValidTemplateRef(definition.ref);
        assertValidContent(definition.defaultContent);

        return AgentInstructionTemplate.upsert(
          {
            ref: definition.ref,
            name: definition.name,
            description: definition.description,
            defaultContent: definition.defaultContent,
            defaultVersion: definition.defaultVersion,
            defaultHash: computeInstructionTemplateContentHash(definition.defaultContent),
          },
          ['ref']
        ) as Promise<AgentInstructionTemplate>;
      })
    );

    getLogger().info(`AgentExec: instruction templates seeded count=${rows.length}`);
    return rows.map(toView);
  }

  static async listTemplates(): Promise<InstructionTemplateView[]> {
    const rows = await AgentInstructionTemplate.query().orderBy('ref', 'asc');
    return rows.map(toView);
  }

  static async getTemplate(ref: string): Promise<InstructionTemplateView> {
    const row = await this.findTemplate(ref);
    return toView(row);
  }

  static async updateOverride(
    ref: string,
    input: UpdateInstructionTemplateOverrideInput
  ): Promise<InstructionTemplateView> {
    assertValidTemplateRef(ref);
    assertValidContent(input.content);

    const row = await this.findTemplate(ref);
    const overrideHash = computeInstructionTemplateContentHash(input.content);
    const overrideVersion = (row.overrideVersion || 0) + 1;
    const overrideUpdatedAt = new Date().toISOString();

    const updated = await AgentInstructionTemplate.query().patchAndFetchById(row.id, {
      overrideContent: input.content,
      overrideVersion,
      overrideHash,
      overrideBaseDefaultVersion: row.defaultVersion,
      overrideBaseDefaultHash: row.defaultHash,
      overrideUpdatedBy: input.updatedBy || null,
      overrideUpdatedAt,
    });

    if (!updated) {
      throw templateNotFound(ref);
    }

    getLogger().info(`AgentExec: instruction template override updated ref=${ref} version=${overrideVersion}`);
    return toView(updated);
  }

  static async resetOverride(ref: string): Promise<InstructionTemplateView> {
    const row = await this.findTemplate(ref);
    const updated = await AgentInstructionTemplate.query().patchAndFetchById(row.id, {
      overrideContent: null,
      overrideVersion: null,
      overrideHash: null,
      overrideBaseDefaultVersion: null,
      overrideBaseDefaultHash: null,
      overrideUpdatedBy: null,
      overrideUpdatedAt: null,
    });

    if (!updated) {
      throw templateNotFound(ref);
    }

    getLogger().info(`AgentExec: instruction template override reset ref=${ref}`);
    return toView(updated);
  }

  static async resolveRefs(refs: readonly string[]): Promise<ResolvedInstructionTemplate[]> {
    for (const ref of refs) {
      assertValidTemplateRef(ref);
    }

    const uniqueRefs = Array.from(new Set(refs));
    const rows = await AgentInstructionTemplate.query().whereIn('ref', uniqueRefs).orderBy('ref', 'asc');
    const rowsByRef = new Map(rows.map((row) => [row.ref, row]));

    for (const ref of refs) {
      if (!rowsByRef.has(ref)) {
        throw templateNotFound(ref);
      }
    }

    return refs.map((ref) => toResolved(rowsByRef.get(ref) as AgentInstructionTemplate));
  }

  private static async findTemplate(ref: string): Promise<AgentInstructionTemplate> {
    assertValidTemplateRef(ref);

    const row = await AgentInstructionTemplate.query().findOne({ ref });
    if (!row) {
      throw templateNotFound(ref);
    }

    return row;
  }
}
