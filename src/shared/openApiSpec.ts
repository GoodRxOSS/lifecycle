import { OAS3Options } from 'swagger-jsdoc';
import {
  AgentChatStatus,
  AgentSessionKind,
  AgentWorkspaceStatus,
  BuildKind,
  BuildStatus,
  DeployStatus,
  DeployTypes,
} from './constants';

const agentRunEventBaseProperties = {
  id: { type: 'string' },
  runId: { type: 'string', description: 'Public run UUID.' },
  threadId: { type: 'string', description: 'Public thread UUID.' },
  sessionId: { type: 'string', description: 'Public session UUID.' },
  sequence: { type: 'integer' },
  version: { type: 'integer', enum: [1] },
  createdAt: { type: 'string', format: 'date-time', nullable: true },
  updatedAt: { type: 'string', format: 'date-time', nullable: true },
};

const agentRunEventRequired = [
  'id',
  'runId',
  'threadId',
  'sessionId',
  'sequence',
  'eventType',
  'version',
  'payload',
  'createdAt',
  'updatedAt',
];

function agentRunEventSchema(eventTypes: string[], payload: Record<string, unknown>) {
  return {
    type: 'object',
    properties: {
      ...agentRunEventBaseProperties,
      eventType: { type: 'string', enum: eventTypes },
      payload: {
        oneOf: [payload, { $ref: '#/components/schemas/AgentRunTruncatedValue' }],
      },
    },
    required: agentRunEventRequired,
    additionalProperties: false,
  };
}

const agentRunEventDiscriminatorMapping = {
  'message.created': '#/components/schemas/AgentRunMessageCreatedEvent',
  'message.metadata': '#/components/schemas/AgentRunMessageMetadataEvent',
  'message.part.started': '#/components/schemas/AgentRunMessagePartEvent',
  'message.delta': '#/components/schemas/AgentRunMessagePartEvent',
  'message.part.completed': '#/components/schemas/AgentRunMessagePartEvent',
  'message.source': '#/components/schemas/AgentRunMessageSourceEvent',
  'message.file': '#/components/schemas/AgentRunMessageFileEvent',
  'tool.call.input.started': '#/components/schemas/AgentRunToolInputStartedEvent',
  'tool.call.input.delta': '#/components/schemas/AgentRunToolInputDeltaEvent',
  'tool.call.started': '#/components/schemas/AgentRunToolStartedEvent',
  'tool.call.completed': '#/components/schemas/AgentRunToolCompletedEvent',
  'tool.file_change': '#/components/schemas/AgentRunToolFileChangeEvent',
  'approval.requested': '#/components/schemas/AgentRunApprovalRequestedEvent',
  'approval.resolved': '#/components/schemas/AgentRunApprovalResolvedEvent',
  'approval.responded': '#/components/schemas/AgentRunApprovalRespondedEvent',
  'run.queued': '#/components/schemas/AgentRunStatusEvent',
  'run.started': '#/components/schemas/AgentRunStatusEvent',
  'run.waiting_for_approval': '#/components/schemas/AgentRunStatusEvent',
  'run.completed': '#/components/schemas/AgentRunStatusEvent',
  'run.failed': '#/components/schemas/AgentRunStatusEvent',
  'run.cancelled': '#/components/schemas/AgentRunStatusEvent',
  'run.updated': '#/components/schemas/AgentRunStatusEvent',
  'run.step.started': '#/components/schemas/AgentRunStepEvent',
  'run.step.completed': '#/components/schemas/AgentRunStepEvent',
  'run.finished': '#/components/schemas/AgentRunFinishedEvent',
  'run.error': '#/components/schemas/AgentRunErrorEvent',
  'run.aborted': '#/components/schemas/AgentRunAbortedEvent',
};

const agentRunEventPayloadMetadata = {
  type: 'object',
  additionalProperties: true,
};

const agentUsageSummaryProperties = {
  totalTokens: { type: 'number' },
  inputTokens: { type: 'number' },
  outputTokens: { type: 'number' },
  reasoningTokens: { type: 'number' },
  cachedInputTokens: { type: 'number' },
  cacheCreationInputTokens: { type: 'number' },
  cacheReadInputTokens: { type: 'number' },
  nonCachedInputTokens: { type: 'number' },
  textOutputTokens: { type: 'number' },
};

