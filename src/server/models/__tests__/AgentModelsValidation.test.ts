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

import AgentMessage from 'server/models/AgentMessage';
import AgentDefinition from 'server/models/AgentDefinition';
import AgentInstructionTemplate from 'server/models/AgentInstructionTemplate';
import AgentRun from 'server/models/AgentRun';
import AgentThread from 'server/models/AgentThread';

describe('Agent model validation', () => {
  test('allows default thread records to validate without an app-supplied uuid', () => {
    expect(() =>
      AgentThread.fromJson({
        sessionId: 42,
        metadata: {},
      })
    ).not.toThrow();
  });

  test('allows canonical messages without a uiMessage projection', () => {
    expect(() =>
      AgentMessage.fromJson({
        threadId: 42,
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
        metadata: {},
      })
    ).not.toThrow();
  });

  test('allows agent runs with a null run plan snapshot', () => {
    expect(() =>
      AgentRun.fromJson({
        threadId: 42,
        sessionId: 7,
        provider: 'sample-provider',
        model: 'sample-model',
        runPlanSnapshot: null,
      })
    ).not.toThrow();
  });

  test('allows agent runs with an object run plan snapshot', () => {
    expect(() =>
      AgentRun.fromJson({
        threadId: 42,
        sessionId: 7,
        provider: 'sample-provider',
        model: 'sample-model',
        runPlanSnapshot: {
          version: 1,
          agent: {
            id: 'system.freeform',
          },
        },
      })
    ).not.toThrow();
  });

  test('allows agent definitions with first-party preset JSON fields', () => {
    expect(() =>
      AgentDefinition.fromJson({
        definitionId: 'system.freeform',
        version: 1,
        ownerKind: 'system',
        name: 'Free-form',
        instructionRefs: ['system:freeform'],
        capabilityRefs: ['read_context'],
        requiredCapabilityRefs: ['read_context'],
        optionalCapabilityRefs: [],
        resourcePolicy: {
          sourceKinds: ['freeform_chat'],
          workspaceRequired: false,
          sandboxRequired: false,
        },
        codeOwned: true,
        readOnly: true,
        status: 'active',
      })
    ).not.toThrow();
  });

  test('allows mutable user agent definitions to transition to archived', () => {
    const userDefinition = {
      definitionId: 'custom.sample-definition',
      version: 1,
      ownerKind: 'user',
      ownerUserId: 'sample-user',
      ownerOrganizationId: null,
      name: 'Sample agent',
      description: null,
      instructionRefs: [],
      instructionAddendum: 'Use a concise response style.',
      capabilityRefs: ['read_context'],
      requiredCapabilityRefs: [],
      optionalCapabilityRefs: ['read_context'],
      resourcePolicy: {
        sourceKinds: ['freeform_chat'],
        workspaceRequired: false,
        sandboxRequired: false,
      },
      modelPreference: null,
      codeOwned: false,
      readOnly: false,
      status: 'active',
    };

    expect(() => AgentDefinition.fromJson(userDefinition)).not.toThrow();
    expect(() => AgentDefinition.fromJson({ ...userDefinition, status: 'archived' })).not.toThrow();
  });

  test('allows instruction templates with release defaults and no override', () => {
    const template = AgentInstructionTemplate.fromJson({
      ref: 'system:freeform',
      name: 'Free-form',
      description: 'Sample template description.',
      defaultContent: 'Use the sample default instructions.',
      defaultVersion: 1,
      defaultHash: 'a'.repeat(64),
    }) as AgentInstructionTemplate;

    expect(AgentInstructionTemplate.timestamps).toBe(true);
    expect(template.effectiveSource).toBe('default');
    expect(template.effectiveVersion).toBe(1);
    expect(template.effectiveHash).toBe('a'.repeat(64));
    expect(template.effectiveContent).toBe('Use the sample default instructions.');
  });

  test('allows instruction templates with admin override metadata', () => {
    const template = AgentInstructionTemplate.fromJson({
      ref: 'system:debug',
      name: 'Debug',
      defaultContent: 'Use the sample default debug instructions.',
      defaultVersion: 2,
      defaultHash: 'b'.repeat(64),
      overrideContent: 'Use the sample admin debug instructions.',
      overrideVersion: 1,
      overrideHash: 'c'.repeat(64),
      overrideBaseDefaultVersion: 2,
      overrideBaseDefaultHash: 'b'.repeat(64),
      overrideUpdatedBy: 'sample-admin',
      overrideUpdatedAt: '2026-05-01T00:00:00.000Z',
    }) as AgentInstructionTemplate;

    expect(template.effectiveSource).toBe('override');
    expect(template.effectiveVersion).toBe(1);
    expect(template.effectiveHash).toBe('c'.repeat(64));
    expect(template.effectiveContent).toBe('Use the sample admin debug instructions.');
  });
});
