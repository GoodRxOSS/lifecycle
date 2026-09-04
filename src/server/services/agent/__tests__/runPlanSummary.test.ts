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

import { serializeRunPlanSummary } from '../runPlanSummary';

const validSnapshot = {
  version: 1,
  agent: {
    id: 'system.freeform',
    label: 'Free-form',
    sourceKind: 'freeform_chat',
  },
  source: {
    repoFullName: 'example-org/example-repo',
    branch: 'main',
    buildUuid: null,
    namespace: 'sample-namespace',
  },
  model: {
    resolvedProvider: 'openai',
    resolvedModel: 'gpt-5.4',
  },
  runtime: {
    resolvedHarness: 'lifecycle_ai_sdk',
    approvalPolicy: { defaultMode: 'require_approval' },
    runtimeOptions: { maxIterations: 12 },
  },
  capabilities: {
    provisionalCapabilityIds: ['read_context'],
    resolvedCapabilityAccess: [
      {
        capabilityId: 'read_context',
        availability: 'all_users',
        allowed: true,
        approvalMode: 'allow',
      },
    ],
    selectedRuntimeCapabilityIds: ['read_context'],
    selectedRuntimeToolChoiceIds: ['choice-read-context'],
    selectedRuntimeMcpChoiceIds: [],
  },
  profile: {
    kind: 'answer',
    intent: 'chat',
    workspaceCore: 'absent',
  },
  warnings: [{ code: 'sample_warning', message: 'Sample warning' }],
};

function cloneSnapshot(): any {
  return JSON.parse(JSON.stringify(validSnapshot));
}

describe('serializeRunPlanSummary', () => {
  it('returns the stable public summary for a valid persisted snapshot', () => {
    expect(serializeRunPlanSummary(validSnapshot)).toEqual({
      version: 1,
      agent: {
        id: 'system.freeform',
        label: 'Free-form',
        sourceKind: 'freeform_chat',
      },
      source: {
        kind: 'freeform_chat',
        repoFullName: 'example-org/example-repo',
        branch: 'main',
        buildUuid: null,
        namespace: 'sample-namespace',
      },
      model: { provider: 'openai', model: 'gpt-5.4' },
      runtime: { harness: 'lifecycle_ai_sdk', maxIterations: 12 },
      approval: { defaultMode: 'require_approval' },
      capabilities: {
        effective: [
          {
            capabilityId: 'read_context',
            availability: 'all_users',
            allowed: true,
            approvalMode: 'allow',
          },
        ],
        selected: {
          capabilityIds: ['read_context'],
          toolChoiceIds: ['choice-read-context'],
          mcpChoiceIds: [],
        },
      },
      profile: { kind: 'answer', intent: 'chat', workspaceCore: 'absent' },
      warnings: [{ code: 'sample_warning', message: 'Sample warning' }],
    });
  });

  it('fails closed when the versioned record lacks required structural sections', () => {
    expect(serializeRunPlanSummary(null)).toBeNull();
    expect(serializeRunPlanSummary({ version: 1 })).toBeNull();
  });

  it('fails closed for an unsupported source kind or approval mode', () => {
    const invalidSource = cloneSnapshot();
    invalidSource.agent.sourceKind = 'scheduled_job';
    expect(serializeRunPlanSummary(invalidSource)).toBeNull();

    const invalidApproval = cloneSnapshot();
    invalidApproval.runtime.approvalPolicy.defaultMode = 'prompt_later';
    expect(serializeRunPlanSummary(invalidApproval)).toBeNull();
  });

  it('fails closed when effective capability entries are not records or violate their contract', () => {
    const nonArrayCapabilities = cloneSnapshot();
    nonArrayCapabilities.capabilities.resolvedCapabilityAccess = null;
    expect(serializeRunPlanSummary(nonArrayCapabilities)).toBeNull();

    const nonRecordCapability = cloneSnapshot();
    nonRecordCapability.capabilities.resolvedCapabilityAccess = [null];
    expect(serializeRunPlanSummary(nonRecordCapability)).toBeNull();

    const invalidCapability = cloneSnapshot();
    invalidCapability.capabilities.resolvedCapabilityAccess = [
      {
        capabilityId: 'read_context',
        availability: 'all_users',
        allowed: 'yes',
      },
    ];
    expect(serializeRunPlanSummary(invalidCapability)).toBeNull();
  });

  it('derives the profile when a persisted profile is malformed', () => {
    const snapshot = cloneSnapshot();
    snapshot.profile = {
      kind: 'unsupported',
      intent: 'chat',
      workspaceCore: 'absent',
    };

    expect(serializeRunPlanSummary(snapshot)?.profile).toEqual({
      kind: 'answer',
      intent: 'chat',
      workspaceCore: 'absent',
    });

    snapshot.profile = 'malformed';
    expect(serializeRunPlanSummary(snapshot)?.profile).toEqual({
      kind: 'answer',
      intent: 'chat',
      workspaceCore: 'absent',
    });
  });

  it('omits an invalid persisted debug intent from the public summary', () => {
    const snapshot = cloneSnapshot();
    snapshot.debug = { resolvedIntent: 'skip_validation' };

    expect(serializeRunPlanSummary(snapshot)).not.toHaveProperty('debug');
  });
});