export const openApiSpecificationForV2Api: OAS3Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Lifecycle API',
      version: '2.0.0',
      description: 'API documentation for lifecycle',
    },
    security: [{ BearerAuth: [] }],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'JWT token issued by a Keycloak identity provider. ' +
            'Pass it in the Authorization header as "Bearer <token>". ' +
            'Authentication is only enforced when the ENABLE_AUTH environment variable is set to "true". ' +
            'When disabled, all requests are allowed without a token.',
        },
      },
      schemas: {
        // ===================================================================
        // Core Reusable Schemas
        // ===================================================================

        /**
         * @description Standard schema for all successful API responses.
         * Specific endpoints extend this using `allOf`.
         */
        SuccessApiResponse: {
          type: 'object',
          properties: {
            request_id: { type: 'string', format: 'uuid' },
            metadata: { $ref: '#/components/schemas/ResponseMetadata' },
            error: {
              type: 'null',
              description: 'Always null on successful responses.',
            },
          },
          required: ['request_id', 'error'],
        },

        /**
         * @description Standard schema for all error API responses.
         */
        ApiErrorResponse: {
          type: 'object',
          properties: {
            request_id: { type: 'string', format: 'uuid' },
            data: { type: 'null' },
            error: { $ref: '#/components/schemas/ApiError' },
          },
          required: ['request_id', 'data', 'error'],
        },

        /**
         * @description The standard error object.
         */
        ApiError: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
        },

        /**
         * @description Container for response metadata, including pagination.
         */
        ResponseMetadata: {
          type: 'object',
          properties: {
            pagination: { $ref: '#/components/schemas/PaginationMetadata' },
            limit: { type: 'integer' },
            maxLimit: { type: 'integer' },
          },
        },

        /**
         * @description Standard pagination metadata object.
         */
        PaginationMetadata: {
          type: 'object',
          properties: {
            items: { type: 'integer' },
            total: { type: 'integer' },
            current: { type: 'integer' },
            limit: { type: 'integer' },
          },
          required: ['items', 'total', 'current', 'limit'],
        },

        AgentApiKeyStatus: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: ['anthropic', 'openai', 'gemini'] },
            hasKey: { type: 'boolean' },
            maskedKey: { type: 'string', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: ['provider', 'hasKey'],
        },

        AgentApiKeyStatusResponse: {
          type: 'object',
          properties: {
            hasKey: { type: 'boolean' },
            provider: { type: 'string', enum: ['anthropic', 'openai', 'gemini'] },
            maskedKey: { type: 'string', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
            providers: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentApiKeyStatus' },
            },
          },
          required: ['hasKey', 'provider', 'providers'],
        },

        AgentSettings: {
          type: 'object',
          properties: {
            providers: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentApiKeyStatus' },
            },
            mcpConnections: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentMcpConnection' },
            },
          },
          required: ['providers', 'mcpConnections'],
        },

        RepositorySearchResult: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            githubRepositoryId: { type: 'integer' },
            githubInstallationId: { type: 'integer' },
            ownerId: { type: 'integer', nullable: true },
            fullName: { type: 'string' },
            htmlUrl: { type: 'string', nullable: true },
            defaultEnvId: { type: 'integer', nullable: true },
            onboarded: { type: 'boolean' },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
            deletedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: ['githubRepositoryId', 'fullName', 'onboarded'],
        },

        SearchRepositoriesResponse: {
          type: 'object',
          properties: {
            repositories: {
              type: 'array',
              items: { $ref: '#/components/schemas/RepositorySearchResult' },
            },
          },
          required: ['repositories'],
        },

        SearchRepositoriesSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/SearchRepositoriesResponse' },
              },
              required: ['data'],
            },
          ],
        },

        OnboardRepositoryRequest: {
          type: 'object',
          properties: {
            fullName: {
              type: 'string',
              description: 'GitHub repository full name. GitHub URLs and .git suffixes are accepted.',
              example: 'example-org/example-repo',
            },
            installationId: {
              type: 'integer',
              description: 'Optional GitHub App installation ID. Defaults to GITHUB_APP_INSTALLATION_ID.',
            },
          },
          required: ['fullName'],
        },

        OnboardedRepository: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            githubRepositoryId: { type: 'integer' },
            githubInstallationId: { type: 'integer' },
            ownerId: { type: 'integer', nullable: true },
            fullName: { type: 'string' },
            htmlUrl: { type: 'string', nullable: true },
            defaultEnvId: { type: 'integer', nullable: true },
            onboarded: { type: 'boolean' },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
            deletedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: ['id', 'githubRepositoryId', 'githubInstallationId', 'fullName', 'onboarded'],
        },

        InstalledRepository: {
          type: 'object',
          properties: {
            githubRepositoryId: { type: 'integer' },
            ownerId: { type: 'integer', nullable: true },
            ownerLogin: { type: 'string', nullable: true },
            name: { type: 'string' },
            fullName: { type: 'string' },
            htmlUrl: { type: 'string', nullable: true },
            private: { type: 'boolean', nullable: true },
            archived: { type: 'boolean', nullable: true },
            disabled: { type: 'boolean', nullable: true },
            visibility: { type: 'string', nullable: true },
            defaultBranch: { type: 'string', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
            pushedAt: { type: 'string', format: 'date-time', nullable: true },
            onboarded: { type: 'boolean' },
          },
          required: ['githubRepositoryId', 'name', 'fullName', 'onboarded'],
        },

        ListRepositoriesResponse: {
          type: 'object',
          properties: {
            repositories: {
              type: 'array',
              items: {
                oneOf: [
                  { $ref: '#/components/schemas/OnboardedRepository' },
                  { $ref: '#/components/schemas/InstalledRepository' },
                ],
              },
            },
          },
          required: ['repositories'],
        },

        ListRepositoriesSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/ListRepositoriesResponse' },
              },
              required: ['data'],
            },
          ],
        },

        OnboardRepositoryResponse: {
          type: 'object',
          properties: {
            repository: { $ref: '#/components/schemas/OnboardedRepository' },
            created: { type: 'boolean' },
          },
          required: ['repository', 'created'],
        },

        OnboardRepositorySuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/OnboardRepositoryResponse' },
              },
              required: ['data'],
            },
          ],
        },

        RemoveRepositoryResponse: {
          type: 'object',
          properties: {
            repository: { $ref: '#/components/schemas/OnboardedRepository' },
          },
          required: ['repository'],
        },

        RemoveRepositorySuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/RemoveRepositoryResponse' },
              },
              required: ['data'],
            },
          ],
        },

        AgentModel: {
          type: 'object',
          properties: {
            provider: { type: 'string' },
            modelId: { type: 'string' },
            displayName: { type: 'string' },
            default: { type: 'boolean' },
            maxTokens: { type: 'integer' },
            inputCostPerMillion: { type: 'number', nullable: true },
            outputCostPerMillion: { type: 'number', nullable: true },
          },
          required: ['provider', 'modelId', 'displayName', 'default', 'maxTokens'],
        },

        AgentApprovalMode: {
          type: 'string',
          enum: ['allow', 'require_approval', 'deny'],
        },

        AgentApprovalPolicy: {
          type: 'object',
          properties: {
            defaultMode: { $ref: '#/components/schemas/AgentApprovalMode' },
            rules: {
              type: 'object',
              properties: {
                read: { $ref: '#/components/schemas/AgentApprovalMode' },
                external_mcp_read: { $ref: '#/components/schemas/AgentApprovalMode' },
                workspace_write: { $ref: '#/components/schemas/AgentApprovalMode' },
                shell_exec: { $ref: '#/components/schemas/AgentApprovalMode' },
                git_write: { $ref: '#/components/schemas/AgentApprovalMode' },
                network_access: { $ref: '#/components/schemas/AgentApprovalMode' },
                deploy_k8s_mutation: { $ref: '#/components/schemas/AgentApprovalMode' },
                external_mcp_write: { $ref: '#/components/schemas/AgentApprovalMode' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
          example: {
            maxIterations: 12,
            workspaceToolDiscoveryTimeoutMs: 30000,
            workspaceToolExecutionTimeoutMs: 120000,
            toolRules: [
              {
                toolKey: 'mcp__sandbox__workspace_edit_file',
                mode: 'require_approval',
              },
            ],
          },
        },

        CanonicalAgentMessagePart: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['text'] },
                text: { type: 'string', minLength: 1 },
              },
              required: ['type', 'text'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['reasoning'] },
                text: { type: 'string', minLength: 1 },
              },
              required: ['type', 'text'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['file_ref'] },
                path: { type: 'string', minLength: 1, nullable: true },
                url: { type: 'string', minLength: 1, nullable: true },
                mediaType: { type: 'string', minLength: 1, nullable: true },
                title: { type: 'string', minLength: 1, nullable: true },
              },
              required: ['type'],
              anyOf: [
                {
                  type: 'object',
                  properties: { path: { type: 'string', minLength: 1 } },
                  required: ['path'],
                },
                {
                  type: 'object',
                  properties: { url: { type: 'string', minLength: 1 } },
                  required: ['url'],
                },
              ],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['source_ref'] },
                url: { type: 'string', minLength: 1, nullable: true },
                title: { type: 'string', minLength: 1, nullable: true },
                sourceType: { type: 'string', minLength: 1, nullable: true },
              },
              required: ['type'],
              anyOf: [
                {
                  type: 'object',
                  properties: { url: { type: 'string', minLength: 1 } },
                  required: ['url'],
                },
                {
                  type: 'object',
                  properties: { title: { type: 'string', minLength: 1 } },
                  required: ['title'],
                },
              ],
              additionalProperties: false,
            },
          ],
        },

        AgentMessage: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            clientMessageId: { type: 'string', nullable: true },
            threadId: { type: 'string' },
            runId: { type: 'string', nullable: true },
            role: { type: 'string', enum: ['user', 'assistant', 'system'] },
            parts: {
              type: 'array',
              items: { $ref: '#/components/schemas/CanonicalAgentMessagePart' },
              minItems: 1,
            },
            metadata: {
              oneOf: [{ $ref: '#/components/schemas/AgentSwitchEventMetadata' }, { type: 'object' }],
            },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: ['id', 'clientMessageId', 'threadId', 'runId', 'role', 'parts', 'createdAt'],
          additionalProperties: false,
          example: {
            id: 'message-1',
            clientMessageId: 'client-message-1',
            threadId: 'thread-1',
            runId: 'run-1',
            role: 'user',
            parts: [{ type: 'text', text: 'Check the sample service.' }],
            createdAt: '2026-04-25T00:00:00.000Z',
          },
        },

        SystemAgentDefinitionId: {
          type: 'string',
          enum: ['system.debug', 'system.develop', 'system.freeform'],
        },

        AgentSelectionSummary: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            ownerKind: { type: 'string', enum: ['system', 'admin', 'user'] },
            label: { type: 'string' },
            description: { type: 'string', nullable: true },
            available: { type: 'boolean' },
            unavailableReason: {
              type: 'string',
              nullable: true,
              enum: [
                'unknown_agent',
                'active_run',
                'disabled_agent',
                'requires_workspace',
                'source_incompatible',
                'disabled_by_policy',
                null,
              ],
            },
            unavailableMessage: { type: 'string', nullable: true },
            group: { type: 'string', enum: ['built_in', 'my_agents'] },
          },
          required: [
            'id',
            'ownerKind',
            'label',
            'description',
            'available',
            'unavailableReason',
            'unavailableMessage',
            'group',
          ],
          additionalProperties: false,
        },

        AgentSelectionGroup: {
          type: 'object',
          properties: {
            id: { type: 'string', enum: ['built_in', 'my_agents'] },
            label: { type: 'string' },
            agents: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentSelectionSummary' },
            },
          },
          required: ['id', 'label', 'agents'],
          additionalProperties: false,
        },

        AgentSelectionState: {
          type: 'object',
          properties: {
            selectedId: { type: 'string', nullable: true },
            defaultId: { $ref: '#/components/schemas/SystemAgentDefinitionId' },
            currentId: { type: 'string' },
            groups: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentSelectionGroup' },
              minItems: 2,
            },
          },
          required: ['selectedId', 'defaultId', 'currentId', 'groups'],
          additionalProperties: false,
        },

        SwitchAgentSelectionRequest: {
          type: 'object',
          properties: {
            agentId: { type: 'string' },
          },
          required: ['agentId'],
          additionalProperties: false,
        },

        SwitchAgentSelectionResponse: {
          type: 'object',
          properties: {
            previousAgent: { $ref: '#/components/schemas/AgentSelectionSummary' },
            nextAgent: { $ref: '#/components/schemas/AgentSelectionSummary' },
            switched: { type: 'boolean' },
            state: { $ref: '#/components/schemas/AgentSelectionState' },
          },
          required: ['previousAgent', 'nextAgent', 'switched', 'state'],
          additionalProperties: false,
        },

        AgentThreadRuntimeControlChoice: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string', nullable: true },
            required: { type: 'boolean' },
            selected: { type: 'boolean' },
            available: { type: 'boolean' },
          },
          required: ['id', 'label', 'description', 'required', 'selected', 'available'],
          additionalProperties: false,
        },

        AgentThreadRuntimeControlsState: {
          type: 'object',
          properties: {
            tools: {
              type: 'object',
              properties: {
                required: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AgentThreadRuntimeControlChoice' },
                },
                optional: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AgentThreadRuntimeControlChoice' },
                },
                selectedChoiceIds: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['required', 'optional', 'selectedChoiceIds'],
              additionalProperties: false,
            },
            mcp: {
              type: 'object',
              properties: {
                connections: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AgentThreadRuntimeControlChoice' },
                },
                selectedChoiceIds: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['connections', 'selectedChoiceIds'],
              additionalProperties: false,
            },
            canEdit: { type: 'boolean' },
            disabledReason: { type: 'string', nullable: true },
          },
          required: ['tools', 'mcp', 'canEdit', 'disabledReason'],
          additionalProperties: false,
        },

        AgentThreadRuntimeControlsPatchRequest: {
          type: 'object',
          properties: {
            toolChoiceIds: {
              type: 'array',
              items: { type: 'string' },
            },
            mcpChoiceIds: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          additionalProperties: false,
        },

        AgentRuntimeControlChoicesInput: {
          type: 'object',
          properties: {
            agentId: { type: 'string', nullable: true },
            toolChoiceIds: {
              type: 'array',
              items: { type: 'string' },
            },
            mcpChoiceIds: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          additionalProperties: false,
        },

        AgentRuntimeControlsPreviewRequest: {
          type: 'object',
          properties: {
            agentId: { type: 'string', nullable: true },
            source: {
              type: 'object',
              properties: {
                adapter: { type: 'string' },
                input: {
                  type: 'object',
                  additionalProperties: true,
                },
              },
              additionalProperties: true,
            },
            defaults: {
              type: 'object',
              properties: {
                provider: { type: 'string', nullable: true },
                model: { type: 'string', nullable: true },
              },
              additionalProperties: false,
            },
            runtimeControlChoices: { $ref: '#/components/schemas/AgentRuntimeControlChoicesInput' },
          },
          additionalProperties: false,
        },

        GetAgentThreadRuntimeControlsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/AgentThreadRuntimeControlsState' },
              },
              required: ['data'],
            },
          ],
        },

        PatchAgentThreadRuntimeControlsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/AgentThreadRuntimeControlsState' },
              },
              required: ['data'],
            },
          ],
        },

        AgentRuntimeControlsPreviewSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/AgentThreadRuntimeControlsState' },
              },
              required: ['data'],
            },
          ],
        },

        AgentSwitchEventMetadata: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['agent_switch'] },
            actor: {
              type: 'object',
              properties: {
                userId: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['userId', 'label'],
              additionalProperties: false,
            },
            beforeAgent: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['id', 'label'],
              additionalProperties: false,
            },
            afterAgent: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
              },
              required: ['id', 'label'],
              additionalProperties: false,
            },
            appliesTo: { type: 'string', enum: ['future_runs'] },
            occurredAt: { type: 'string', format: 'date-time' },
          },
          required: ['kind', 'actor', 'beforeAgent', 'afterAgent', 'appliesTo', 'occurredAt'],
          additionalProperties: false,
        },

        UserAgentDefinitionResourceBehavior: {
          type: 'string',
          enum: ['chat_only', 'current_workspace_when_available'],
        },

        UserAgentDefinitionModelPreference: {
          type: 'object',
          nullable: true,
          properties: {
            provider: { type: 'string', nullable: true },
            model: { type: 'string', nullable: true },
          },
          additionalProperties: false,
        },

        UserAgentDefinition: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            version: { type: 'integer', minimum: 1 },
            name: { type: 'string' },
            description: { type: 'string', nullable: true },
            instructions: { type: 'string' },
            capabilityIds: {
              type: 'array',
              items: { type: 'string' },
            },
            modelPreference: { $ref: '#/components/schemas/UserAgentDefinitionModelPreference' },
            resourceBehavior: { $ref: '#/components/schemas/UserAgentDefinitionResourceBehavior' },
            status: { type: 'string', enum: ['active', 'archived'] },
          },
          required: [
            'id',
            'version',
            'name',
            'description',
            'instructions',
            'capabilityIds',
            'modelPreference',
            'resourceBehavior',
            'status',
          ],
          additionalProperties: false,
        },

        UserAgentDefinitionSummary: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            version: { type: 'integer', minimum: 1 },
            name: { type: 'string' },
            description: { type: 'string', nullable: true },
            capabilityIds: {
              type: 'array',
              items: { type: 'string' },
            },
            modelPreference: { $ref: '#/components/schemas/UserAgentDefinitionModelPreference' },
            resourceBehavior: { $ref: '#/components/schemas/UserAgentDefinitionResourceBehavior' },
            status: { type: 'string', enum: ['active', 'archived'] },
          },
          required: [
            'id',
            'version',
            'name',
            'description',
            'capabilityIds',
            'modelPreference',
            'resourceBehavior',
            'status',
          ],
          additionalProperties: false,
        },

        UserAgentDefinitionUpsertRequest: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            description: { type: 'string', nullable: true },
            instructions: { type: 'string', minLength: 1 },
            capabilityIds: {
              type: 'array',
              items: { type: 'string' },
            },
            modelPreference: { $ref: '#/components/schemas/UserAgentDefinitionModelPreference' },
            resourceBehavior: { $ref: '#/components/schemas/UserAgentDefinitionResourceBehavior' },
          },
          required: ['name', 'instructions', 'resourceBehavior'],
          additionalProperties: false,
        },

        UserAgentDefinitionDisplaySummary: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string', nullable: true },
          },
          required: ['name', 'description'],
          additionalProperties: false,
        },

        UserAgentDefinitionCapability: {
          type: 'object',
          properties: {
            capabilityId: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
            category: {
              type: 'string',
              enum: [
                'read',
                'diagnostics',
                'workspace',
                'source_control',
                'mcp',
                'deployment',
                'network',
                'preview',
                'approval',
              ],
            },
            toolCount: { type: 'integer', minimum: 0 },
            resourceCount: { type: 'integer', minimum: 0 },
            requiresWorkspace: { type: 'boolean' },
            tools: {
              type: 'array',
              items: { $ref: '#/components/schemas/UserAgentDefinitionDisplaySummary' },
            },
            resources: {
              type: 'array',
              items: { $ref: '#/components/schemas/UserAgentDefinitionDisplaySummary' },
            },
          },
          required: [
            'capabilityId',
            'label',
            'description',
            'category',
            'toolCount',
            'resourceCount',
            'requiresWorkspace',
            'tools',
            'resources',
          ],
          additionalProperties: false,
        },

        ListUserAgentDefinitionsResponse: {
          type: 'object',
          properties: {
            definitions: {
              type: 'array',
              items: { $ref: '#/components/schemas/UserAgentDefinition' },
            },
          },
          required: ['definitions'],
          additionalProperties: false,
        },

        UserAgentDefinitionResponse: {
          type: 'object',
          properties: {
            definition: { $ref: '#/components/schemas/UserAgentDefinition' },
          },
          required: ['definition'],
          additionalProperties: false,
        },

        DeleteUserAgentDefinitionResponse: {
          type: 'object',
          properties: {
            archived: { type: 'boolean' },
            definition: { $ref: '#/components/schemas/UserAgentDefinition' },
          },
          required: ['archived', 'definition'],
          additionalProperties: false,
        },

        UserAgentDefinitionCapabilitiesResponse: {
          type: 'object',
          properties: {
            resourceBehavior: { $ref: '#/components/schemas/UserAgentDefinitionResourceBehavior' },
            canCreate: { type: 'boolean' },
            creationUnavailableReason: {
              $ref: '#/components/schemas/CustomAgentCreationUnavailableReason',
            },
            capabilities: {
              type: 'array',
              items: { $ref: '#/components/schemas/UserAgentDefinitionCapability' },
            },
          },
          required: ['resourceBehavior', 'canCreate', 'creationUnavailableReason', 'capabilities'],
          additionalProperties: false,
        },

        ListUserAgentDefinitionsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              required: ['data'],
              properties: {
                data: { $ref: '#/components/schemas/ListUserAgentDefinitionsResponse' },
              },
            },
          ],
        },

        UserAgentDefinitionSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              required: ['data'],
              properties: {
                data: { $ref: '#/components/schemas/UserAgentDefinitionResponse' },
              },
            },
          ],
        },

        DeleteUserAgentDefinitionSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              required: ['data'],
              properties: {
                data: { $ref: '#/components/schemas/DeleteUserAgentDefinitionResponse' },
              },
            },
          ],
        },

        UserAgentDefinitionCapabilitiesSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              required: ['data'],
              properties: {
                data: { $ref: '#/components/schemas/UserAgentDefinitionCapabilitiesResponse' },
              },
            },
          ],
        },

        AgentThreadMessagesResponse: {
          type: 'object',
          properties: {
            thread: { $ref: '#/components/schemas/AgentThread' },
            messages: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentMessage' },
            },
            pagination: {
              type: 'object',
              properties: {
                hasMore: { type: 'boolean' },
                nextBeforeMessageId: { type: 'string', nullable: true },
              },
              required: ['hasMore', 'nextBeforeMessageId'],
              additionalProperties: false,
            },
          },
          required: ['thread', 'messages', 'pagination'],
          additionalProperties: false,
        },

        AgentUsageSummary: {
          type: 'object',
          properties: agentUsageSummaryProperties,
          required: ['totalTokens'],
          additionalProperties: false,
        },

        AgentUsageByModel: {
          type: 'object',
          properties: {
            provider: { type: 'string' },
            model: { type: 'string' },
            ...agentUsageSummaryProperties,
            runCount: { type: 'integer' },
            reportedRunCount: { type: 'integer' },
            missingUsageRunCount: { type: 'integer' },
          },
          required: ['provider', 'model', 'totalTokens', 'runCount', 'reportedRunCount', 'missingUsageRunCount'],
          additionalProperties: false,
        },

        AgentUsageCompleteness: {
          type: 'object',
          properties: {
            runCount: { type: 'integer' },
            reportedRunCount: { type: 'integer' },
            missingUsageRunCount: { type: 'integer' },
            complete: { type: 'boolean' },
          },
          required: ['runCount', 'reportedRunCount', 'missingUsageRunCount', 'complete'],
          additionalProperties: false,
        },

        AgentUsageAggregate: {
          type: 'object',
          properties: {
            usageSummary: { $ref: '#/components/schemas/AgentUsageSummary' },
            usageByModel: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentUsageByModel' },
            },
            usageCompleteness: { $ref: '#/components/schemas/AgentUsageCompleteness' },
          },
          required: ['usageSummary', 'usageByModel', 'usageCompleteness'],
          additionalProperties: false,
        },

        AgentThreadUsageResponse: {
          type: 'object',
          properties: {
            threadId: { type: 'string' },
            sessionId: { type: 'string' },
            usageSummary: { $ref: '#/components/schemas/AgentUsageSummary' },
            usageByModel: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentUsageByModel' },
            },
            usageCompleteness: { $ref: '#/components/schemas/AgentUsageCompleteness' },
          },
          required: ['threadId', 'sessionId', 'usageSummary', 'usageByModel', 'usageCompleteness'],
          additionalProperties: false,
        },

        GetAgentThreadUsageSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              required: ['data'],
              properties: {
                data: { $ref: '#/components/schemas/AgentThreadUsageResponse' },
              },
            },
          ],
        },

        AgentRunRuntimeOptions: {
          type: 'object',
          properties: {
            maxIterations: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
            },
          },
          additionalProperties: false,
          example: {
            maxIterations: 12,
          },
        },

        CreateAgentThreadRunMessage: {
          type: 'object',
          properties: {
            clientMessageId: { type: 'string' },
            parts: {
              type: 'array',
              items: { $ref: '#/components/schemas/CanonicalAgentMessagePart' },
              minItems: 1,
            },
          },
          required: ['parts'],
          additionalProperties: false,
        },

        CreateAgentThreadRunRequest: {
          type: 'object',
          properties: {
            message: { $ref: '#/components/schemas/CreateAgentThreadRunMessage' },
            model: {
              type: 'object',
              properties: {
                provider: { type: 'string' },
                id: { type: 'string' },
              },
              additionalProperties: false,
            },
            runtimeOptions: { $ref: '#/components/schemas/AgentRunRuntimeOptions' },
          },
          required: ['message'],
          additionalProperties: false,
          example: {
            message: {
              clientMessageId: 'client-message-1',
              parts: [{ type: 'text', text: 'Check the sample service.' }],
            },
            model: {
              provider: 'openai',
              id: 'gpt-5.2',
            },
            runtimeOptions: {
              maxIterations: 12,
            },
          },
        },

        CreateBuildContextAgentChatRequest: {
          type: 'object',
          properties: {
            buildUuid: { type: 'string' },
            defaults: {
              type: 'object',
              properties: {
                model: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          required: ['buildUuid'],
          additionalProperties: false,
          example: {
            buildUuid: '00000000-0000-0000-0000-000000000000',
            defaults: {
              model: 'gpt-5.4',
            },
          },
        },

        AgentThread: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            sessionId: { type: 'string', nullable: true },
            title: { type: 'string', nullable: true },
            isDefault: { type: 'boolean' },
            archivedAt: { type: 'string', format: 'date-time', nullable: true },
            lastRunAt: { type: 'string', format: 'date-time', nullable: true },
            metadata: { type: 'object', additionalProperties: true },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: ['id', 'isDefault', 'metadata'],
        },

        AgentSessionDefaults: {
          type: 'object',
          properties: {
            provider: { type: 'string', nullable: true },
            model: { type: 'string' },
            harness: { type: 'string', nullable: true },
          },
          required: ['model', 'harness'],
        },

        AgentSource: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            adapter: { type: 'string' },
            status: { type: 'string', enum: ['requested', 'preparing', 'ready', 'failed', 'cleaned_up'] },
            input: { type: 'object', additionalProperties: true },
            sandboxRequirements: { type: 'object', additionalProperties: true },
            error: { type: 'object', additionalProperties: true, nullable: true },
            preparedAt: { type: 'string', format: 'date-time', nullable: true },
            cleanedUpAt: { type: 'string', format: 'date-time', nullable: true },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: ['id', 'adapter', 'status', 'input', 'sandboxRequirements', 'error'],
        },

        AgentSandboxExposure: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string' },
            status: { type: 'string', enum: ['provisioning', 'ready', 'failed', 'ended'] },
            targetPort: { type: 'integer', nullable: true },
            url: { type: 'string', nullable: true },
            metadata: { type: 'object', additionalProperties: true },
            lastVerifiedAt: { type: 'string', format: 'date-time', nullable: true },
            endedAt: { type: 'string', format: 'date-time', nullable: true },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: ['id', 'kind', 'status', 'metadata'],
        },

        AgentSandbox: {
          type: 'object',
          properties: {
            id: { type: 'string', nullable: true },
            generation: { type: 'integer', nullable: true },
            provider: { type: 'string', nullable: true },
            status: {
              type: 'string',
              enum: ['none', 'provisioning', 'ready', 'suspending', 'suspended', 'resuming', 'failed', 'ended'],
            },
            capabilitySnapshot: { type: 'object', additionalProperties: true },
            exposures: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentSandboxExposure' },
            },
            suspendedAt: { type: 'string', format: 'date-time', nullable: true },
            endedAt: { type: 'string', format: 'date-time', nullable: true },
            error: { type: 'object', additionalProperties: true, nullable: true },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: ['id', 'generation', 'provider', 'status', 'capabilitySnapshot', 'exposures', 'error'],
        },

        AgentSessionSummary: {
          type: 'object',
          properties: {
            session: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                status: { type: 'string', enum: ['ready', 'ended', 'error'] },
                userId: { type: 'string' },
                ownerGithubUsername: { type: 'string', nullable: true },
                defaults: { $ref: '#/components/schemas/AgentSessionDefaults' },
                defaultThreadId: { type: 'string', nullable: true },
                lastActivity: { type: 'string', format: 'date-time', nullable: true },
                endedAt: { type: 'string', format: 'date-time', nullable: true },
                createdAt: { type: 'string', format: 'date-time', nullable: true },
                updatedAt: { type: 'string', format: 'date-time', nullable: true },
              },
              required: ['id', 'status', 'userId', 'ownerGithubUsername', 'defaults', 'defaultThreadId'],
            },
            source: { $ref: '#/components/schemas/AgentSource' },
            sandbox: { $ref: '#/components/schemas/AgentSandbox' },
            usage: { $ref: '#/components/schemas/AgentUsageAggregate' },
          },
          required: ['session', 'source', 'sandbox', 'usage'],
        },

        BuildContextAgentChatContext: {
          type: 'object',
          properties: {
            buildUuid: { type: 'string' },
            buildKind: {
              type: 'string',
              enum: Object.values(BuildKind),
              nullable: true,
            },
            namespace: { type: 'string', nullable: true },
            baseBuildUuid: { type: 'string', nullable: true },
            repo: { type: 'string', nullable: true },
            branch: { type: 'string', nullable: true },
            pullRequestNumber: { type: 'integer', nullable: true },
            contextFreshAt: { type: 'string', format: 'date-time' },
          },
          required: [
            'buildUuid',
            'buildKind',
            'namespace',
            'baseBuildUuid',
            'repo',
            'branch',
            'pullRequestNumber',
            'contextFreshAt',
          ],
          additionalProperties: false,
        },

        BuildContextAgentChatLinks: {
          type: 'object',
          properties: {
            messages: { type: 'string' },
            runs: { type: 'string' },
            events: { type: 'string' },
            eventStream: { type: 'string' },
            pendingActions: { type: 'string' },
          },
          required: ['messages', 'runs', 'events', 'eventStream', 'pendingActions'],
          additionalProperties: false,
        },

        BuildContextAgentChatResponse: {
          type: 'object',
          properties: {
            session: { $ref: '#/components/schemas/AgentSessionSummary' },
            thread: { $ref: '#/components/schemas/AgentThread' },
            created: { type: 'boolean' },
            reused: { type: 'boolean' },
            buildContext: { $ref: '#/components/schemas/BuildContextAgentChatContext' },
            links: { $ref: '#/components/schemas/BuildContextAgentChatLinks' },
          },
          required: ['session', 'thread', 'created', 'reused', 'buildContext', 'links'],
          additionalProperties: false,
        },

        AgentAdminSessionSummary: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            sessionKind: {
              type: 'string',
              enum: Object.values(AgentSessionKind),
            },
            buildUuid: { type: 'string', nullable: true },
            baseBuildUuid: { type: 'string', nullable: true },
            buildKind: {
              type: 'string',
              enum: Object.values(BuildKind),
              nullable: true,
            },
            userId: { type: 'string' },
            ownerGithubUsername: { type: 'string', nullable: true },
            podName: { type: 'string', nullable: true },
            namespace: { type: 'string', nullable: true },
            pvcName: { type: 'string', nullable: true },
            model: { type: 'string' },
            status: {
              type: 'string',
              enum: ['starting', 'active', 'ended', 'error'],
            },
            chatStatus: {
              type: 'string',
              enum: Object.values(AgentChatStatus),
            },
            workspaceStatus: {
              type: 'string',
              enum: Object.values(AgentWorkspaceStatus),
            },
            repo: { type: 'string', nullable: true },
            branch: { type: 'string', nullable: true },
            primaryRepo: { type: 'string', nullable: true },
            primaryBranch: { type: 'string', nullable: true },
            services: {
              type: 'array',
              items: { type: 'string' },
            },
            workspaceRepos: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
            selectedServices: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
            startupFailure: {
              type: 'object',
              additionalProperties: true,
              nullable: true,
            },
            lastActivity: { type: 'string', format: 'date-time', nullable: true },
            endedAt: { type: 'string', format: 'date-time', nullable: true },
            threadCount: { type: 'integer' },
            pendingActionsCount: { type: 'integer' },
            lastRunAt: { type: 'string', format: 'date-time', nullable: true },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
            editorUrl: { type: 'string', nullable: true },
          },
          required: [
            'id',
            'sessionKind',
            'buildUuid',
            'baseBuildUuid',
            'buildKind',
            'userId',
            'ownerGithubUsername',
            'podName',
            'namespace',
            'pvcName',
            'model',
            'status',
            'chatStatus',
            'workspaceStatus',
            'repo',
            'branch',
            'primaryRepo',
            'primaryBranch',
            'services',
            'workspaceRepos',
            'selectedServices',
            'startupFailure',
            'lastActivity',
            'endedAt',
            'threadCount',
            'pendingActionsCount',
            'lastRunAt',
            'createdAt',
            'updatedAt',
            'editorUrl',
          ],
        },

        AgentRunStatus: {
          type: 'string',
          enum: [
            'queued',
            'starting',
            'running',
            'waiting_for_approval',
            'waiting_for_input',
            'completed',
            'failed',
            'cancelled',
          ],
        },

        AgentRunPlanRuntimeSummary: {
          type: 'object',
          properties: {
            harness: { type: 'string', enum: ['lifecycle_ai_sdk'] },
            maxIterations: { type: 'integer', nullable: true },
          },
          required: ['harness', 'maxIterations'],
          additionalProperties: false,
        },

        AgentRunPlanApprovalSummary: {
          type: 'object',
          properties: {
            defaultMode: { $ref: '#/components/schemas/AgentApprovalMode' },
          },
          required: ['defaultMode'],
          additionalProperties: false,
        },

        AgentRunPlanCapabilitySummary: {
          type: 'object',
          properties: {
            capabilityId: { type: 'string' },
            availability: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            allowed: { type: 'boolean' },
            approvalMode: {
              allOf: [{ $ref: '#/components/schemas/AgentApprovalMode' }],
              nullable: true,
            },
          },
          required: ['capabilityId', 'availability', 'allowed'],
          additionalProperties: false,
        },

        AgentRunPlanSelectedRuntimeChoicesSummary: {
          type: 'object',
          properties: {
            capabilityIds: {
              type: 'array',
              items: { type: 'string' },
            },
            toolChoiceIds: {
              type: 'array',
              items: { type: 'string' },
            },
            mcpChoiceIds: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['capabilityIds', 'toolChoiceIds', 'mcpChoiceIds'],
          additionalProperties: false,
        },

        AgentRunPlanCapabilitiesSummary: {
          type: 'object',
          properties: {
            effective: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentRunPlanCapabilitySummary' },
            },
            selected: { $ref: '#/components/schemas/AgentRunPlanSelectedRuntimeChoicesSummary' },
          },
          required: ['effective', 'selected'],
          additionalProperties: false,
        },

        AgentRunPlanSummary: {
          type: 'object',
          nullable: true,
          properties: {
            version: { type: 'integer', enum: [1] },
            agent: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                sourceKind: {
                  type: 'string',
                  enum: ['build_context_chat', 'workspace_session', 'freeform_chat'],
                },
              },
              required: ['id', 'label', 'sourceKind'],
              additionalProperties: false,
            },
            source: {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  enum: ['build_context_chat', 'workspace_session', 'freeform_chat'],
                },
                repoFullName: { type: 'string', nullable: true },
                branch: { type: 'string', nullable: true },
                buildUuid: { type: 'string', nullable: true },
                namespace: { type: 'string', nullable: true },
              },
              required: ['kind'],
              additionalProperties: false,
            },
            model: {
              type: 'object',
              properties: {
                provider: { type: 'string' },
                model: { type: 'string' },
              },
              required: ['provider', 'model'],
              additionalProperties: false,
            },
            runtime: { $ref: '#/components/schemas/AgentRunPlanRuntimeSummary' },
            approval: { $ref: '#/components/schemas/AgentRunPlanApprovalSummary' },
            capabilities: { $ref: '#/components/schemas/AgentRunPlanCapabilitiesSummary' },
            warnings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
                required: ['code', 'message'],
                additionalProperties: false,
              },
            },
          },
          required: ['version', 'agent', 'source', 'model', 'runtime', 'approval', 'capabilities', 'warnings'],
          additionalProperties: false,
        },

        AgentRun: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            threadId: { type: 'string', nullable: true },
            sessionId: { type: 'string', nullable: true },
            status: { $ref: '#/components/schemas/AgentRunStatus' },
            requestedHarness: { type: 'string', nullable: true },
            resolvedHarness: { type: 'string', nullable: true },
            requestedProvider: { type: 'string', nullable: true },
            requestedModel: { type: 'string', nullable: true },
            resolvedProvider: { type: 'string', nullable: true },
            resolvedModel: { type: 'string', nullable: true },
            provider: { type: 'string' },
            model: { type: 'string' },
            sandboxRequirement: { type: 'object', additionalProperties: true },
            sandboxGeneration: { type: 'integer', nullable: true },
            queuedAt: { type: 'string', format: 'date-time', nullable: true },
            startedAt: { type: 'string', format: 'date-time', nullable: true },
            completedAt: { type: 'string', format: 'date-time', nullable: true },
            cancelledAt: { type: 'string', format: 'date-time', nullable: true },
            usageSummary: { type: 'object', additionalProperties: true },
            policySnapshot: { type: 'object', additionalProperties: true },
            runPlan: { $ref: '#/components/schemas/AgentRunPlanSummary' },
            error: {
              allOf: [{ $ref: '#/components/schemas/AgentRunError' }],
              nullable: true,
            },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: [
            'id',
            'status',
            'requestedHarness',
            'resolvedHarness',
            'requestedProvider',
            'requestedModel',
            'resolvedProvider',
            'resolvedModel',
            'provider',
            'model',
            'sandboxRequirement',
            'sandboxGeneration',
            'usageSummary',
            'policySnapshot',
            'runPlan',
          ],
        },

        CreateAgentThreadRunResponse: {
          type: 'object',
          properties: {
            run: { $ref: '#/components/schemas/AgentRun' },
            message: { $ref: '#/components/schemas/AgentMessage' },
            links: {
              type: 'object',
              properties: {
                events: { type: 'string' },
                eventStream: { type: 'string' },
                pendingActions: { type: 'string' },
              },
              required: ['events', 'eventStream', 'pendingActions'],
              additionalProperties: false,
            },
          },
          required: ['run', 'message', 'links'],
          additionalProperties: false,
        },

        AgentRunError: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            name: { type: 'string', nullable: true },
            code: { type: 'string', nullable: true },
            stack: { type: 'string', nullable: true },
            details: { type: 'object', additionalProperties: true, nullable: true },
          },
          required: ['message'],
          additionalProperties: true,
        },

        AgentRunTruncatedValue: {
          type: 'object',
          properties: {
            truncated: { type: 'boolean', enum: [true] },
            originalJsonBytes: { type: 'integer' },
            preview: { type: 'string' },
          },
          required: ['truncated', 'originalJsonBytes', 'preview'],
          additionalProperties: false,
        },

        AgentRunMessageCreatedEvent: agentRunEventSchema(['message.created'], {
          type: 'object',
          properties: {
            messageId: { type: 'string' },
            metadata: agentRunEventPayloadMetadata,
          },
          required: ['messageId', 'metadata'],
          additionalProperties: false,
        }),

        AgentRunMessageMetadataEvent: agentRunEventSchema(['message.metadata'], {
          type: 'object',
          properties: {
            metadata: agentRunEventPayloadMetadata,
          },
          required: ['metadata'],
          additionalProperties: false,
        }),

        AgentRunMessagePartEvent: agentRunEventSchema(
          ['message.part.started', 'message.delta', 'message.part.completed'],
          {
            type: 'object',
            properties: {
              partType: { type: 'string', enum: ['text', 'reasoning'] },
              partId: { type: 'string' },
              delta: { type: 'string' },
              providerMetadata: agentRunEventPayloadMetadata,
            },
            required: ['partType', 'partId'],
            additionalProperties: false,
          }
        ),

        AgentRunMessageSourceEvent: agentRunEventSchema(['message.source'], {
          type: 'object',
          properties: {
            sourceType: { type: 'string', enum: ['url', 'document'] },
            sourceId: { type: 'string' },
            url: { type: 'string' },
            mediaType: { type: 'string' },
            title: { type: 'string' },
            filename: { type: 'string' },
            providerMetadata: agentRunEventPayloadMetadata,
          },
          required: ['sourceType', 'sourceId'],
          additionalProperties: false,
        }),

        AgentRunMessageFileEvent: agentRunEventSchema(['message.file'], {
          type: 'object',
          properties: {
            url: { type: 'string' },
            mediaType: { type: 'string' },
            providerMetadata: agentRunEventPayloadMetadata,
          },
          required: ['url', 'mediaType'],
          additionalProperties: false,
        }),

        AgentRunToolInputStartedEvent: agentRunEventSchema(['tool.call.input.started'], {
          type: 'object',
          properties: {
            toolCallId: { type: 'string' },
            toolName: { type: 'string' },
            providerExecuted: { type: 'boolean' },
            providerMetadata: agentRunEventPayloadMetadata,
            dynamic: { type: 'boolean' },
            title: { type: 'string' },
          },
          required: ['toolCallId', 'toolName'],
          additionalProperties: false,
        }),

        AgentRunToolInputDeltaEvent: agentRunEventSchema(['tool.call.input.delta'], {
          type: 'object',
          properties: {
            toolCallId: { type: 'string' },
            inputTextDelta: { type: 'string' },
          },
          required: ['toolCallId', 'inputTextDelta'],
          additionalProperties: false,
        }),

        AgentRunToolInputEvent: {
          oneOf: [
            { $ref: '#/components/schemas/AgentRunToolInputStartedEvent' },
            { $ref: '#/components/schemas/AgentRunToolInputDeltaEvent' },
          ],
          discriminator: {
            propertyName: 'eventType',
            mapping: {
              'tool.call.input.started': '#/components/schemas/AgentRunToolInputStartedEvent',
              'tool.call.input.delta': '#/components/schemas/AgentRunToolInputDeltaEvent',
            },
          },
        },

        AgentRunToolStartedEvent: agentRunEventSchema(['tool.call.started'], {
          type: 'object',
          properties: {
            toolCallId: { type: 'string' },
            toolName: { type: 'string' },
            inputStatus: { type: 'string', enum: ['available', 'error'] },
            input: { nullable: true },
            errorText: { type: 'string', nullable: true },
            providerExecuted: { type: 'boolean' },
            providerMetadata: agentRunEventPayloadMetadata,
            dynamic: { type: 'boolean' },
            title: { type: 'string' },
          },
          required: ['toolCallId', 'toolName', 'inputStatus', 'input', 'errorText'],
          additionalProperties: false,
        }),

        AgentRunToolCompletedEvent: agentRunEventSchema(['tool.call.completed'], {
          type: 'object',
          properties: {
            toolCallId: { type: 'string' },
            output: { nullable: true },
            errorText: { type: 'string', nullable: true },
            status: { type: 'string', enum: ['completed', 'denied', 'failed'] },
            providerExecuted: { type: 'boolean' },
            providerMetadata: agentRunEventPayloadMetadata,
            dynamic: { type: 'boolean' },
            preliminary: { type: 'boolean' },
          },
          required: ['toolCallId', 'output', 'errorText', 'status'],
          additionalProperties: false,
        }),

        AgentRunToolCallEvent: {
          oneOf: [
            { $ref: '#/components/schemas/AgentRunToolStartedEvent' },
            { $ref: '#/components/schemas/AgentRunToolCompletedEvent' },
          ],
          discriminator: {
            propertyName: 'eventType',
            mapping: {
              'tool.call.started': '#/components/schemas/AgentRunToolStartedEvent',
              'tool.call.completed': '#/components/schemas/AgentRunToolCompletedEvent',
            },
          },
        },

        AgentRunToolFileChangeEvent: agentRunEventSchema(['tool.file_change'], {
          type: 'object',
          properties: {
            id: { type: 'string' },
            data: { $ref: '#/components/schemas/AgentFileChangeData' },
            transient: { type: 'boolean' },
          },
          required: ['data'],
          additionalProperties: false,
        }),

        AgentRunApprovalRequestedEvent: agentRunEventSchema(['approval.requested'], {
          type: 'object',
          properties: {
            actionId: { type: 'string' },
            approvalId: { type: 'string' },
            toolCallId: { type: 'string' },
          },
          required: ['approvalId', 'toolCallId'],
          additionalProperties: false,
        }),

        AgentRunApprovalResolvedEvent: agentRunEventSchema(['approval.resolved'], {
          type: 'object',
          properties: {
            actionId: { type: 'string' },
            approvalId: { type: 'string' },
            toolCallId: { type: 'string', nullable: true },
            approved: { type: 'boolean' },
            reason: { type: 'string', nullable: true },
          },
          required: ['actionId', 'approvalId', 'toolCallId', 'approved', 'reason'],
          additionalProperties: false,
        }),

        AgentRunApprovalRespondedEvent: agentRunEventSchema(['approval.responded'], {
          type: 'object',
          properties: {
            actionId: { type: 'string' },
            approvalId: { type: 'string' },
            toolCallId: { type: 'string', nullable: true },
            approved: { type: 'boolean' },
            reason: { type: 'string', nullable: true },
          },
          required: ['actionId', 'approvalId', 'toolCallId', 'approved', 'reason'],
          additionalProperties: false,
        }),

        AgentRunApprovalEvent: {
          oneOf: [
            { $ref: '#/components/schemas/AgentRunApprovalRequestedEvent' },
            { $ref: '#/components/schemas/AgentRunApprovalResolvedEvent' },
            { $ref: '#/components/schemas/AgentRunApprovalRespondedEvent' },
          ],
          discriminator: {
            propertyName: 'eventType',
            mapping: {
              'approval.requested': '#/components/schemas/AgentRunApprovalRequestedEvent',
              'approval.resolved': '#/components/schemas/AgentRunApprovalResolvedEvent',
              'approval.responded': '#/components/schemas/AgentRunApprovalRespondedEvent',
            },
          },
        },

        AgentRunStatusEvent: agentRunEventSchema(
          [
            'run.queued',
            'run.started',
            'run.waiting_for_approval',
            'run.completed',
            'run.failed',
            'run.cancelled',
            'run.updated',
          ],
          {
            type: 'object',
            properties: {
              threadId: { type: 'string' },
              sessionId: { type: 'string' },
              status: { $ref: '#/components/schemas/AgentRunStatus' },
              error: {
                allOf: [{ $ref: '#/components/schemas/AgentRunError' }],
                nullable: true,
              },
              usageSummary: { type: 'object', additionalProperties: true },
            },
            additionalProperties: false,
          }
        ),

        AgentRunStepEvent: agentRunEventSchema(['run.step.started', 'run.step.completed'], {
          type: 'object',
          properties: {},
          additionalProperties: false,
        }),

        AgentRunFinishedEvent: agentRunEventSchema(['run.finished'], {
          type: 'object',
          properties: {
            finishReason: { type: 'string' },
            metadata: agentRunEventPayloadMetadata,
          },
          required: ['finishReason', 'metadata'],
          additionalProperties: false,
        }),

        AgentRunErrorEvent: agentRunEventSchema(['run.error'], {
          type: 'object',
          properties: {
            errorText: { type: 'string' },
          },
          required: ['errorText'],
          additionalProperties: false,
        }),

        AgentRunAbortedEvent: agentRunEventSchema(['run.aborted'], {
          type: 'object',
          properties: {
            reason: { type: 'string' },
          },
          required: ['reason'],
          additionalProperties: false,
        }),

        AgentRunEvent: {
          oneOf: [
            { $ref: '#/components/schemas/AgentRunMessageCreatedEvent' },
            { $ref: '#/components/schemas/AgentRunMessageMetadataEvent' },
            { $ref: '#/components/schemas/AgentRunMessagePartEvent' },
            { $ref: '#/components/schemas/AgentRunMessageSourceEvent' },
            { $ref: '#/components/schemas/AgentRunMessageFileEvent' },
            { $ref: '#/components/schemas/AgentRunToolInputStartedEvent' },
            { $ref: '#/components/schemas/AgentRunToolInputDeltaEvent' },
            { $ref: '#/components/schemas/AgentRunToolStartedEvent' },
            { $ref: '#/components/schemas/AgentRunToolCompletedEvent' },
            { $ref: '#/components/schemas/AgentRunToolFileChangeEvent' },
            { $ref: '#/components/schemas/AgentRunApprovalRequestedEvent' },
            { $ref: '#/components/schemas/AgentRunApprovalResolvedEvent' },
            { $ref: '#/components/schemas/AgentRunApprovalRespondedEvent' },
            { $ref: '#/components/schemas/AgentRunStatusEvent' },
            { $ref: '#/components/schemas/AgentRunStepEvent' },
            { $ref: '#/components/schemas/AgentRunFinishedEvent' },
            { $ref: '#/components/schemas/AgentRunErrorEvent' },
            { $ref: '#/components/schemas/AgentRunAbortedEvent' },
          ],
          discriminator: {
            propertyName: 'eventType',
            mapping: agentRunEventDiscriminatorMapping,
          },
          example: {
            id: 'event-1',
            runId: 'run-1',
            threadId: 'thread-1',
            sessionId: 'session-1',
            sequence: 3,
            eventType: 'message.delta',
            version: 1,
            payload: {
              partType: 'text',
              partId: 'text-1',
              delta: 'Hello',
            },
            createdAt: '2026-04-25T00:00:02.000Z',
            updatedAt: '2026-04-25T00:00:02.000Z',
          },
        },

        AgentPendingActionArgumentSummary: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['name', 'value'],
          additionalProperties: false,
        },

        AgentFileChangeData: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            toolCallId: { type: 'string' },
            sourceTool: { type: 'string' },
            path: { type: 'string' },
            displayPath: { type: 'string' },
            kind: { type: 'string', enum: ['created', 'edited', 'deleted'] },
            stage: { type: 'string', enum: ['awaiting-approval', 'approved', 'applied', 'denied', 'failed'] },
            additions: { type: 'integer' },
            deletions: { type: 'integer' },
            truncated: { type: 'boolean' },
            unifiedDiff: { type: 'string', nullable: true },
            beforeTextPreview: { type: 'string', nullable: true },
            afterTextPreview: { type: 'string', nullable: true },
            summary: { type: 'string', nullable: true },
            encoding: { type: 'string', nullable: true },
            oldSizeBytes: { type: 'integer', nullable: true },
            newSizeBytes: { type: 'integer', nullable: true },
            oldSha256: { type: 'string', nullable: true },
            newSha256: { type: 'string', nullable: true },
          },
          required: [
            'id',
            'toolCallId',
            'sourceTool',
            'path',
            'displayPath',
            'kind',
            'stage',
            'additions',
            'deletions',
            'truncated',
            'unifiedDiff',
            'beforeTextPreview',
            'afterTextPreview',
            'summary',
            'encoding',
            'oldSizeBytes',
            'newSizeBytes',
            'oldSha256',
            'newSha256',
          ],
          additionalProperties: false,
        },

        AgentPendingAction: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            threadId: { type: 'string', nullable: true },
            runId: { type: 'string', nullable: true },
            kind: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'approved', 'denied'] },
            title: { type: 'string' },
            description: { type: 'string' },
            requestedAt: { type: 'string', format: 'date-time', nullable: true },
            expiresAt: { type: 'string', format: 'date-time', nullable: true },
            toolName: { type: 'string', nullable: true },
            argumentsSummary: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentPendingActionArgumentSummary' },
            },
            commandPreview: { type: 'string', nullable: true },
            fileChangePreview: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentFileChangeData' },
            },
            riskLabels: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: [
            'id',
            'kind',
            'status',
            'threadId',
            'runId',
            'title',
            'description',
            'requestedAt',
            'expiresAt',
            'toolName',
            'argumentsSummary',
            'commandPreview',
            'fileChangePreview',
            'riskLabels',
          ],
          additionalProperties: false,
          example: {
            id: 'action-1',
            threadId: 'thread-1',
            runId: 'run-1',
            kind: 'tool_approval',
            status: 'pending',
            title: 'Approve workspace edit',
            description: 'A workspace edit requires approval.',
            requestedAt: '2026-04-25T00:00:03.000Z',
            expiresAt: null,
            toolName: 'mcp__sandbox__workspace_edit_file',
            argumentsSummary: [{ name: 'path', value: 'sample-file.txt' }],
            commandPreview: null,
            fileChangePreview: [
              {
                id: 'tool-call-1:sample-file.txt',
                toolCallId: 'tool-call-1',
                sourceTool: 'workspace_edit_file',
                path: 'sample-file.txt',
                displayPath: 'sample-file.txt',
                kind: 'edited',
                stage: 'awaiting-approval',
                summary: 'edited sample-file.txt',
                additions: 1,
                deletions: 0,
                truncated: false,
                unifiedDiff: null,
                beforeTextPreview: null,
                afterTextPreview: null,
                encoding: null,
                oldSizeBytes: null,
                newSizeBytes: null,
                oldSha256: null,
                newSha256: null,
              },
            ],
            riskLabels: ['Workspace write'],
          },
        },

        AgentToolExecution: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            threadId: { type: 'string', nullable: true },
            runId: { type: 'string', nullable: true },
            pendingActionId: { type: 'string', nullable: true },
            source: { type: 'string' },
            serverSlug: { type: 'string', nullable: true },
            toolName: { type: 'string' },
            toolCallId: { type: 'string', nullable: true },
            args: { type: 'object', additionalProperties: true },
            result: { type: 'object', additionalProperties: true, nullable: true },
            status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'cancelled'] },
            safetyLevel: { type: 'string', nullable: true },
            approved: { type: 'boolean', nullable: true },
            startedAt: { type: 'string', format: 'date-time', nullable: true },
            completedAt: { type: 'string', format: 'date-time', nullable: true },
            durationMs: { type: 'integer', nullable: true },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: [
            'id',
            'threadId',
            'runId',
            'pendingActionId',
            'source',
            'serverSlug',
            'toolName',
            'toolCallId',
            'args',
            'result',
            'status',
            'safetyLevel',
            'approved',
            'startedAt',
            'completedAt',
            'durationMs',
            'createdAt',
            'updatedAt',
          ],
          additionalProperties: false,
          example: {
            id: 'tool-execution-1',
            threadId: 'thread-1',
            runId: 'run-1',
            pendingActionId: 'action-1',
            source: 'mcp',
            serverSlug: 'sandbox',
            toolName: 'workspace.edit_file',
            toolCallId: 'tool-call-1',
            args: { path: 'sample-file.txt' },
            result: null,
            status: 'completed',
            safetyLevel: null,
            approved: true,
            startedAt: '2026-04-25T00:00:04.000Z',
            completedAt: '2026-04-25T00:00:05.000Z',
            durationMs: 1000,
            createdAt: '2026-04-25T00:00:04.000Z',
            updatedAt: '2026-04-25T00:00:05.000Z',
          },
        },

        AgentAdminThreadSummary: {
          allOf: [
            { $ref: '#/components/schemas/AgentThread' },
            {
              type: 'object',
              properties: {
                messageCount: { type: 'integer' },
                runCount: { type: 'integer' },
                pendingActionsCount: { type: 'integer' },
                latestRun: { $ref: '#/components/schemas/AgentRun', nullable: true },
              },
              required: ['messageCount', 'runCount', 'pendingActionsCount', 'latestRun'],
            },
          ],
        },

        AgentAdminSessionDetail: {
          type: 'object',
          properties: {
            session: { $ref: '#/components/schemas/AgentAdminSessionSummary' },
            threads: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentAdminThreadSummary' },
            },
          },
          required: ['session', 'threads'],
        },

        AgentAdminThreadConversation: {
          type: 'object',
          properties: {
            session: { $ref: '#/components/schemas/AgentAdminSessionSummary' },
            thread: { $ref: '#/components/schemas/AgentAdminThreadSummary' },
            messages: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentMessage' },
            },
            runs: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentRun' },
            },
            events: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentRunEvent' },
            },
            pendingActions: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentPendingAction' },
            },
            toolExecutions: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentToolExecution' },
            },
          },
          required: ['session', 'thread', 'messages', 'runs', 'events', 'pendingActions', 'toolExecutions'],
        },

        AgentAdminMcpServerCoverage: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string', nullable: true },
            scope: { type: 'string' },
            preset: { type: 'string', nullable: true },
            transport: { $ref: '#/components/schemas/McpTransportConfig' },
            sharedConfig: { $ref: '#/components/schemas/McpSharedConnectionConfig' },
            authConfig: { $ref: '#/components/schemas/McpAuthConfig' },
            enabled: { type: 'boolean' },
            timeout: { type: 'integer' },
            connectionRequired: { type: 'boolean' },
            sharedDiscoveredTools: {
              type: 'array',
              items: { $ref: '#/components/schemas/McpDiscoveredTool' },
            },
            userConnectionCount: { type: 'integer' },
            latestUserValidatedAt: { type: 'string', format: 'date-time', nullable: true },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: [
            'slug',
            'name',
            'description',
            'scope',
            'preset',
            'transport',
            'sharedConfig',
            'authConfig',
            'enabled',
            'timeout',
            'connectionRequired',
            'sharedDiscoveredTools',
            'userConnectionCount',
            'latestUserValidatedAt',
            'createdAt',
            'updatedAt',
          ],
        },

        AgentAdminMcpServerUserConnection: {
          type: 'object',
          properties: {
            userId: { type: 'string' },
            githubUsername: { type: 'string', nullable: true },
            authMode: { type: 'string', enum: ['none', 'fields', 'oauth'] },
            stale: { type: 'boolean' },
            configuredFieldKeys: {
              type: 'array',
              items: { type: 'string' },
            },
            discoveredToolCount: { type: 'integer' },
            validationError: { type: 'string', nullable: true },
            validatedAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: [
            'userId',
            'githubUsername',
            'authMode',
            'stale',
            'configuredFieldKeys',
            'discoveredToolCount',
            'validationError',
            'validatedAt',
            'updatedAt',
          ],
        },

        // ===================================================================
        // Resource-Specific Schemas
        // ===================================================================

        /**
         * @description Log streaming information for a build job.
         */
        LogStreamResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['Active', 'Complete', 'Failed', 'NotFound', 'Pending', 'Archived'] },
            streamingRequired: { type: 'boolean' },
            podName: { type: 'string', nullable: true },
            websocket: { $ref: '#/components/schemas/WebSocketInfo' },
            containers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  state: { type: 'string' },
                },
                required: ['name', 'state'],
              },
            },
            message: { type: 'string' },
            error: { type: 'string' },
            archivedLogs: {
              type: 'string',
              description: 'Full log content retrieved from object storage (only present when status is Archived)',
            },
          },
          required: ['status', 'streamingRequired'],
        },

        /**
         * @description WebSocket connection information for log streaming.
         */
        WebSocketInfo: {
          type: 'object',
          properties: {
            endpoint: { type: 'string', example: '/api/logs/stream' },
            parameters: {
              type: 'object',
              properties: {
                podName: { type: 'string' },
                namespace: { type: 'string' },
                follow: { type: 'boolean' },
                timestamps: { type: 'boolean' },
                container: { type: 'string' },
              },
              required: ['podName', 'namespace', 'follow', 'timestamps'],
            },
          },
          required: ['endpoint', 'parameters'],
        },

        /**
         * @description Log streaming information for a build job.
         */
        LogStreamSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/LogStreamResponse' },
              },
              required: ['data'],
            },
          ],
        },

        /**
         * @description Enum for build engines used by native builds.
         */
        NativeBuildEngine: {
          type: 'string',
          enum: ['buildkit', 'kaniko', 'unknown'],
        },

        /**
         * @description Enum for native build job statuses.
         * Keep in sync with what your API actually returns.
         */
        NativeBuildJobStatus: {
          type: 'string',
          enum: ['Active', 'Complete', 'Failed', 'Pending'],
        },

        /**
         * @description A single native build job record for a service within a build.
         */
        NativeBuildJobInfo: {
          type: 'object',
          properties: {
            jobName: {
              type: 'string',
              description: 'Kubernetes job name',
              example: 'build-api-abc123-1234567890',
            },
            buildUuid: {
              type: 'string',
              description: 'Deploy/build UUID',
              example: 'api-abc123',
            },
            sha: {
              type: 'string',
              description: 'Git commit SHA',
              example: 'a1b2c3d4e5f6',
            },
            status: {
              $ref: '#/components/schemas/NativeBuildJobStatus',
            },
            startedAt: {
              type: 'string',
              format: 'date-time',
              description: 'When the job started',
            },
            completedAt: {
              type: 'string',
              format: 'date-time',
              description: 'When the job completed',
            },
            duration: {
              type: 'number',
              description: 'Build duration in seconds',
            },
            engine: {
              $ref: '#/components/schemas/NativeBuildEngine',
            },
            podName: {
              type: 'string',
              description: 'Kubernetes pod name associated with the build job',
              example: 'build-api-abc123-1234567890-pod',
            },
            error: {
              type: 'string',
              description: 'Error message if the build job failed',
              example: 'Job failed due to ...',
            },
            source: {
              type: 'string',
              enum: ['live', 'archived'],
              description: 'Whether the job is from a live k8s resource or archived in object storage',
            },
          },
          required: ['jobName', 'buildUuid', 'sha', 'status', 'engine'],
        },

        /**
         * @description A single deployment job record for a service within a build.
         */
        DeploymentJobInfo: {
          type: 'object',
          properties: {
            jobName: {
              type: 'string',
              description: 'Kubernetes job name',
              example: 'deploy-uuid-helm-123-abc123',
            },
            deployUuid: {
              type: 'string',
              description: 'Deploy UUID',
              example: 'deploy-uuid',
            },
            sha: {
              type: 'string',
              description: 'Git commit SHA',
              example: 'abc123',
            },
            status: {
              type: 'string',
              enum: ['Active', 'Complete', 'Failed', 'Pending'],
              description: 'Current status of the deployment job',
            },
            startedAt: {
              type: 'string',
              format: 'date-time',
              description: 'When the job started',
            },
            completedAt: {
              type: 'string',
              format: 'date-time',
              description: 'When the job completed',
            },
            duration: {
              type: 'number',
              description: 'Deployment duration in seconds',
            },
            error: {
              type: 'string',
              description: 'Error message if job failed',
              example: 'Job failed due to ...',
            },
            podName: {
              type: 'string',
              description: 'Name of the pod running the job',
              example: 'deploy-uuid-helm-123-abc123-pod',
            },
            deploymentType: {
              type: 'string',
              enum: ['helm', 'github'],
              description: 'Type of deployment job',
            },
            source: {
              type: 'string',
              enum: ['live', 'archived'],
              description: 'Whether the job is from a live k8s resource or archived in object storage',
            },
          },
          required: ['jobName', 'deployUuid', 'sha', 'status', 'deploymentType'],
        },

        /**
         * @description The specific success response for
         * GET /api/v2/builds/{uuid}/services/{name}/pods
         */
        GetDeploymentPodsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    pods: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/DeploymentPodInfo' },
                    },
                  },
                  required: ['pods'],
                },
              },
              required: ['data'],
            },
          ],
        },

        /**
         * @description Information about a pod within a build environment, including its service name.
         */
        EnvironmentPodInfo: {
          allOf: [
            { $ref: '#/components/schemas/DeploymentPodInfo' },
            {
              type: 'object',
              properties: {
                serviceName: { type: 'string', description: 'The service this pod belongs to.' },
              },
              required: ['serviceName'],
            },
          ],
        },

        /**
         * @description The specific success response for
         * GET /api/v2/builds/{uuid}/pods
         */
        GetEnvironmentPodsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    pods: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/EnvironmentPodInfo' },
                    },
                  },
                  required: ['pods'],
                },
              },
              required: ['data'],
            },
          ],
        },

        /**
         * @description The specific success response for
         * PUT /api/v2/builds/{uuid}/services/{name}/redeploy
         */
        RedeployServiceSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    status: { type: 'string' },
                    message: { type: 'string' },
                  },
                  required: ['status', 'message'],
                },
              },
            },
          ],
        },

        /**
         * @description The specific success response for
         * PUT /api/v2/builds/{uuid}/redeploy
         */
        RedeployBuildSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    status: { type: 'string' },
                    message: { type: 'string' },
                  },
                  required: ['status', 'message'],
                },
              },
              required: ['data'],
            },
          ],
        },

        /**
         * @description The specific success response for
         * PUT /api/v2/builds/{uuid}/destroy
         */
        TearDownBuildSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    status: { type: 'string' },
                    message: { type: 'string' },
                    namespacesUpdated: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Deploy' },
                    },
                  },
                  required: ['status', 'message', 'namespacesUpdated'],
                },
                required: ['data'],
              },
            },
          ],
        },

        /**
         * @description A single webhook invocation record.
         */
        WebhookInvocation: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            buildId: { type: 'integer' },
            runUUID: { type: 'string' },
            name: { type: 'string' },
            type: { type: 'string' },
            state: { type: 'string' },
            yamlConfig: { type: 'string' },
            owner: { type: 'string' },
            metadata: { type: 'string', nullable: true },
            status: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
          required: ['id', 'buildId', 'runUUID', 'name', 'type', 'state', 'owner', 'status'],
        },

        /**
         * @description The specific success response for
         * GET /api/v2/builds/{uuid}/webhooks
         */
        GetWebhooksSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/WebhookInvocation' },
                },
              },
              required: ['data'],
            },
          ],
        },

        /**
         * @description The specific success response for
         * POST /api/v2/builds/{uuid}/webhooks
         */
        InvokeWebhooksSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    status: { type: 'string' },
                    message: { type: 'string' },
                  },
                  required: ['status', 'message'],
                },
              },
              required: ['data'],
            },
          ],
        },

        /**
         * @description Information about a deployment pod.
         */
        DeploymentPodInfo: {
          type: 'object',
          properties: {
            podName: { type: 'string' },
            status: { type: 'string' },
            restarts: { type: 'integer' },
            ageSeconds: { type: 'integer' },
            age: { type: 'string' },
            ready: { type: 'boolean' },
            containers: {
              type: 'array',
              items: { $ref: '#/components/schemas/DeploymentPodContainerInfo' },
            },
          },
          required: ['podName', 'status', 'restarts', 'ageSeconds', 'age', 'ready', 'containers'],
        },

        /**
         * @description Information about a container within a deployment pod.
         */
        DeploymentPodContainerInfo: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            image: { type: 'string', nullable: true },
            ready: { type: 'boolean' },
            restarts: { type: 'integer' },
            state: { type: 'string' },
            reason: { type: 'string', nullable: true },
            isInit: { type: 'boolean' },
          },
          required: ['name', 'ready', 'restarts', 'state', 'isInit'],
        },

        /**
         * @description The specific success response for
         * GET /api/v2/builds/{uuid}/services/{name}/deploy-jobs
         */
        GetDeployLogsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    deployments: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/DeploymentJobInfo' },
                    },
                  },
                  required: ['deployments'],
                },
              },
              required: ['data'],
            },
          ],
        },

        /**
         * @description The specific success response for
         * GET /api/v2/builds/{uuid}/services/{name}/build-jobs
         */
        GetBuildLogsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    builds: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/NativeBuildJobInfo' },
                    },
                  },
                  required: ['builds'],
                },
              },
              required: ['data'],
            },
          ],
        },

        /**
         * @description Enum for build statuses.
         */
        BuildStatus: {
          type: 'string',
          enum: Object.values(BuildStatus),
        },

        BuildKind: {
          type: 'string',
          enum: Object.values(BuildKind),
        },

        AgentSessionKind: {
          type: 'string',
          enum: Object.values(AgentSessionKind),
        },

        AgentChatStatus: {
          type: 'string',
          enum: Object.values(AgentChatStatus),
        },

        AgentWorkspaceStatus: {
          type: 'string',
          enum: Object.values(AgentWorkspaceStatus),
        },

        /**
         * @description The main Build object.
         */
        Build: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            sha: { type: 'string', example: 'a1b2c3d4e5f6g7h8i9j0' },
            manifest: { type: 'string', example: 'version: 1.0.0\nservices:\n  web:\n    image: myapp:web\n' },
            uuid: { type: 'string', example: 'white-poetry-596195' },
            status: { $ref: '#/components/schemas/BuildStatus' },
            statusMessage: {
              type: 'string',
              maxLength: 1000,
              nullable: true,
              example:
                'Build failed because web: Unable to resolve branch "feature/sample" in repository "example-org/example-repo".',
            },
            kind: { $ref: '#/components/schemas/BuildKind' },
            namespace: { type: 'string', example: 'env-white-poetry-596195' },
            isStatic: { type: 'boolean', example: false },
            baseBuildId: { type: 'integer', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            baseBuild: {
              type: 'object',
              nullable: true,
              properties: {
                id: { type: 'integer' },
                uuid: { type: 'string' },
              },
            },
            pullRequest: { $ref: '#/components/schemas/PullRequest' },
            deploys: {
              type: 'array',
              items: { $ref: '#/components/schemas/Deploy' },
            },
            dependencyGraph: { type: 'object' },
          },
          required: [
            'id',
            'uuid',
            'status',
            'kind',
            'namespace',
            'manifest',
            'isStatic',
            'sha',
            'createdAt',
            'updatedAt',
            'pullRequest',
            'deploys',
          ],
        },

        UpdateBuildUUIDRequest: {
          type: 'object',
          properties: {
            uuid: {
              type: 'string',
              example: 'curly-meadow-171613',
              description: 'The new UUID to assign to the build.',
            },
          },
          required: ['uuid'],
          additionalProperties: false,
        },

        BuildMetadataLink: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'example-environment-logs' },
            text: { type: 'string', example: 'Environment logs' },
            icon: { type: 'string', example: 'FileCog' },
            link: { type: 'string', example: 'https://example.com/logs?build={{{buildUUID}}}' },
            position: { type: 'integer', example: 0 },
          },
          required: ['id', 'text', 'icon', 'link', 'position'],
        },

        BuildMetadata: {
          type: 'object',
          properties: {
            links: {
              type: 'array',
              items: { $ref: '#/components/schemas/BuildMetadataLink' },
            },
          },
          required: ['links'],
        },

        BuildMetadataLinkCreateRequest: {
          type: 'object',
          properties: {
            text: { type: 'string', example: 'Environment logs' },
            icon: { type: 'string', example: 'FileCog' },
            link: { type: 'string', example: 'https://example.com/logs?build={{{buildUUID}}}' },
            position: { type: 'integer', example: 0 },
          },
          required: ['text', 'icon', 'link'],
          additionalProperties: false,
        },

        BuildMetadataLinkPatchRequest: {
          type: 'object',
          properties: {
            text: { type: 'string', example: 'Environment logs' },
            icon: { type: 'string', example: 'FileCog' },
            link: { type: 'string', example: 'https://example.com/logs?build={{{buildUUID}}}' },
            position: { type: 'integer', example: 0 },
          },
          additionalProperties: false,
        },

        BuildMetadataSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/BuildMetadata' },
              },
              required: ['data'],
            },
          ],
        },

        /**
         * @description The Deployable associated with a Deploy.
         */
        Deployable: {
          type: 'object',
          properties: {
            name: { type: 'string', example: 'web' },
            type: { type: 'string', enum: Object.values(DeployTypes) },
            dockerfilePath: { type: 'string', example: 'Dockerfile' },
            deploymentDependsOn: { type: 'string', example: '{redis}' },
            builder: {
              type: 'object',
              properties: {
                engine: { type: 'string', example: 'buildkit' },
              },
            },
            ecr: { type: 'string', example: '123456789012.dkr.ecr.us-west-2.amazonaws.com/myapp' },
            grpc: { type: 'boolean', example: true },
            hostPortMapping: { type: 'object', example: { '80': 8080 } },
          },
          required: ['name', 'type', 'dockerfilePath', 'deploymentDependsOn', 'builder', 'ecr'],
        },

        /**
         * @description The Repository associated with a Deploy.
         */
        Repository: {
          type: 'object',
          properties: {
            fullName: { type: 'string', example: 'example-org/example-repo' },
          },
          required: ['fullName'],
        },

        /**
         * @description Enum for deploy statuses.
         */
        DeployStatus: {
          type: 'string',
          enum: Object.values(DeployStatus),
        },

        /**
         * @description A Deploy associated with a Build.
         */
        Deploy: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            uuid: { type: 'string', example: 'deploy-uuid' },
            status: { $ref: '#/components/schemas/DeployStatus' },
            statusMessage: { type: 'string', maxLength: 1000, example: 'Deployment in progress' },
            dockerImage: { type: 'string', example: 'myapp:web' },
            buildLogs: { type: 'string', example: 'https://g.codefresh.io/build/123...' },
            active: { type: 'boolean', example: true },
            cname: { type: 'string', example: 'myapp.example.com' },
            devMode: { type: 'boolean', example: false },
            branchName: { type: 'string', example: 'main' },
            publicUrl: { type: 'string', example: 'http://myapp.example.com' },
            deployableId: { type: 'integer' },
            deployPipelineId: { type: 'string', example: 'deploy-pipeline-id' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
            sha: { type: 'string', example: 'a1b2c3d4e5f6g7h8i9j0' },
            initDockerImage: { type: 'string', example: 'node:14-alpine' },
            env: { type: 'object', example: { PORT: '8080' } },
            initEnv: { type: 'object', example: { PORT: '8080' } },
            deployable: { $ref: '#/components/schemas/Deployable' },
            repository: { $ref: '#/components/schemas/Repository' },
          },
          required: [
            'id',
            'uuid',
            'status',
            'statusMessage',
            'dockerImage',
            'buildLogs',
            'active',
            'devMode',
            'branchName',
            'publicUrl',
            'deployableId',
            'deployPipelineId',
            'deployable',
            'repository',
            'createdAt',
            'updatedAt',
            'sha',
            'initDockerImage',
          ],
        },

        /**
         * @description A Pull Request associated with a Build.
         */
        PullRequest: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            title: { type: 'string', example: 'Add new feature' },
            fullName: { type: 'string', example: 'example-org/example-repo' },
            githubLogin: { type: 'string', example: 'sample-bot' },
            pullRequestNumber: { type: 'integer', example: 42 },
            status: { type: 'string', example: 'open' },
            branchName: { type: 'string', example: 'feature/new-feature' },
            labels: {
              type: 'array',
              items: { type: 'string', example: 'lifecycle-deploy!' },
            },
          },
          required: ['id', 'title', 'fullName', 'githubLogin', 'pullRequestNumber', 'branchName', 'status', 'labels'],
        },

        /**
         * @description The specific success response for the GET /builds endpoint.
         */
        GetBuildsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Build' },
                },
              },
              required: ['data'],
            },
          ],
        },

        /**
         * @description The specific success response for the GET /builds/{uuid} endpoint.
         */
        GetBuildByUUIDSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/Build' },
              },
              required: ['data'],
            },
          ],
        },

        /**
         * @description The specific success response for the PATCH /builds/{uuid} endpoint.
         */
        UpdateBuildUUIDSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/Build' },
              },
              required: ['data'],
            },
          ],
        },

        /**
         * @description The specific success response for the GET /schema/validate endpoint.
         */
        ValidateLifecycleSchemaSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    valid: { type: 'boolean' },
                  },
                  required: ['valid'],
                },
              },
              required: ['data'],
            },
          ],
        },

        // ===================================================================
        // Agent Runtime Config Schemas
        // ===================================================================

        AgentRuntimeModelConfig: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Model identifier used in API calls.',
              example: 'claude-sonnet-4-20250514',
            },
            displayName: { type: 'string', example: 'Claude Sonnet' },
            enabled: { type: 'boolean' },
            default: { type: 'boolean', description: 'Whether this is the default model for the provider.' },
            maxTokens: { type: 'integer', description: 'Maximum output tokens for this model.', example: 8192 },
            inputCostPerMillion: {
              type: 'number',
              description: 'Cost per million input tokens (USD). Used for UI cost display.',
            },
            outputCostPerMillion: {
              type: 'number',
              description: 'Cost per million output tokens (USD). Used for UI cost display.',
            },
          },
          required: ['id', 'displayName', 'enabled', 'default', 'maxTokens'],
        },

        AgentRuntimeProviderConfig: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            enabled: { type: 'boolean' },
            apiKeyEnvVar: {
              type: 'string',
              pattern: '^[A-Z_][A-Z0-9_]*$',
              description: 'Environment variable name used to resolve the provider API key.',
            },
            models: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentRuntimeModelConfig' },
            },
          },
          required: ['name', 'enabled', 'apiKeyEnvVar', 'models'],
        },

        AgentCapabilityAvailability: {
          type: 'string',
          enum: ['all_users', 'admin_only', 'system_only', 'disabled'],
        },

        AgentCapabilityPolicyAvailability: {
          type: 'object',
          properties: {
            read_context: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            diagnostics_logs: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            diagnostics_codefresh: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            diagnostics_kubernetes: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            diagnostics_database: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            github_read: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            github_write: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            workspace_files: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            workspace_shell: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            workspace_git: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            network_access: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            preview_publish: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            external_mcp_read: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            external_mcp_write: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            approval_controls: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
          },
          additionalProperties: false,
        },

        AgentCapabilityPolicy: {
          type: 'object',
          properties: {
            availability: { $ref: '#/components/schemas/AgentCapabilityPolicyAvailability' },
          },
          additionalProperties: false,
        },

        CustomAgentCreationMode: {
          type: 'string',
          enum: ['enabled', 'disabled', 'admins_only', 'allowlist'],
        },

        CustomAgentCreationUnavailableReason: {
          type: 'string',
          nullable: true,
          enum: ['creation_disabled', 'creation_restricted', null],
        },

        CreatorCapabilityAvailability: {
          type: 'string',
          enum: ['available', 'reserved'],
        },

        CreatorCapabilityAvailabilityMap: {
          type: 'object',
          properties: {
            read_context: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
            diagnostics_logs: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
            diagnostics_codefresh: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
            diagnostics_kubernetes: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
            diagnostics_database: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
            github_read: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
            github_write: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
            workspace_files: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
            workspace_shell: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
            workspace_git: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
            network_access: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
            preview_publish: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
            external_mcp_read: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
            external_mcp_write: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
            approval_controls: { $ref: '#/components/schemas/CreatorCapabilityAvailability' },
          },
          additionalProperties: false,
        },

        CustomAgentCreationPolicy: {
          type: 'object',
          properties: {
            mode: { $ref: '#/components/schemas/CustomAgentCreationMode' },
            allowedUserIds: { type: 'array', items: { type: 'string' } },
            allowedGithubUsernames: { type: 'array', items: { type: 'string' } },
            capabilityAvailability: { $ref: '#/components/schemas/CreatorCapabilityAvailabilityMap' },
          },
          additionalProperties: false,
        },

        AgentRuntimeConfig: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            approvalPolicy: { $ref: '#/components/schemas/AgentApprovalPolicy' },
            capabilityPolicy: { $ref: '#/components/schemas/AgentCapabilityPolicy' },
            customAgentCreationPolicy: { $ref: '#/components/schemas/CustomAgentCreationPolicy' },
            providers: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentRuntimeProviderConfig' },
            },
            maxMessagesPerSession: { type: 'integer' },
            sessionTTL: { type: 'integer' },
            additiveRules: { type: 'array', items: { type: 'string' } },
            systemPromptOverride: { type: 'string', maxLength: 50000 },
            excludedTools: { type: 'array', items: { type: 'string' } },
            excludedFilePatterns: { type: 'array', items: { type: 'string' } },
            allowedWritePatterns: { type: 'array', items: { type: 'string' } },
            maxIterations: { type: 'integer', description: 'Maximum orchestration loop iterations' },
            maxToolCalls: { type: 'integer', description: 'Maximum total tool calls per query' },
            maxRepeatedCalls: {
              type: 'integer',
              description: 'Maximum repeated calls with same arguments before loop detection',
            },
            compressionThreshold: {
              type: 'integer',
              description: 'Token count threshold before conversation history is compressed',
            },
            observationMaskingRecencyWindow: {
              type: 'integer',
              description: 'Number of recent tool results to preserve when masking observations',
            },
            observationMaskingTokenThreshold: {
              type: 'integer',
              description: 'Token count threshold before observation masking activates',
            },
            toolExecutionTimeout: { type: 'integer', description: 'Tool execution timeout in milliseconds' },
            toolOutputMaxChars: { type: 'integer', description: 'Maximum characters in tool output before truncation' },
            retryBudget: { type: 'integer', description: 'Maximum retry attempts per query on provider errors' },
          },
          required: ['enabled', 'providers', 'maxMessagesPerSession', 'sessionTTL'],
        },

        AgentRuntimeRepoOverride: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            maxMessagesPerSession: { type: 'integer' },
            sessionTTL: { type: 'integer' },
            approvalPolicy: { $ref: '#/components/schemas/AgentApprovalPolicy' },
            capabilityPolicy: { $ref: '#/components/schemas/AgentCapabilityPolicy' },
            additiveRules: { type: 'array', items: { type: 'string' } },
            systemPromptOverride: { type: 'string', maxLength: 50000 },
            excludedTools: { type: 'array', items: { type: 'string' } },
            excludedFilePatterns: { type: 'array', items: { type: 'string' } },
            allowedWritePatterns: { type: 'array', items: { type: 'string' } },
          },
        },

        AgentRuntimeAdditiveRulesUpdateRequest: {
          type: 'object',
          properties: {
            additiveRules: { type: 'array', items: { type: 'string' } },
          },
          required: ['additiveRules'],
          additionalProperties: false,
        },

        AgentRuntimeApprovalPolicyUpdateRequest: {
          type: 'object',
          properties: {
            approvalPolicy: { $ref: '#/components/schemas/AgentApprovalPolicy' },
          },
          required: ['approvalPolicy'],
          additionalProperties: false,
        },

        AgentRuntimeConfigPatchRequest: {
          type: 'object',
          properties: {
            additiveRules: { type: 'array', items: { type: 'string' } },
            approvalPolicy: { $ref: '#/components/schemas/AgentApprovalPolicy' },
          },
          additionalProperties: false,
          minProperties: 1,
          maxProperties: 1,
          description: 'Provide exactly one patch target: additiveRules or approvalPolicy.',
        },

        AgentRuntimeRepoConfigEntry: {
          type: 'object',
          properties: {
            repositoryFullName: { type: 'string' },
            config: { $ref: '#/components/schemas/AgentRuntimeRepoOverride' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },

        GetGlobalAgentRuntimeConfigSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/AgentRuntimeConfig' },
              },
            },
          ],
        },

        GetRepoAgentRuntimeConfigSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    repoFullName: { type: 'string' },
                    config: { $ref: '#/components/schemas/AgentRuntimeRepoOverride' },
                  },
                },
              },
            },
          ],
        },

        GetEffectiveAgentRuntimeConfigSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    repoFullName: { type: 'string' },
                    effectiveConfig: { $ref: '#/components/schemas/AgentRuntimeConfig' },
                  },
                },
              },
            },
          ],
        },

        ListRepoAgentRuntimeConfigsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AgentRuntimeRepoConfigEntry' },
                },
              },
            },
          ],
        },

        AgentSessionToolRule: {
          type: 'object',
          properties: {
            toolKey: { type: 'string' },
            mode: {
              type: 'string',
              enum: ['allow', 'require_approval', 'deny'],
            },
          },
          required: ['toolKey', 'mode'],
        },

        AgentSessionControlPlaneConfig: {
          type: 'object',
          properties: {
            systemPrompt: { type: 'string', maxLength: 50000 },
            appendSystemPrompt: { type: 'string', maxLength: 50000 },
            maxIterations: { type: 'integer', minimum: 1 },
            workspaceToolDiscoveryTimeoutMs: { type: 'integer', minimum: 1 },
            workspaceToolExecutionTimeoutMs: { type: 'integer', minimum: 1 },
            toolRules: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentSessionToolRule' },
            },
          },
          additionalProperties: false,
        },

        EffectiveAgentSessionControlPlaneConfig: {
          type: 'object',
          properties: {
            systemPrompt: { type: 'string', minLength: 1, maxLength: 50000 },
            appendSystemPrompt: { type: 'string', maxLength: 50000 },
            maxIterations: { type: 'integer', minimum: 1 },
            workspaceToolDiscoveryTimeoutMs: { type: 'integer', minimum: 1 },
            workspaceToolExecutionTimeoutMs: { type: 'integer', minimum: 1 },
            toolRules: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentSessionToolRule' },
            },
          },
          required: [
            'systemPrompt',
            'maxIterations',
            'workspaceToolDiscoveryTimeoutMs',
            'workspaceToolExecutionTimeoutMs',
            'toolRules',
          ],
          additionalProperties: false,
        },

        AgentSessionStringRecord: {
          type: 'object',
          propertyNames: {
            minLength: 1,
          },
          additionalProperties: {
            type: 'string',
            minLength: 1,
          },
        },

        AgentSessionResourceRequirements: {
          type: 'object',
          properties: {
            requests: { $ref: '#/components/schemas/AgentSessionStringRecord' },
            limits: { $ref: '#/components/schemas/AgentSessionStringRecord' },
          },
          additionalProperties: false,
        },

        AgentSessionWorkspaceStorageSettings: {
          type: 'object',
          properties: {
            defaultSize: { type: 'string', minLength: 1, maxLength: 64 },
            allowedSizes: {
              type: 'array',
              items: { type: 'string', minLength: 1, maxLength: 64 },
              uniqueItems: true,
            },
            allowClientOverride: { type: 'boolean' },
            accessMode: { type: 'string', enum: ['ReadWriteOnce', 'ReadWriteMany'] },
          },
          additionalProperties: false,
        },

        AgentSessionCleanupSettings: {
          type: 'object',
          properties: {
            activeIdleSuspendMs: { type: 'integer', minimum: 1 },
            startingTimeoutMs: { type: 'integer', minimum: 1 },
            hibernatedRetentionMs: { type: 'integer', minimum: 1 },
            intervalMs: { type: 'integer', minimum: 1 },
            redisTtlSeconds: { type: 'integer', minimum: 1 },
          },
          additionalProperties: false,
        },

        AgentSessionDurabilitySettings: {
          type: 'object',
          properties: {
            runExecutionLeaseMs: { type: 'integer', minimum: 1 },
            queuedRunDispatchStaleMs: { type: 'integer', minimum: 1 },
            dispatchRecoveryLimit: { type: 'integer', minimum: 1 },
            maxDurablePayloadBytes: { type: 'integer', minimum: 1 },
            payloadPreviewBytes: { type: 'integer', minimum: 1 },
            fileChangePreviewChars: { type: 'integer', minimum: 1 },
          },
          additionalProperties: false,
        },

        AgentSessionRuntimeSettings: {
          type: 'object',
          properties: {
            workspaceImage: { type: 'string', minLength: 1, maxLength: 2048 },
            workspaceEditorImage: { type: 'string', minLength: 1, maxLength: 2048 },
            workspaceGatewayImage: { type: 'string', minLength: 1, maxLength: 2048 },
            scheduling: {
              type: 'object',
              properties: {
                nodeSelector: {
                  $ref: '#/components/schemas/AgentSessionStringRecord',
                },
                keepAttachedServicesOnSessionNode: { type: 'boolean' },
              },
              additionalProperties: false,
            },
            readiness: {
              type: 'object',
              properties: {
                timeoutMs: { type: 'integer', minimum: 0 },
                pollMs: { type: 'integer', minimum: 0 },
              },
              additionalProperties: false,
            },
            resources: {
              type: 'object',
              properties: {
                workspace: {
                  $ref: '#/components/schemas/AgentSessionResourceRequirements',
                },
                editor: {
                  $ref: '#/components/schemas/AgentSessionResourceRequirements',
                },
                workspaceGateway: {
                  $ref: '#/components/schemas/AgentSessionResourceRequirements',
                },
              },
              additionalProperties: false,
            },
            workspaceStorage: { $ref: '#/components/schemas/AgentSessionWorkspaceStorageSettings' },
            cleanup: { $ref: '#/components/schemas/AgentSessionCleanupSettings' },
            durability: { $ref: '#/components/schemas/AgentSessionDurabilitySettings' },
          },
          additionalProperties: false,
        },

        AgentSessionToolInventoryEntry: {
          type: 'object',
          properties: {
            toolKey: { type: 'string' },
            toolName: { type: 'string' },
            description: { type: 'string', nullable: true },
            serverSlug: { type: 'string' },
            serverName: { type: 'string' },
            sourceType: {
              type: 'string',
              enum: ['builtin', 'mcp'],
            },
            sourceScope: { type: 'string' },
            capabilityKey: { type: 'string' },
            approvalMode: { $ref: '#/components/schemas/AgentApprovalMode' },
            scopeRuleMode: {
              type: 'string',
              enum: ['inherit', 'allow', 'require_approval', 'deny'],
            },
            effectiveRuleMode: {
              type: 'string',
              enum: ['inherit', 'allow', 'require_approval', 'deny'],
            },
            availability: {
              type: 'string',
              enum: ['available', 'blocked_by_tool_rule', 'blocked_by_policy'],
            },
          },
          required: [
            'toolKey',
            'toolName',
            'serverSlug',
            'serverName',
            'sourceType',
            'sourceScope',
            'capabilityKey',
            'approvalMode',
            'scopeRuleMode',
            'effectiveRuleMode',
            'availability',
          ],
        },

        AgentCapabilityCatalogEntry: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
            category: {
              type: 'string',
              enum: [
                'read',
                'diagnostics',
                'workspace',
                'source_control',
                'mcp',
                'deployment',
                'network',
                'preview',
                'approval',
              ],
            },
            defaultAvailability: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            defaultApprovalMode: { $ref: '#/components/schemas/AgentApprovalMode' },
            runtimeCapabilityKey: { type: 'string' },
            toolKeys: {
              type: 'array',
              items: { type: 'string' },
            },
            resourceGrants: {
              type: 'array',
              items: { type: 'string' },
            },
            sourceKinds: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['build_context_chat', 'workspace_session', 'freeform_chat'],
              },
            },
            userSelectable: { type: 'boolean' },
          },
          required: [
            'id',
            'label',
            'description',
            'category',
            'defaultAvailability',
            'defaultApprovalMode',
            'userSelectable',
          ],
        },

        AgentCapabilityInventoryToolEntry: {
          type: 'object',
          properties: {
            toolKey: { type: 'string' },
            toolName: { type: 'string' },
            description: { type: 'string', nullable: true },
            serverSlug: { type: 'string' },
            serverName: { type: 'string' },
            sourceType: {
              type: 'string',
              enum: ['builtin', 'mcp'],
            },
            sourceScope: { type: 'string' },
          },
          required: ['toolKey', 'toolName', 'serverSlug', 'serverName', 'sourceType', 'sourceScope'],
        },

        AgentCapabilityInventoryEntry: {
          type: 'object',
          properties: {
            capabilityId: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
            category: {
              type: 'string',
              enum: [
                'read',
                'diagnostics',
                'workspace',
                'source_control',
                'mcp',
                'deployment',
                'network',
                'preview',
                'approval',
              ],
            },
            defaultAvailability: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            configuredAvailability: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            inheritedAvailability: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            effectiveAvailability: { $ref: '#/components/schemas/AgentCapabilityAvailability' },
            approvalMode: { $ref: '#/components/schemas/AgentApprovalMode' },
            runtimeCapabilityKey: { type: 'string' },
            userSelectable: { type: 'boolean' },
            toolCount: { type: 'integer', minimum: 0 },
            resourceCount: { type: 'integer', minimum: 0 },
            resourceGrants: {
              type: 'array',
              items: { type: 'string' },
            },
            tools: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentCapabilityInventoryToolEntry' },
            },
            blockedReason: {
              type: 'string',
              enum: ['admin_only', 'system_only', 'disabled'],
            },
          },
          required: [
            'capabilityId',
            'label',
            'description',
            'category',
            'defaultAvailability',
            'effectiveAvailability',
            'approvalMode',
            'userSelectable',
            'toolCount',
            'resourceCount',
            'resourceGrants',
            'tools',
          ],
        },

        AgentCapabilityGovernanceResponse: {
          type: 'object',
          properties: {
            scope: { type: 'string' },
            scopeType: {
              type: 'string',
              enum: ['global', 'repo'],
            },
            repoFullName: { type: 'string' },
            capabilityPolicy: { $ref: '#/components/schemas/AgentCapabilityPolicy' },
            inheritedCapabilityPolicy: { $ref: '#/components/schemas/AgentCapabilityPolicy' },
            effectiveCapabilityPolicy: { $ref: '#/components/schemas/AgentCapabilityPolicy' },
            capabilities: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentCapabilityInventoryEntry' },
            },
          },
          required: ['scope', 'scopeType', 'capabilityPolicy', 'effectiveCapabilityPolicy', 'capabilities'],
        },

        UpdateAdminAgentCapabilitiesRequest: {
          type: 'object',
          properties: {
            capabilityPolicy: { $ref: '#/components/schemas/AgentCapabilityPolicy' },
          },
          required: ['capabilityPolicy'],
          additionalProperties: false,
        },

        GetAdminCustomAgentCreationPolicySuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    customAgentCreationPolicy: { $ref: '#/components/schemas/CustomAgentCreationPolicy' },
                  },
                  required: ['customAgentCreationPolicy'],
                },
              },
            },
          ],
        },

        UpdateAdminCustomAgentCreationPolicyRequest: {
          type: 'object',
          properties: {
            customAgentCreationPolicy: { $ref: '#/components/schemas/CustomAgentCreationPolicy' },
          },
          required: ['customAgentCreationPolicy'],
          additionalProperties: false,
        },

        GetGlobalAgentSessionConfigSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/AgentSessionControlPlaneConfig' },
              },
            },
          ],
        },

        GetEffectiveGlobalAgentSessionConfigSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  $ref: '#/components/schemas/EffectiveAgentSessionControlPlaneConfig',
                },
              },
            },
          ],
        },

        GetGlobalAgentSessionRuntimeConfigSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/AgentSessionRuntimeSettings' },
              },
            },
          ],
        },

        GetRepoAgentSessionConfigSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    repoFullName: { type: 'string' },
                    config: { $ref: '#/components/schemas/AgentSessionControlPlaneConfig' },
                  },
                  required: ['repoFullName', 'config'],
                },
              },
            },
          ],
        },

        GetAdminAgentToolInventorySuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AgentSessionToolInventoryEntry' },
                },
              },
            },
          ],
        },

        GetAdminAgentCapabilitiesSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/AgentCapabilityGovernanceResponse' },
              },
            },
          ],
        },

        // ===================================================================
        // AI Runtime Config Schemas
        // ===================================================================

        AIConfigStatus: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            provider: { type: 'string' },
            configured: { type: 'boolean' },
          },
          required: ['enabled'],
        },

        GetAIConfigSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/AIConfigStatus' },
              },
              required: ['data'],
            },
          ],
        },

        // ===================================================================
        // MCP Server Config Schemas
        // ===================================================================

        McpDiscoveredTool: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            inputSchema: { type: 'object' },
            annotations: {
              type: 'object',
              properties: {
                readOnlyHint: { type: 'boolean' },
                destructiveHint: { type: 'boolean' },
                openWorldHint: { type: 'boolean' },
              },
            },
          },
          required: ['name', 'inputSchema'],
        },

        McpTransportConfig: {
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['http'] },
                url: { type: 'string', example: 'https://mcp.example.com/v1/mcp' },
                headers: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                },
              },
              required: ['type', 'url'],
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['sse'] },
                url: { type: 'string', example: 'https://mcp.example.com/sse' },
                headers: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                },
              },
              required: ['type', 'url'],
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['stdio'] },
                command: { type: 'string', example: 'npx' },
                args: {
                  type: 'array',
                  items: { type: 'string' },
                  example: ['-y', '@example/mcp-server'],
                },
                env: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                },
              },
              required: ['type', 'command'],
            },
          ],
        },

        McpSharedConnectionConfig: {
          type: 'object',
          properties: {
            headers: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Shared header values. Redacted in responses.',
            },
            query: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
            env: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
            defaultArgs: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
        },

        McpConfigField: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
            placeholder: { type: 'string' },
            required: { type: 'boolean' },
            inputType: { type: 'string', enum: ['text', 'password', 'email', 'url'] },
          },
          required: ['key', 'label'],
        },

        McpConfigBinding: {
          oneOf: [
            {
              type: 'object',
              properties: {
                target: { type: 'string', enum: ['header'] },
                key: { type: 'string' },
                fieldKey: { type: 'string' },
                format: { type: 'string', enum: ['plain', 'bearer'] },
              },
              required: ['target', 'key', 'fieldKey'],
            },
            {
              type: 'object',
              properties: {
                target: { type: 'string', enum: ['header'] },
                key: { type: 'string' },
                format: { type: 'string', enum: ['basic'] },
                usernameFieldKey: { type: 'string' },
                passwordFieldKey: { type: 'string' },
              },
              required: ['target', 'key', 'format', 'usernameFieldKey', 'passwordFieldKey'],
            },
            {
              type: 'object',
              properties: {
                target: { type: 'string', enum: ['query', 'env', 'defaultArg'] },
                key: { type: 'string' },
                fieldKey: { type: 'string' },
              },
              required: ['target', 'key', 'fieldKey'],
            },
          ],
        },

        McpFieldSchema: {
          type: 'object',
          properties: {
            fields: {
              type: 'array',
              items: { $ref: '#/components/schemas/McpConfigField' },
            },
            bindings: {
              type: 'array',
              items: { $ref: '#/components/schemas/McpConfigBinding' },
            },
          },
          required: ['fields', 'bindings'],
        },

        McpAuthConfig: {
          oneOf: [
            {
              type: 'object',
              properties: {
                mode: { type: 'string', enum: ['none'] },
              },
              required: ['mode'],
            },
            {
              type: 'object',
              properties: {
                mode: { type: 'string', enum: ['user-fields'] },
                schema: { $ref: '#/components/schemas/McpFieldSchema' },
              },
              required: ['mode', 'schema'],
            },
            {
              type: 'object',
              properties: {
                mode: { type: 'string', enum: ['shared-fields'] },
                schema: { $ref: '#/components/schemas/McpFieldSchema' },
              },
              required: ['mode', 'schema'],
            },
            {
              type: 'object',
              properties: {
                mode: { type: 'string', enum: ['oauth'] },
                provider: { type: 'string', enum: ['generic-oauth2.1'] },
                scope: { type: 'string' },
                resource: { type: 'string' },
                clientName: { type: 'string' },
                instructions: { type: 'string' },
              },
              required: ['mode', 'provider'],
            },
          ],
        },

        McpPresetField: {
          allOf: [
            { $ref: '#/components/schemas/McpConfigField' },
            {
              type: 'object',
              properties: {
                target: { type: 'string', enum: ['header', 'query', 'env', 'defaultArg'] },
                targetKey: { type: 'string' },
              },
              required: ['target', 'targetKey'],
            },
          ],
        },

        McpPreset: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
            transportType: { type: 'string', enum: ['http', 'sse', 'stdio'] },
            endpointPlaceholder: { type: 'string', nullable: true },
            commandPlaceholder: { type: 'string', nullable: true },
            authConfig: { $ref: '#/components/schemas/McpAuthConfig' },
            sharedFields: {
              type: 'array',
              items: { $ref: '#/components/schemas/McpPresetField' },
            },
          },
          required: ['key', 'label', 'description', 'transportType', 'authConfig'],
        },

        McpServerConfig: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            slug: {
              type: 'string',
              description: 'Unique identifier (lowercase alphanumeric and hyphens, max 100 chars).',
              example: 'example-mcp',
            },
            name: { type: 'string', example: 'Example MCP' },
            description: { type: 'string', nullable: true },
            scope: { type: 'string', example: 'global' },
            preset: { type: 'string', nullable: true, example: 'oauth-http' },
            transport: { $ref: '#/components/schemas/McpTransportConfig' },
            sharedConfig: { $ref: '#/components/schemas/McpSharedConnectionConfig' },
            authConfig: { $ref: '#/components/schemas/McpAuthConfig' },
            enabled: { type: 'boolean' },
            timeout: { type: 'integer', example: 30000 },
            sharedDiscoveredTools: {
              type: 'array',
              items: { $ref: '#/components/schemas/McpDiscoveredTool' },
            },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
          required: [
            'id',
            'slug',
            'name',
            'scope',
            'preset',
            'transport',
            'sharedConfig',
            'authConfig',
            'enabled',
            'timeout',
            'sharedDiscoveredTools',
          ],
        },

        CreateMcpServerConfigRequest: {
          type: 'object',
          properties: {
            slug: { type: 'string', example: 'example-mcp' },
            name: { type: 'string', example: 'Example MCP' },
            transport: { $ref: '#/components/schemas/McpTransportConfig' },
            scope: { type: 'string', default: 'global' },
            description: { type: 'string' },
            preset: { type: 'string', nullable: true },
            sharedConfig: { $ref: '#/components/schemas/McpSharedConnectionConfig' },
            authConfig: { $ref: '#/components/schemas/McpAuthConfig' },
            enabled: { type: 'boolean', default: true },
            timeout: { type: 'integer', default: 30000 },
          },
          required: ['slug', 'name', 'transport'],
        },

        UpdateMcpServerConfigRequest: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            preset: { type: 'string', nullable: true },
            transport: { $ref: '#/components/schemas/McpTransportConfig' },
            sharedConfig: { $ref: '#/components/schemas/McpSharedConnectionConfig' },
            authConfig: { $ref: '#/components/schemas/McpAuthConfig' },
            enabled: { type: 'boolean' },
            timeout: { type: 'integer' },
          },
        },

        GetMcpServerConfigSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/McpServerConfig' },
              },
              required: ['data'],
            },
          ],
        },

        ListMcpServerConfigsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/McpServerConfig' },
                },
              },
              required: ['data'],
            },
          ],
        },

        AgentMcpConnection: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string', nullable: true },
            scope: { type: 'string' },
            preset: { type: 'string', nullable: true },
            transport: { $ref: '#/components/schemas/McpTransportConfig' },
            sharedConfig: { $ref: '#/components/schemas/McpSharedConnectionConfig' },
            authConfig: { $ref: '#/components/schemas/McpAuthConfig' },
            connectionRequired: { type: 'boolean' },
            configured: { type: 'boolean' },
            stale: { type: 'boolean' },
            configuredFieldKeys: {
              type: 'array',
              items: { type: 'string' },
            },
            validationError: { type: 'string', nullable: true },
            validatedAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
            discoveredTools: {
              type: 'array',
              items: { $ref: '#/components/schemas/McpDiscoveredTool' },
            },
            sharedDiscoveredTools: {
              type: 'array',
              items: { $ref: '#/components/schemas/McpDiscoveredTool' },
            },
          },
          required: [
            'slug',
            'name',
            'description',
            'scope',
            'preset',
            'transport',
            'sharedConfig',
            'authConfig',
            'connectionRequired',
            'configured',
            'stale',
            'configuredFieldKeys',
            'validationError',
            'validatedAt',
            'updatedAt',
            'discoveredTools',
            'sharedDiscoveredTools',
          ],
        },

        AgentMcpConnectionState: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            scope: { type: 'string' },
            authMode: { type: 'string', enum: ['none', 'fields', 'oauth'] },
            configured: { type: 'boolean' },
            stale: { type: 'boolean' },
            configuredFieldKeys: {
              type: 'array',
              items: { type: 'string' },
            },
            validationError: { type: 'string', nullable: true },
            validatedAt: { type: 'string', format: 'date-time', nullable: true },
            discoveredTools: {
              type: 'array',
              items: { $ref: '#/components/schemas/McpDiscoveredTool' },
            },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: [
            'slug',
            'scope',
            'authMode',
            'configured',
            'stale',
            'configuredFieldKeys',
            'validationError',
            'validatedAt',
            'discoveredTools',
            'updatedAt',
          ],
        },

        UpsertAgentMcpConnectionBody: {
          type: 'object',
          properties: {
            values: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
          required: ['values'],
        },

        StartAgentMcpConnectionOAuthResult: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['AUTHORIZED', 'REDIRECT'] },
            authorizationUrl: { type: 'string', nullable: true },
          },
          required: ['status', 'authorizationUrl'],
        },

        StartAgentMcpConnectionOAuthSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/StartAgentMcpConnectionOAuthResult' },
              },
              required: ['data'],
            },
          ],
        },

        GetAgentMcpConnectionSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/AgentMcpConnectionState' },
              },
              required: ['data'],
            },
          ],
        },

        ListMcpPresetsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/McpPreset' },
                },
              },
              required: ['data'],
            },
          ],
        },

        ListAgentMcpConnectionsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AgentMcpConnection' },
                },
              },
              required: ['data'],
            },
          ],
        },

        GetAgentSettingsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/AgentSettings' },
              },
              required: ['data'],
            },
          ],
        },

        GetAdminAgentSessionsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                metadata: { $ref: '#/components/schemas/ResponseMetadata' },
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AgentAdminSessionSummary' },
                },
              },
              required: ['data'],
            },
          ],
        },

        GetAdminAgentSessionSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/AgentAdminSessionDetail' },
              },
              required: ['data'],
            },
          ],
        },

        GetAdminAgentThreadConversationSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/AgentAdminThreadConversation' },
              },
              required: ['data'],
            },
          ],
        },

        GetAdminAgentMcpServersSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AgentAdminMcpServerCoverage' },
                },
              },
              required: ['data'],
            },
          ],
        },

        GetAdminAgentMcpServerUsersSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AgentAdminMcpServerUserConnection' },
                },
              },
              required: ['data'],
            },
          ],
        },
      },
    },
  },
  apis: ['./src/app/api/**/*.ts'],
};
