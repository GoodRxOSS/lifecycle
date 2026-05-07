import swaggerJSDoc from 'swagger-jsdoc';
import { openApiSpecificationForV2Api } from './openApiSpec';

const swaggerSpec = swaggerJSDoc(openApiSpecificationForV2Api) as any;
const schemas = swaggerSpec.components.schemas;

function getJsonErrorSchema(path: string, method: string, status: string) {
  return swaggerSpec.paths[path][method].responses[status].content['application/json'].schema;
}

function getOperation(path: string, method: string) {
  return swaggerSpec.paths[path]?.[method];
}

describe('OpenAPI v2 agent session contract', () => {
  it('documents build metadata routes and link schemas', () => {
    expect(getOperation('/api/v2/builds/{uuid}/metadata', 'get')?.tags).toEqual(['Builds']);
    expect(getOperation('/api/v2/config/metadata', 'get')?.tags).toEqual(['Config']);
    expect(getOperation('/api/v2/config/metadata', 'post')?.tags).toEqual(['Config']);
    expect(getOperation('/api/v2/config/metadata/{id}', 'patch')?.tags).toEqual(['Config']);
    expect(getOperation('/api/v2/config/metadata/{id}', 'delete')?.tags).toEqual(['Config']);
    expect(schemas.BuildMetadata.required).toEqual(['links']);
    expect(schemas.BuildMetadataLink.required).toEqual(['id', 'text', 'icon', 'link', 'position']);
    expect(schemas.BuildMetadataLinkCreateRequest.additionalProperties).toBe(false);
    expect(schemas.BuildMetadataLinkPatchRequest.additionalProperties).toBe(false);
  });

  it('documents build config and service override routes', () => {
    expect(getOperation('/api/v2/builds/{uuid}/services/{name}/override', 'patch')).toBeUndefined();
    expect(getOperation('/api/v2/builds/{uuid}/services/overrides', 'patch')).toBeUndefined();
    expect(getOperation('/api/v2/builds/{uuid}/environment-overrides', 'patch')).toBeUndefined();
    expect(getOperation('/api/v2/builds/{uuid}/options', 'patch')).toBeUndefined();
    expect(getOperation('/api/v2/builds/{uuid}', 'patch')?.tags).toEqual(['Builds']);
    expect(getOperation('/api/v2/builds/{uuid}/services', 'patch')?.tags).toEqual(['Builds']);
    expect(schemas.UpdateBuildConfigSuccessResponse.allOf[1].properties.data).toEqual({
      $ref: '#/components/schemas/Build',
    });
    expect(schemas.Build.properties.commentRuntimeEnv).toEqual(
      expect.objectContaining({
        type: 'object',
        additionalProperties: true,
      })
    );
    expect(schemas.Build.properties.commentInitEnv).toEqual(
      expect.objectContaining({
        type: 'object',
        additionalProperties: true,
      })
    );
    expect(schemas.UpdateBuildServiceOverrideRequest).toBeUndefined();
    expect(schemas.UpdateBuildEnvironmentOverridesRequest).toBeUndefined();
    expect(schemas.UpdateBuildOptionsRequest).toBeUndefined();
    expect(schemas.UpdateBuildConfigPatchRequest.additionalProperties).toBe(false);
    expect(schemas.UpdateBuildConfigPatchRequest.anyOf).toEqual([
      { required: ['uuid'] },
      { required: ['isStatic'] },
      { required: ['trackDefaultBranches'] },
      { required: ['commentRuntimeEnv'] },
      { required: ['commentInitEnv'] },
    ]);
    expect(schemas.BuildServiceOverridePatch.required).toEqual(['serviceName']);
    expect(schemas.BuildServiceOverridePatch.additionalProperties).toBe(true);
    expect(schemas.UpdateBuildServiceOverridesRequest.required).toEqual(['serviceOverrides']);
    expect(schemas.UpdateBuildServiceOverridesRequest.properties.serviceOverrides.minItems).toBe(1);
    expect(schemas.UpdateBuildServiceOverridesRequest.additionalProperties).toBe(true);
    expect(schemas.BuildOverrideUpdateResult.required).toEqual(['status', 'buildUuid', 'queued']);
  });

  it('documents build webhooks with the implemented invoke method', () => {
    expect(getOperation('/api/v2/builds/{uuid}/webhooks', 'put')?.tags).toEqual(['Builds']);
    expect(getOperation('/api/v2/builds/{uuid}/webhooks', 'post')).toBeUndefined();
  });

  it('documents canonical run events with public context and a version', () => {
    const eventSchema = schemas.AgentRunMessagePartEvent;

    expect(eventSchema.required).toEqual(
      expect.arrayContaining(['id', 'runId', 'threadId', 'sessionId', 'sequence', 'eventType', 'version', 'payload'])
    );
    expect(eventSchema.properties.threadId).toEqual({ type: 'string', description: 'Public thread UUID.' });
    expect(eventSchema.properties.sessionId).toEqual({ type: 'string', description: 'Public session UUID.' });
    expect(eventSchema.properties.version).toEqual({ type: 'integer', enum: [1] });
  });

  it('uses one canonical file-change artifact for run events and pending actions', () => {
    expect(schemas.AgentFileChangeData.required).toEqual(
      expect.arrayContaining(['id', 'toolCallId', 'sourceTool', 'path', 'displayPath', 'kind', 'stage'])
    );
    expect(schemas.AgentFileChangeData.properties.kind.enum).toEqual(['created', 'edited', 'deleted']);
    expect(schemas.AgentFileChangeData.properties.stage.enum).toEqual([
      'awaiting-approval',
      'approved',
      'applied',
      'denied',
      'failed',
    ]);
    expect(schemas.AgentRunToolFileChangeEvent.properties.payload.oneOf[0].properties.data).toEqual({
      $ref: '#/components/schemas/AgentFileChangeData',
    });
    expect(schemas.AgentPendingAction.properties.fileChangePreview.items).toEqual({
      $ref: '#/components/schemas/AgentFileChangeData',
    });
  });

  it('keeps canonical reference message parts aligned with runtime validation', () => {
    const messagePartSchema = schemas.CanonicalAgentMessagePart;
    const fileRefSchema = messagePartSchema.oneOf.find((entry: any) => entry.properties.type.enum[0] === 'file_ref');
    const sourceRefSchema = messagePartSchema.oneOf.find(
      (entry: any) => entry.properties.type.enum[0] === 'source_ref'
    );

    expect(fileRefSchema.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: ['path'], properties: { path: { type: 'string', minLength: 1 } } }),
        expect.objectContaining({ required: ['url'], properties: { url: { type: 'string', minLength: 1 } } }),
      ])
    );
    expect(sourceRefSchema.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: ['url'], properties: { url: { type: 'string', minLength: 1 } } }),
        expect.objectContaining({ required: ['title'], properties: { title: { type: 'string', minLength: 1 } } }),
      ])
    );
  });

  it('documents the public run-plan summary without internal snapshot fields', () => {
    expect(schemas.AgentRunPlanSummary.required).toEqual(
      expect.arrayContaining(['runtime', 'approval', 'capabilities'])
    );
    expect(schemas.AgentRunPlanRuntimeSummary).toBeDefined();
    expect(schemas.AgentRunPlanApprovalSummary).toBeDefined();
    expect(schemas.AgentRunPlanCapabilitySummary).toBeDefined();
    expect(schemas.AgentRunPlanCapabilitiesSummary).toBeDefined();
    expect(schemas.AgentRunPlanSelectedRuntimeChoicesSummary).toBeDefined();
    expect(schemas.AgentRunPlanSummary.properties.runtime).toEqual({
      $ref: '#/components/schemas/AgentRunPlanRuntimeSummary',
    });
    expect(schemas.AgentRunPlanSummary.properties.approval).toEqual({
      $ref: '#/components/schemas/AgentRunPlanApprovalSummary',
    });
    expect(schemas.AgentRunPlanSummary.properties.capabilities).toEqual({
      $ref: '#/components/schemas/AgentRunPlanCapabilitiesSummary',
    });

    const runPlanSchemas = JSON.stringify({
      AgentRunPlanSummary: schemas.AgentRunPlanSummary,
      AgentRunPlanRuntimeSummary: schemas.AgentRunPlanRuntimeSummary,
      AgentRunPlanApprovalSummary: schemas.AgentRunPlanApprovalSummary,
      AgentRunPlanCapabilitySummary: schemas.AgentRunPlanCapabilitySummary,
      AgentRunPlanCapabilitiesSummary: schemas.AgentRunPlanCapabilitiesSummary,
      AgentRunPlanSelectedRuntimeChoicesSummary: schemas.AgentRunPlanSelectedRuntimeChoicesSummary,
    });

    for (const forbidden of [
      'renderedHash',
      'renderedSummary',
      `selectedRuntime${'Mcp'}ConnectionRefs`,
      'runtimeCapabilityKey',
      'approvalPolicy',
    ]) {
      expect(runPlanSchemas).not.toContain(forbidden);
    }
  });

  it('uses unified agent platform tags for user-facing agent routes', () => {
    for (const [path, method] of [
      ['/api/v2/ai/agent/definitions', 'get'],
      ['/api/v2/ai/agent/definitions', 'post'],
      ['/api/v2/ai/agent/definitions/{definitionId}', 'get'],
      ['/api/v2/ai/agent/definitions/{definitionId}', 'patch'],
      ['/api/v2/ai/agent/definitions/{definitionId}', 'delete'],
      ['/api/v2/ai/agent/definition-capabilities', 'get'],
      ['/api/v2/ai/agent/threads/{threadId}/agent', 'get'],
      ['/api/v2/ai/agent/threads/{threadId}/agent', 'patch'],
      ['/api/v2/ai/agent/threads/{threadId}/runtime-controls', 'get'],
      ['/api/v2/ai/agent/threads/{threadId}/runtime-controls', 'patch'],
      ['/api/v2/ai/agent/runtime-controls/preview', 'post'],
      ['/api/v2/ai/agent/sessions', 'post'],
      ['/api/v2/ai/agent/threads/{threadId}/runs', 'post'],
      ['/api/v2/ai/agent/runs/{runId}', 'get'],
    ]) {
      expect(getOperation(path, method)?.tags).toEqual(['Agent Platform']);
    }
  });

  it('keeps create-run and run-detail schemas aligned to public run-plan contracts', () => {
    expect(getOperation('/api/v2/ai/agent/threads/{threadId}/runs', 'post')?.description).toContain(
      "resolves its run plan server-side from the thread's selected agent"
    );
    expect(Object.keys(schemas.CreateAgentThreadRunRequest.properties).sort()).toEqual([
      'message',
      'model',
      'runtimeOptions',
    ]);
    expect(schemas.CreateAgentThreadRunRequest.additionalProperties).toBe(false);
    expect(schemas.AgentRun.properties.runPlan).toEqual({
      $ref: '#/components/schemas/AgentRunPlanSummary',
    });
  });

  it('documents exact thread usage without raw provider internals', () => {
    expect(getOperation('/api/v2/ai/agent/threads/{threadId}/usage', 'get')?.tags).toEqual(['Agent Platform']);
    expect(schemas.AgentUsageSummary.required).toEqual(['totalTokens']);
    expect(Object.keys(schemas.AgentUsageSummary.properties).sort()).toEqual([
      'cacheCreationInputTokens',
      'cacheReadInputTokens',
      'cachedInputTokens',
      'inputTokens',
      'nonCachedInputTokens',
      'outputTokens',
      'reasoningTokens',
      'textOutputTokens',
      'totalTokens',
    ]);
    expect(schemas.AgentUsageByModel.required).toEqual([
      'provider',
      'model',
      'totalTokens',
      'runCount',
      'reportedRunCount',
      'missingUsageRunCount',
    ]);
    expect(schemas.AgentUsageAggregate.required).toEqual(['usageSummary', 'usageByModel', 'usageCompleteness']);
    expect(schemas.AgentThreadUsageResponse.required).toEqual([
      'threadId',
      'sessionId',
      'usageSummary',
      'usageByModel',
      'usageCompleteness',
    ]);
    expect(getJsonErrorSchema('/api/v2/ai/agent/threads/{threadId}/usage', 'get', '404')).toEqual({
      $ref: '#/components/schemas/ApiErrorResponse',
    });

    const usageSchemas = JSON.stringify({
      AgentUsageSummary: schemas.AgentUsageSummary,
      AgentUsageByModel: schemas.AgentUsageByModel,
      AgentUsageCompleteness: schemas.AgentUsageCompleteness,
      AgentUsageAggregate: schemas.AgentUsageAggregate,
      AgentThreadUsageResponse: schemas.AgentThreadUsageResponse,
    });
    expect(usageSchemas).not.toContain('rawUsage');
    expect(usageSchemas).not.toContain('providerMetadata');
  });

  it('documents session summaries with lifetime usage', () => {
    expect(schemas.AgentSessionSummary.required).toEqual(['session', 'source', 'sandbox', 'usage']);
    expect(schemas.AgentSessionSummary.properties.usage).toEqual({
      $ref: '#/components/schemas/AgentUsageAggregate',
    });
  });

  it('keeps admin capability policy docs admin-scoped and payload-compatible', () => {
    const adminPath = '/api/v2/ai/admin/agent/capabilities';

    expect(getOperation(adminPath, 'get')?.tags).toEqual(['Agent Admin']);
    expect(getOperation(adminPath, 'put')?.tags).toEqual(['Agent Admin']);
    expect(getOperation(adminPath, 'get')?.summary).toBe('Get agent capability policy inventory');
    expect(getOperation(adminPath, 'put')?.summary).toBe('Update agent capability policy');
    expect(schemas.UpdateAdminAgentCapabilitiesRequest.required).toEqual(['capabilityPolicy']);
    expect(schemas.AgentCapabilityInventoryEntry.required).toContain('resourceGrants');
    expect(schemas.AgentCapabilityInventoryEntry.properties.resourceGrants).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('documents custom-agent creation policy as an admin-only management contract', () => {
    const adminPath = '/api/v2/ai/admin/agent/creation-policy';

    expect(getOperation(adminPath, 'get')?.tags).toEqual(['Agent Admin']);
    expect(getOperation(adminPath, 'put')?.tags).toEqual(['Agent Admin']);
    expect(getOperation(adminPath, 'get')?.summary).toBe('Get custom-agent creation policy');
    expect(getOperation(adminPath, 'put')?.summary).toBe('Update custom-agent creation policy');
    expect(schemas.UpdateAdminCustomAgentCreationPolicyRequest.required).toEqual(['customAgentCreationPolicy']);
    expect(schemas.CustomAgentCreationPolicy.properties.mode).toEqual({
      $ref: '#/components/schemas/CustomAgentCreationMode',
    });
    expect(schemas.CreatorCapabilityAvailability.enum).toEqual(['available', 'reserved']);
    expect(schemas.AgentRuntimeConfig.properties.customAgentCreationPolicy).toEqual({
      $ref: '#/components/schemas/CustomAgentCreationPolicy',
    });
  });

  it('documents user custom-agent creator eligibility on the public capabilities contract', () => {
    expect(schemas.UserAgentDefinitionCapabilitiesResponse.required).toEqual([
      'resourceBehavior',
      'canCreate',
      'creationUnavailableReason',
      'capabilities',
    ]);
    expect(schemas.UserAgentDefinitionCapabilitiesResponse.properties.canCreate).toEqual({ type: 'boolean' });
    expect(schemas.UserAgentDefinitionCapabilitiesResponse.properties.creationUnavailableReason).toEqual({
      $ref: '#/components/schemas/CustomAgentCreationUnavailableReason',
    });
    expect(schemas.CustomAgentCreationUnavailableReason.enum).toEqual([
      'creation_disabled',
      'creation_restricted',
      null,
    ]);
    expect(schemas.CustomAgentCreationUnavailableReason.nullable).toBe(true);
  });

  it('documents custom-agent create and update policy denials as safe JSON 403 responses', () => {
    expect(getJsonErrorSchema('/api/v2/ai/agent/definitions', 'post', '403')).toEqual({
      $ref: '#/components/schemas/ApiErrorResponse',
    });
    expect(getJsonErrorSchema('/api/v2/ai/agent/definitions/{definitionId}', 'patch', '403')).toEqual({
      $ref: '#/components/schemas/ApiErrorResponse',
    });
  });

  it('removes migration bridges without preserving UI-shaped success contracts', () => {
    expect(swaggerSpec.paths['/api/v2/ai/agent/threads/{threadId}/conversation']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/agent/threads/{threadId}/preset']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/agent/runs/{runId}/stream']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/agent/pending-actions/{actionId}/approve']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/agent/pending-actions/{actionId}/deny']).toBeUndefined();
    expect(schemas.AgentUIMessage).toBeUndefined();
    expect(schemas.AgentUIMessagePart).toBeUndefined();
    expect(schemas.AgentUIMessageMetadata).toBeUndefined();
    expect(schemas.AgentThreadPresetState).toBeUndefined();
    expect(schemas.SwitchAgentThreadPresetRequest).toBeUndefined();
  });

  it('does not advertise legacy AI chat execution, history, session, or model contracts', () => {
    expect(swaggerSpec.paths['/api/v2/ai/chat/{buildUuid}']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/chat/{buildUuid}/messages']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/chat/{buildUuid}/session']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/chat/{buildUuid}/feedback']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/chat/{buildUuid}/messages/{messageId}/feedback']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/models']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/admin/feedback']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/admin/feedback/{id}/conversation']).toBeUndefined();
    expect(schemas.AIModel).toBeUndefined();
    expect(schemas.GetAIModelsSuccessResponse).toBeUndefined();
    expect(schemas.ConversationMessage).toBeUndefined();
    expect(schemas.ActivityHistoryEntry).toBeUndefined();
    expect(schemas.DebugContext).toBeUndefined();
    expect(schemas.DebugToolData).toBeUndefined();
    expect(schemas.DebugMetrics).toBeUndefined();
    expect(schemas.GetAIMessagesSuccessResponse).toBeUndefined();
    expect(schemas.DeleteAISessionSuccessResponse).toBeUndefined();
    expect(schemas.SSEChunkEvent).toBeUndefined();
    expect(schemas.SSEErrorEvent).toBeUndefined();
    expect(schemas.FeedbackEntry).toBeUndefined();
    expect(schemas.FeedbackListPaginationMetadata).toBeUndefined();
    expect(schemas.FeedbackListResponseMetadata).toBeUndefined();
    expect(schemas.GetAdminFeedbackListSuccessResponse).toBeUndefined();
    expect(schemas.ConversationReplayMessage).toBeUndefined();
    expect(schemas.FeedbackConversationReplayData).toBeUndefined();
    expect(schemas.GetAdminFeedbackConversationSuccessResponse).toBeUndefined();
  });

  it('keeps replacement build-context chat, agent model, and runtime config contracts', () => {
    expect(swaggerSpec.paths['/api/v2/ai/agent/build-context-chats']?.post).toBeDefined();
    expect(swaggerSpec.paths['/api/v2/ai/agent/models']?.get).toBeDefined();
    expect(swaggerSpec.paths['/api/v2/ai/config']?.get).toBeDefined();
    expect(swaggerSpec.paths['/api/v2/ai/agent/runtime-config']?.get).toBeDefined();
    expect(swaggerSpec.paths['/api/v2/ai/agent/runtime-config/repos']?.get).toBeDefined();
    expect(swaggerSpec.paths['/api/v2/ai/agent/runtime-config/repos/{owner}/{repo}']?.put).toBeDefined();
    expect(swaggerSpec.paths['/api/v2/ai/agent-config']).toBeUndefined();
    expect(swaggerSpec.paths['/api/v2/ai/agent-config/repos']).toBeUndefined();
    expect(schemas.BuildContextAgentChatResponse).toBeDefined();
    expect(schemas.AgentModel).toBeDefined();
    expect(schemas.AIConfigStatus).toBeDefined();
    expect(schemas.GetAIConfigSuccessResponse).toBeDefined();
    expect(schemas.AgentRuntimeConfig).toBeDefined();
    expect(schemas.AgentRuntimeRepoOverride).toBeDefined();
  });

  it('documents JSON error responses for changed canonical endpoints', () => {
    expect(getJsonErrorSchema('/api/v2/ai/agent/threads/{threadId}/messages', 'get', '400')).toEqual({
      $ref: '#/components/schemas/ApiErrorResponse',
    });
    expect(getJsonErrorSchema('/api/v2/ai/agent/runs/{runId}/events/stream', 'get', '400')).toEqual({
      $ref: '#/components/schemas/ApiErrorResponse',
    });
    expect(getJsonErrorSchema('/api/v2/ai/config/agent-session', 'get', '401')).toEqual({
      $ref: '#/components/schemas/ApiErrorResponse',
    });
    expect(getJsonErrorSchema('/api/v2/ai/config/agent-session/runtime', 'put', '401')).toEqual({
      $ref: '#/components/schemas/ApiErrorResponse',
    });
  });
});
