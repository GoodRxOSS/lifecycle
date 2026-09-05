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

import swaggerJSDoc from 'swagger-jsdoc';
import { openApiSpecificationForV2Api } from './openApiSpec';
import {
  AGENT_FEEDBACK_REASON_IDS,
  MAX_AGENT_FEEDBACK_REASONS,
  MAX_AGENT_FEEDBACK_TEXT_LENGTH,
} from './types/agentFeedback';

const spec = swaggerJSDoc(openApiSpecificationForV2Api) as any;
const schemas = spec.components.schemas;

describe('canonical agent feedback API contract', () => {
  it.each([
    [
      '/api/v2/ai/agent/threads/{threadId}/feedback',
      'get',
      'getAgentThreadFeedback',
      'AgentFeedbackListSuccessResponse',
    ],
    ['/api/v2/ai/agent/threads/{threadId}/feedback', 'put', 'setAgentThreadFeedback', 'AgentFeedbackSuccessResponse'],
    [
      '/api/v2/ai/agent/threads/{threadId}/feedback',
      'delete',
      'deleteAgentThreadFeedback',
      'DeleteAgentFeedbackSuccessResponse',
    ],
    [
      '/api/v2/ai/agent/threads/{threadId}/messages/{messageId}/feedback',
      'put',
      'setAgentMessageFeedback',
      'AgentFeedbackSuccessResponse',
    ],
    [
      '/api/v2/ai/agent/threads/{threadId}/messages/{messageId}/feedback',
      'delete',
      'deleteAgentMessageFeedback',
      'DeleteAgentFeedbackSuccessResponse',
    ],
    ['/api/v2/ai/admin/agent/feedback', 'get', 'getAdminAgentFeedback', 'GetAdminAgentFeedbackSuccessResponse'],
  ])('documents %s %s with a generated-client response', (path, method, operationId, response) => {
    const operation = spec.paths[path][method];
    expect(operation.operationId).toBe(operationId);
    expect(operation.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/' + response,
    });
    expect(operation.responses['401']).toBeDefined();
    expect(operation.responses['403']).toBeDefined();
  });
  it('shares one strict feedback value schema between owner and administrator surfaces', () => {
    expect(schemas.AgentFeedbackRequest.required).toEqual(['rating']);
    expect(schemas.AgentFeedbackRequest.additionalProperties).toBe(false);
    expect(schemas.AgentFeedbackRequest.properties.text.maxLength).toBe(MAX_AGENT_FEEDBACK_TEXT_LENGTH);
    expect(schemas.AgentFeedback.properties.rating.enum).toEqual(['up', 'down']);
    expect(schemas.AgentFeedback.properties.messageId).toMatchObject({
      type: 'string',
      format: 'uuid',
      nullable: true,
    });
    for (const [key, value] of Object.entries(schemas.AgentFeedback.properties))
      expect(schemas.AgentAdminFeedback.properties[key]).toEqual(value);
    expect(schemas.AgentAdminFeedback.required).toEqual(
      expect.arrayContaining(['sessionId', 'userId', 'threadId', 'messageId'])
    );
  });
  it('publishes structured reason IDs with bounded unique replacement input and required read values', () => {
    expect(schemas.AgentFeedbackReason).toMatchObject({ type: 'string', enum: AGENT_FEEDBACK_REASON_IDS });
    expect(schemas.AgentFeedbackRequest.properties.reasons).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/AgentFeedbackReason' },
      uniqueItems: true,
      maxItems: MAX_AGENT_FEEDBACK_REASONS,
      default: [],
    });
    expect(schemas.AgentFeedbackRequest.required).not.toContain('reasons');
    expect(schemas.AgentFeedback.required).toContain('reasons');
    expect(schemas.AgentAdminFeedback.required).toContain('reasons');
    expect(schemas.AgentFeedbackRequest.properties.reasons.maxItems).toBe(7);
    expect(schemas.AgentFeedbackReason.enum).toEqual([
      'solved_task',
      'clear_explanation',
      'evidence_backed',
      'actionable_steps',
      'other',
      'incorrect_or_incomplete',
      'did_not_follow_instructions',
      'missing_evidence',
      'unhelpful_steps',
      'wrong_context',
      'too_slow',
    ]);
    expect(schemas.AgentFeedbackReason.description).not.toMatch(/deprecated|compatibility/i);
  });
  it('publishes authoritative eligibility and existing inspector feedback without reviving legacy endpoints', () => {
    expect(schemas.AgentThreadFeedback.required).toEqual(['feedback', 'canRateThread', 'eligibleMessageIds']);
    expect(schemas.AgentAdminThreadConversation.required).toContain('feedback');
    expect(schemas.AgentAdminThreadConversation.properties.feedback.items).toEqual({
      $ref: '#/components/schemas/AgentFeedback',
    });
    expect(spec.paths['/api/v2/ai/chat/{buildUuid}/feedback']).toBeUndefined();
    expect(spec.paths['/api/v2/ai/admin/feedback']).toBeUndefined();
  });
  it('defaults to Debug collection with one optional administrator scope setting', () => {
    const policy = schemas.AgentRuntimeConfig.properties.feedbackScope;
    expect(policy).toMatchObject({ type: 'string', enum: ['none', 'debug', 'chat', 'all'], default: 'debug' });
    expect(schemas.AgentRuntimeConfig.required).not.toContain('feedbackScope');
    expect(schemas.AgentRuntimeConfigPatchRequest.properties.feedbackScope).toEqual(policy);
    expect(schemas.AgentRuntimeConfigPatchRequest.maxProperties).toBe(1);
    expect(schemas.AgentRuntimeRepoOverride.properties.feedbackScope).toBeUndefined();
  });
});
