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

type TemplateRow = {
  id: number;
  ref: string;
  name: string;
  description: string | null;
  defaultContent: string;
  defaultVersion: number;
  defaultHash: string;
  overrideContent: string | null;
  overrideVersion: number | null;
  overrideHash: string | null;
  overrideBaseDefaultVersion: number | null;
  overrideBaseDefaultHash: string | null;
  overrideUpdatedBy: string | null;
  overrideUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const rows = new Map<string, TemplateRow>();
let nextId = 1;

const mockUpsert = jest.fn();
const mockFindOne = jest.fn();
const mockOrderBy = jest.fn();
const mockWhereIn = jest.fn();
const mockPatchAndFetchById = jest.fn();

function cloneRow(row: TemplateRow): TemplateRow {
  return { ...row };
}

function sortRows(input: TemplateRow[]): TemplateRow[] {
  return [...input].sort((left, right) => left.ref.localeCompare(right.ref));
}

jest.mock('server/models/AgentInstructionTemplate', () => ({
  __esModule: true,
  default: {
    upsert: (...args: unknown[]) => mockUpsert(...args),
    query: jest.fn(() => ({
      findOne: (...args: unknown[]) => mockFindOne(...args),
      orderBy: (...args: unknown[]) => mockOrderBy(...args),
      whereIn: (...args: unknown[]) => {
        mockWhereIn(...args);
        return {
          orderBy: (...orderArgs: unknown[]) => mockOrderBy(...orderArgs),
        };
      },
      patchAndFetchById: (...args: unknown[]) => mockPatchAndFetchById(...args),
    })),
  },
}));

import InstructionTemplateService, {
  InstructionTemplateServiceError,
  computeInstructionTemplateContentHash,
} from '../InstructionTemplateService';
import {
  SYSTEM_INSTRUCTION_TEMPLATE_DEFINITIONS,
  SYSTEM_INSTRUCTION_TEMPLATE_REFS,
  type SystemInstructionTemplateDefinition,
} from '../systemInstructionTemplates';
import { SYSTEM_AGENT_DEFINITIONS } from '../systemAgentDefinitions';

function buildRow(
  input: Partial<TemplateRow> & Pick<TemplateRow, 'ref' | 'name' | 'defaultContent' | 'defaultVersion' | 'defaultHash'>
): TemplateRow {
  const timestamp = '2026-05-01T00:00:00.000Z';
  return {
    id: nextId++,
    description: null,
    overrideContent: null,
    overrideVersion: null,
    overrideHash: null,
    overrideBaseDefaultVersion: null,
    overrideBaseDefaultHash: null,
    overrideUpdatedBy: null,
    overrideUpdatedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...input,
  };
}

function releaseUpdate(
  ref: SystemInstructionTemplateDefinition['ref'],
  defaultContent: string,
  defaultVersion: number
): SystemInstructionTemplateDefinition[] {
  return SYSTEM_INSTRUCTION_TEMPLATE_DEFINITIONS.map((definition) =>
    definition.ref === ref
      ? {
          ...definition,
          defaultContent,
          defaultVersion,
        }
      : definition
  );
}

describe('InstructionTemplateService', () => {
  beforeEach(() => {
    rows.clear();
    nextId = 1;
    jest.clearAllMocks();

    mockUpsert.mockImplementation(async (row: Partial<TemplateRow>) => {
      const existing = rows.get(row.ref as string);
      if (existing) {
        Object.assign(existing, row, { updatedAt: '2026-05-01T00:00:01.000Z' });
        return cloneRow(existing);
      }

      const inserted = buildRow(row as TemplateRow);
      rows.set(inserted.ref, inserted);
      return cloneRow(inserted);
    });

    mockFindOne.mockImplementation(async (criteria: { ref?: string }) => {
      const row = criteria.ref ? rows.get(criteria.ref) : undefined;
      return row ? cloneRow(row) : undefined;
    });

    mockOrderBy.mockImplementation(async () => sortRows(Array.from(rows.values())).map(cloneRow));

    mockPatchAndFetchById.mockImplementation(async (id: number, patch: Partial<TemplateRow>) => {
      const row = Array.from(rows.values()).find((candidate) => candidate.id === id);
      if (!row) {
        return undefined;
      }

      Object.assign(row, patch, { updatedAt: '2026-05-01T00:00:02.000Z' });
      return cloneRow(row);
    });
  });

  it('defines one deterministic seed for every built-in system instruction ref', () => {
    const builtInRefs = [
      ...new Set(Object.values(SYSTEM_AGENT_DEFINITIONS).flatMap((definition) => definition.instructionRefs)),
    ].sort();
    const debugDefinition = SYSTEM_INSTRUCTION_TEMPLATE_DEFINITIONS.find(
      (definition) => definition.ref === 'system:debug'
    );
    const developDefinition = SYSTEM_INSTRUCTION_TEMPLATE_DEFINITIONS.find(
      (definition) => definition.ref === 'system:develop'
    );
    const freeformDefinition = SYSTEM_INSTRUCTION_TEMPLATE_DEFINITIONS.find(
      (definition) => definition.ref === 'system:freeform'
    );

    expect([...SYSTEM_INSTRUCTION_TEMPLATE_REFS].sort()).toEqual(builtInRefs);
    expect(SYSTEM_INSTRUCTION_TEMPLATE_DEFINITIONS).toHaveLength(3);
    expect(debugDefinition?.defaultVersion).toBe(12);
    expect(developDefinition?.defaultVersion).toBe(1);
    expect(freeformDefinition?.defaultVersion).toBe(1);

    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('You are the Lifecycle Debug Agent'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('comparing desired vs actual'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('Investigation order:'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('Failure playbooks'));
    expect(debugDefinition?.defaultContent).toEqual(
      expect.stringContaining('Triage evidence (collected automatically)')
    );
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('get_build_logs'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('search="<regex>"'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('previous:true'));
    expect(debugDefinition?.defaultContent).toEqual(
      expect.stringContaining("approving signed-in user's GitHub authorization")
    );
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('Cite the specific evidence'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('Repair'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('Investigate more'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('start one'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('Evidence you already have:'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('Response contract:'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('trigger_redeploy'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('Pick the tool by the fix'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('include the plain URL'));
    expect(debugDefinition?.defaultContent).toEqual(
      expect.stringContaining('never runs tests or arbitrary workspace commands')
    );
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('previous issue was fixed'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('never say you will keep monitoring'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('One successful mutation per repair run'));
    expect(debugDefinition?.defaultContent).toEqual(expect.stringContaining('publicUrl unreachable'));

    for (const definition of SYSTEM_INSTRUCTION_TEMPLATE_DEFINITIONS) {
      expect(definition.defaultVersion).toBeGreaterThanOrEqual(1);
      expect(definition.defaultContent.trim()).toBe(definition.defaultContent);
      expect(definition.defaultContent).not.toBe('');
      expect(computeInstructionTemplateContentHash(definition.defaultContent)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('seeds release-owned defaults and lists default-effective templates', async () => {
    await InstructionTemplateService.seedSystemTemplates();

    expect(mockUpsert).toHaveBeenCalledTimes(3);

    const templates = await InstructionTemplateService.listTemplates();
    expect(templates.map((template) => template.ref)).toEqual(['system:debug', 'system:develop', 'system:freeform']);
    expect(templates[0]).toEqual(
      expect.objectContaining({
        ref: 'system:debug',
        override: null,
        effective: expect.objectContaining({
          source: 'default',
          content: SYSTEM_INSTRUCTION_TEMPLATE_DEFINITIONS[0].defaultContent,
          hash: computeInstructionTemplateContentHash(SYSTEM_INSTRUCTION_TEMPLATE_DEFINITIONS[0].defaultContent),
        }),
      })
    );
  });

  it('updates overrides with base default metadata and increments override versions', async () => {
    await InstructionTemplateService.seedSystemTemplates();

    const first = await InstructionTemplateService.updateOverride('system:debug', {
      content: 'Use the sample admin debug instructions.',
      updatedBy: 'sample-admin',
    });

    expect(first.override).toEqual(
      expect.objectContaining({
        content: 'Use the sample admin debug instructions.',
        version: 1,
        hash: computeInstructionTemplateContentHash('Use the sample admin debug instructions.'),
        baseDefaultVersion: first.default.version,
        baseDefaultHash: first.default.hash,
        updatedBy: 'sample-admin',
      })
    );
    expect(first.effective).toEqual(
      expect.objectContaining({
        source: 'override',
        version: 1,
        content: 'Use the sample admin debug instructions.',
      })
    );

    const second = await InstructionTemplateService.updateOverride('system:debug', {
      content: 'Use the revised sample admin debug instructions.',
      updatedBy: 'sample-admin',
    });

    expect(second.override).toEqual(
      expect.objectContaining({
        version: 2,
        baseDefaultVersion: first.default.version,
        baseDefaultHash: first.default.hash,
      })
    );
  });

  it('reseeds changed release defaults without overwriting admin overrides', async () => {
    await InstructionTemplateService.seedSystemTemplates();
    const initialTemplate = await InstructionTemplateService.getTemplate('system:debug');
    await InstructionTemplateService.updateOverride('system:debug', {
      content: 'Keep this sample admin override.',
      updatedBy: 'sample-admin',
    });

    const updatedDefault = 'Use updated release-owned sample debug instructions.';
    const updatedDefaultVersion = initialTemplate.default.version + 1;
    await InstructionTemplateService.seedSystemTemplates(
      releaseUpdate('system:debug', updatedDefault, updatedDefaultVersion)
    );

    const template = await InstructionTemplateService.getTemplate('system:debug');
    expect(template.default).toEqual(
      expect.objectContaining({
        content: updatedDefault,
        version: updatedDefaultVersion,
        hash: computeInstructionTemplateContentHash(updatedDefault),
      })
    );
    expect(template.override).toEqual(
      expect.objectContaining({
        content: 'Keep this sample admin override.',
        baseDefaultVersion: initialTemplate.default.version,
      })
    );
    expect(template.effective).toEqual(
      expect.objectContaining({
        source: 'override',
        content: 'Keep this sample admin override.',
      })
    );
  });

  it('reset clears override fields and returns effective content to the current default', async () => {
    await InstructionTemplateService.seedSystemTemplates();
    const initialTemplate = await InstructionTemplateService.getTemplate('system:debug');
    await InstructionTemplateService.updateOverride('system:debug', {
      content: 'Temporary sample override.',
      updatedBy: 'sample-admin',
    });

    const updatedDefault = 'Use reset target sample debug instructions.';
    const updatedDefaultVersion = initialTemplate.default.version + 1;
    await InstructionTemplateService.seedSystemTemplates(
      releaseUpdate('system:debug', updatedDefault, updatedDefaultVersion)
    );

    const reset = await InstructionTemplateService.resetOverride('system:debug');
    expect(reset.override).toBeNull();
    expect(reset.effective).toEqual(
      expect.objectContaining({
        source: 'default',
        version: updatedDefaultVersion,
        content: updatedDefault,
        hash: computeInstructionTemplateContentHash(updatedDefault),
      })
    );
  });

  it('preserves a Debug override across the default migration and reset returns to the current Debug default', async () => {
    const versionOneDebugDefault = 'Use the release-owned sample Debug v1 instructions.';
    const currentDebugDefinition = SYSTEM_INSTRUCTION_TEMPLATE_DEFINITIONS.find(
      (definition) => definition.ref === 'system:debug'
    );
    const debugV2Default = currentDebugDefinition?.defaultContent;
    const debugV2Version = currentDebugDefinition?.defaultVersion;

    await InstructionTemplateService.seedSystemTemplates(releaseUpdate('system:debug', versionOneDebugDefault, 1));
    await InstructionTemplateService.updateOverride('system:debug', {
      content: 'Keep this sample Debug override through migration.',
      updatedBy: 'sample-admin',
    });

    await InstructionTemplateService.seedSystemTemplates();

    const template = await InstructionTemplateService.getTemplate('system:debug');
    expect(template.default).toEqual(
      expect.objectContaining({
        content: debugV2Default,
        version: debugV2Version,
        hash: computeInstructionTemplateContentHash(debugV2Default as string),
      })
    );
    expect(template.override).toEqual(
      expect.objectContaining({
        content: 'Keep this sample Debug override through migration.',
        baseDefaultVersion: 1,
        baseDefaultHash: computeInstructionTemplateContentHash(versionOneDebugDefault),
      })
    );
    expect(template.effective).toEqual(
      expect.objectContaining({
        source: 'override',
        content: 'Keep this sample Debug override through migration.',
      })
    );

    const reset = await InstructionTemplateService.resetOverride('system:debug');
    expect(reset.override).toBeNull();
    expect(reset.effective).toEqual(
      expect.objectContaining({
        source: 'default',
        version: debugV2Version,
        content: debugV2Default,
        hash: computeInstructionTemplateContentHash(debugV2Default as string),
      })
    );
  });

  it('resolves refs in requested order using effective content', async () => {
    await InstructionTemplateService.seedSystemTemplates();
    await InstructionTemplateService.updateOverride('system:develop', {
      content: 'Use the sample develop override.',
      updatedBy: 'sample-admin',
    });

    const resolved = await InstructionTemplateService.resolveRefs(['system:freeform', 'system:develop']);

    expect(mockWhereIn).toHaveBeenCalledWith('ref', ['system:freeform', 'system:develop']);
    expect(resolved).toEqual([
      expect.objectContaining({
        ref: 'system:freeform',
        source: 'default',
        content: expect.stringContaining('general'),
      }),
      expect.objectContaining({
        ref: 'system:develop',
        source: 'override',
        content: 'Use the sample develop override.',
      }),
    ]);
  });

  it('throws typed errors for invalid and unknown refs', async () => {
    await InstructionTemplateService.seedSystemTemplates();

    await expect(InstructionTemplateService.resolveRefs([''])).rejects.toMatchObject({
      name: InstructionTemplateServiceError.name,
      code: 'instruction_template_ref_invalid',
      templateCode: 'invalid_ref',
      httpStatus: 400,
      statusCode: 400,
    });

    await expect(InstructionTemplateService.getTemplate('system:missing')).rejects.toMatchObject({
      name: InstructionTemplateServiceError.name,
      code: 'instruction_template_not_found',
      templateCode: 'unknown_ref',
      httpStatus: 404,
      statusCode: 404,
      details: { ref: 'system:missing' },
    });

    await expect(InstructionTemplateService.resolveRefs(['system:debug', 'system:missing'])).rejects.toMatchObject({
      code: 'instruction_template_not_found',
      templateCode: 'unknown_ref',
      details: { ref: 'system:missing' },
    });
  });
});
