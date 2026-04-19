import { OAS3Options } from 'swagger-jsdoc';
import { BuildKind, BuildStatus, DeployStatus, DeployTypes } from './constants';

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
            githubRepositoryId: { type: 'integer' },
            fullName: { type: 'string' },
            htmlUrl: { type: 'string', nullable: true },
          },
          required: ['githubRepositoryId', 'fullName'],
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
        },

        AgentUIMessageMetadata: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', nullable: true },
            threadId: { type: 'string', nullable: true },
            runId: { type: 'string', nullable: true },
            provider: { type: 'string', nullable: true },
            model: { type: 'string', nullable: true },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            completedAt: { type: 'string', format: 'date-time', nullable: true },
            usage: { type: 'object', nullable: true, additionalProperties: true },
          },
          additionalProperties: true,
        },

        AgentUIMessagePart: {
          type: 'object',
          properties: {
            type: { type: 'string' },
          },
          required: ['type'],
          additionalProperties: true,
        },

        AgentUIMessage: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
            metadata: { $ref: '#/components/schemas/AgentUIMessageMetadata' },
            parts: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentUIMessagePart' },
            },
          },
          required: ['id', 'role', 'parts'],
          additionalProperties: true,
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

        AgentSessionSummary: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            buildUuid: { type: 'string', nullable: true },
            baseBuildUuid: { type: 'string', nullable: true },
            buildKind: { $ref: '#/components/schemas/BuildKind' },
            userId: { type: 'string' },
            ownerGithubUsername: { type: 'string', nullable: true },
            podName: { type: 'string' },
            namespace: { type: 'string' },
            pvcName: { type: 'string' },
            model: { type: 'string' },
            status: { type: 'string', enum: ['starting', 'active', 'ended', 'error'] },
            repo: { type: 'string', nullable: true },
            branch: { type: 'string', nullable: true },
            primaryRepo: { type: 'string', nullable: true },
            primaryBranch: { type: 'string', nullable: true },
            services: { type: 'array', items: { type: 'string' } },
            workspaceRepos: { type: 'array', items: { type: 'object', additionalProperties: true } },
            selectedServices: { type: 'array', items: { type: 'object', additionalProperties: true } },
            startupFailure: { type: 'object', additionalProperties: true, nullable: true },
            lastActivity: { type: 'string', format: 'date-time', nullable: true },
            endedAt: { type: 'string', format: 'date-time', nullable: true },
            threadCount: { type: 'integer' },
            pendingActionsCount: { type: 'integer' },
            lastRunAt: { type: 'string', format: 'date-time', nullable: true },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
            editorUrl: { type: 'string' },
          },
          required: [
            'id',
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

        AgentRun: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            threadId: { type: 'string', nullable: true },
            sessionId: { type: 'string', nullable: true },
            status: {
              type: 'string',
              enum: [
                'queued',
                'running',
                'waiting_for_approval',
                'waiting_for_input',
                'completed',
                'failed',
                'cancelled',
              ],
            },
            provider: { type: 'string' },
            model: { type: 'string' },
            queuedAt: { type: 'string', format: 'date-time', nullable: true },
            startedAt: { type: 'string', format: 'date-time', nullable: true },
            completedAt: { type: 'string', format: 'date-time', nullable: true },
            cancelledAt: { type: 'string', format: 'date-time', nullable: true },
            usageSummary: { type: 'object', additionalProperties: true },
            policySnapshot: { type: 'object', additionalProperties: true },
            streamState: { type: 'object', additionalProperties: true },
            error: { type: 'object', additionalProperties: true, nullable: true },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: ['id', 'status', 'provider', 'model', 'usageSummary', 'policySnapshot', 'streamState'],
        },

        AgentPendingAction: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            threadId: { type: 'string', nullable: true },
            runId: { type: 'string', nullable: true },
            kind: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'approved', 'denied'] },
            capabilityKey: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            payload: { type: 'object', additionalProperties: true },
            resolution: { type: 'object', additionalProperties: true, nullable: true },
            resolvedAt: { type: 'string', format: 'date-time', nullable: true },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
          required: ['id', 'kind', 'status', 'capabilityKey', 'title', 'description', 'payload'],
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
            session: { $ref: '#/components/schemas/AgentSessionSummary' },
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
            session: { $ref: '#/components/schemas/AgentSessionSummary' },
            thread: { $ref: '#/components/schemas/AgentAdminThreadSummary' },
            messages: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentUIMessage' },
            },
            runs: {
              type: 'array',
              items: { $ref: '#/components/schemas/AgentRun' },
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
          required: ['session', 'thread', 'messages', 'runs', 'pendingActions', 'toolExecutions'],
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
        // AI Agent Config Schemas
        // ===================================================================

        AIAgentModelConfig: {
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

        AIAgentProviderConfig: {
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
              items: { $ref: '#/components/schemas/AIAgentModelConfig' },
            },
          },
          required: ['name', 'enabled', 'apiKeyEnvVar', 'models'],
        },

        AIAgentConfig: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            approvalPolicy: { $ref: '#/components/schemas/AgentApprovalPolicy' },
            providers: {
              type: 'array',
              items: { $ref: '#/components/schemas/AIAgentProviderConfig' },
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

        AIAgentRepoOverride: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            maxMessagesPerSession: { type: 'integer' },
            sessionTTL: { type: 'integer' },
            approvalPolicy: { $ref: '#/components/schemas/AgentApprovalPolicy' },
            additiveRules: { type: 'array', items: { type: 'string' } },
            systemPromptOverride: { type: 'string', maxLength: 50000 },
            excludedTools: { type: 'array', items: { type: 'string' } },
            excludedFilePatterns: { type: 'array', items: { type: 'string' } },
            allowedWritePatterns: { type: 'array', items: { type: 'string' } },
          },
        },

        AIAgentAdditiveRulesUpdateRequest: {
          type: 'object',
          properties: {
            additiveRules: { type: 'array', items: { type: 'string' } },
          },
          required: ['additiveRules'],
          additionalProperties: false,
        },

        AIAgentApprovalPolicyUpdateRequest: {
          type: 'object',
          properties: {
            approvalPolicy: { $ref: '#/components/schemas/AgentApprovalPolicy' },
          },
          required: ['approvalPolicy'],
          additionalProperties: false,
        },

        AIAgentConfigPatchRequest: {
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

        AIAgentRepoConfigEntry: {
          type: 'object',
          properties: {
            repositoryFullName: { type: 'string' },
            config: { $ref: '#/components/schemas/AIAgentRepoOverride' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },

        GetGlobalAIAgentConfigSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/AIAgentConfig' },
              },
            },
          ],
        },

        GetRepoAIAgentConfigSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    repoFullName: { type: 'string' },
                    config: { $ref: '#/components/schemas/AIAgentRepoOverride' },
                  },
                },
              },
            },
          ],
        },

        GetEffectiveAIAgentConfigSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    repoFullName: { type: 'string' },
                    effectiveConfig: { $ref: '#/components/schemas/AIAgentConfig' },
                  },
                },
              },
            },
          ],
        },

        ListRepoAIAgentConfigsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/AIAgentRepoConfigEntry' },
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

        FeedbackEntry: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            feedbackType: {
              type: 'string',
              enum: ['message', 'conversation'],
            },
            buildUuid: { type: 'string' },
            rating: {
              type: 'string',
              enum: ['up', 'down'],
            },
            text: { type: 'string', nullable: true },
            userIdentifier: { type: 'string', nullable: true },
            repo: { type: 'string' },
            prNumber: { type: 'integer', nullable: true },
            messageId: { type: 'integer', nullable: true },
            messagePreview: { type: 'string', nullable: true },
            costUsd: { type: 'number', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
          },
          required: [
            'id',
            'feedbackType',
            'buildUuid',
            'rating',
            'text',
            'userIdentifier',
            'repo',
            'prNumber',
            'messageId',
            'messagePreview',
            'costUsd',
            'createdAt',
          ],
        },

        FeedbackListPaginationMetadata: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            limit: { type: 'integer' },
            totalCount: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
          required: ['page', 'limit', 'totalCount', 'totalPages'],
        },

        FeedbackListResponseMetadata: {
          type: 'object',
          properties: {
            pagination: { $ref: '#/components/schemas/FeedbackListPaginationMetadata' },
          },
          required: ['pagination'],
        },

        GetAdminFeedbackListSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/FeedbackEntry' },
                },
                metadata: { $ref: '#/components/schemas/FeedbackListResponseMetadata' },
              },
              required: ['data', 'metadata'],
            },
          ],
        },

        ConversationReplayMessage: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            role: {
              type: 'string',
              enum: ['user', 'assistant', 'system'],
            },
            content: { type: 'string' },
            timestamp: { type: 'integer' },
            metadata: {
              type: 'object',
              additionalProperties: true,
            },
          },
          required: ['id', 'role', 'content', 'timestamp', 'metadata'],
        },

        FeedbackConversationReplayData: {
          type: 'object',
          properties: {
            feedbackType: {
              type: 'string',
              enum: ['message', 'conversation'],
            },
            feedbackId: { type: 'integer' },
            buildUuid: { type: 'string' },
            repo: { type: 'string' },
            ratedMessageId: { type: 'integer', nullable: true },
            feedbackRating: {
              type: 'string',
              enum: ['up', 'down'],
            },
            feedbackText: { type: 'string', nullable: true },
            feedbackUserIdentifier: { type: 'string', nullable: true },
            feedbackCreatedAt: { type: 'string', format: 'date-time' },
            conversation: {
              type: 'object',
              properties: {
                messageCount: { type: 'integer' },
                model: { type: 'string', nullable: true },
                messages: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/ConversationReplayMessage' },
                },
              },
              required: ['messageCount', 'model', 'messages'],
            },
          },
          required: [
            'feedbackType',
            'feedbackId',
            'buildUuid',
            'repo',
            'ratedMessageId',
            'feedbackRating',
            'feedbackText',
            'feedbackUserIdentifier',
            'feedbackCreatedAt',
            'conversation',
          ],
        },

        GetAdminFeedbackConversationSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: { $ref: '#/components/schemas/FeedbackConversationReplayData' },
              },
              required: ['data'],
            },
          ],
        },

        // ===================================================================
        // AI Chat Schemas
        // ===================================================================

        AIModel: {
          type: 'object',
          description: 'An available AI model returned by the models endpoint.',
          properties: {
            provider: { type: 'string', description: 'The LLM provider name.', example: 'anthropic' },
            modelId: {
              type: 'string',
              description: 'The model ID to pass to the chat endpoint.',
              example: 'claude-sonnet-4-20250514',
            },
            displayName: { type: 'string', example: 'Claude Sonnet' },
            default: { type: 'boolean', description: 'Whether this is the default model.' },
            maxTokens: { type: 'integer', example: 8192 },
            inputCostPerMillion: { type: 'number', description: 'Cost per million input tokens (USD).' },
            outputCostPerMillion: { type: 'number', description: 'Cost per million output tokens (USD).' },
          },
          required: ['provider', 'modelId', 'displayName', 'default', 'maxTokens'],
        },

        GetAIModelsSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    models: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/AIModel' },
                    },
                  },
                  required: ['models'],
                },
              },
              required: ['data'],
            },
          ],
        },

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

        ConversationMessage: {
          type: 'object',
          description: 'A single message in the conversation history.',
          properties: {
            role: { type: 'string', enum: ['user', 'assistant', 'system'] },
            content: { type: 'string', description: 'The message text or JSON string for structured responses.' },
            timestamp: { type: 'integer', description: 'Unix timestamp in milliseconds.' },
            isSystemAction: {
              type: 'boolean',
              description: 'True when the message was initiated by a system action rather than a user.',
            },
            activityHistory: {
              type: 'array',
              description: 'Tool call activity recorded during the assistant response.',
              items: { $ref: '#/components/schemas/ActivityHistoryEntry' },
            },
            evidenceItems: {
              type: 'array',
              description: 'Evidence references (files, commits, resources) found during investigation.',
              items: { type: 'object' },
            },
            totalInvestigationTimeMs: {
              type: 'number',
              description: 'Total wall-clock time spent generating this response.',
            },
            debugContext: { $ref: '#/components/schemas/DebugContext' },
            debugToolData: {
              type: 'array',
              description: 'Detailed tool call/result data for debugging.',
              items: { $ref: '#/components/schemas/DebugToolData' },
            },
            debugMetrics: { $ref: '#/components/schemas/DebugMetrics' },
          },
          required: ['role', 'content', 'timestamp'],
        },

        ActivityHistoryEntry: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'The activity type (tool_call, processing, thinking, error).' },
            message: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'completed', 'failed'] },
            details: {
              type: 'object',
              properties: {
                toolDurationMs: { type: 'number' },
                totalDurationMs: { type: 'number' },
              },
            },
            toolCallId: { type: 'string' },
            resultPreview: { type: 'string', description: 'Truncated preview of the tool result.' },
          },
          required: ['type', 'message'],
        },

        DebugContext: {
          type: 'object',
          description: 'Debug information about the system prompt and model used for a response.',
          properties: {
            systemPrompt: { type: 'string' },
            maskingStats: {
              type: 'object',
              nullable: true,
              properties: {
                totalTokensBefore: { type: 'integer' },
                totalTokensAfter: { type: 'integer' },
                maskedParts: { type: 'integer' },
                savedTokens: { type: 'integer' },
              },
            },
            provider: { type: 'string', description: 'LLM provider name (e.g. anthropic, openai).' },
            modelId: { type: 'string' },
          },
          required: ['systemPrompt', 'provider', 'modelId'],
        },

        DebugToolData: {
          type: 'object',
          properties: {
            toolCallId: { type: 'string' },
            toolName: { type: 'string' },
            toolArgs: { type: 'object', description: 'Arguments passed to the tool. May be truncated for storage.' },
            toolResult: { description: 'Result returned by the tool. May be truncated for storage.' },
            toolDurationMs: { type: 'number' },
          },
          required: ['toolCallId', 'toolName', 'toolArgs'],
        },

        DebugMetrics: {
          type: 'object',
          description: 'Aggregate metrics for a single AI response.',
          properties: {
            iterations: { type: 'integer', description: 'Number of orchestration loop iterations.' },
            totalToolCalls: { type: 'integer' },
            totalDurationMs: { type: 'number' },
            inputTokens: { type: 'integer' },
            outputTokens: { type: 'integer' },
            inputCostPerMillion: { type: 'number' },
            outputCostPerMillion: { type: 'number' },
          },
          required: ['iterations', 'totalToolCalls', 'totalDurationMs'],
        },

        GetAIMessagesSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    messages: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ConversationMessage' },
                    },
                    lastActivity: { type: 'integer', nullable: true },
                  },
                  required: ['messages'],
                },
              },
              required: ['data'],
            },
          ],
        },

        DeleteAISessionSuccessResponse: {
          allOf: [
            { $ref: '#/components/schemas/SuccessApiResponse' },
            {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    messagesCleared: { type: 'integer' },
                  },
                  required: ['success', 'messagesCleared'],
                },
              },
              required: ['data'],
            },
          ],
        },

        // ===================================================================
        // AI Chat SSE Event Schemas
        // ===================================================================

        SSEChunkEvent: {
          type: 'object',
          description: 'Streamed text content fragment from the AI response.',
          properties: {
            type: { type: 'string', enum: ['chunk'] },
            content: { type: 'string', description: 'A fragment of the AI response text.' },
          },
          required: ['type', 'content'],
        },

        SSEToolCallEvent: {
          type: 'object',
          description:
            'Emitted when the AI invokes a tool. The toolCallId can be correlated with a later SSEProcessingEvent.',
          properties: {
            type: { type: 'string', enum: ['tool_call'] },
            message: { type: 'string', description: 'Human-readable description of the tool being called.' },
            toolCallId: { type: 'string' },
          },
          required: ['type', 'message'],
        },

        SSEProcessingEvent: {
          type: 'object',
          description: 'Emitted when a tool call completes. Messages starting with a checkmark indicate success.',
          properties: {
            type: { type: 'string', enum: ['processing'] },
            message: { type: 'string' },
            details: {
              type: 'object',
              properties: {
                toolDurationMs: { type: 'number' },
                totalDurationMs: { type: 'number' },
              },
            },
            resultPreview: { type: 'string', description: 'Truncated preview of the tool result.' },
            toolCallId: { type: 'string', description: 'Correlates with the original SSEToolCallEvent.' },
          },
          required: ['type', 'message'],
        },

        SSEThinkingEvent: {
          type: 'object',
          description: 'Emitted when the AI is reasoning before producing output.',
          properties: {
            type: { type: 'string', enum: ['thinking'] },
            message: { type: 'string' },
          },
          required: ['type', 'message'],
        },

        SSEActivityErrorEvent: {
          type: 'object',
          description: 'Emitted for non-fatal processing errors during investigation.',
          properties: {
            type: { type: 'string', enum: ['error'] },
            message: { type: 'string' },
          },
          required: ['type', 'message'],
        },

        SSEEvidenceFileEvent: {
          type: 'object',
          description: 'A source file referenced as evidence during investigation.',
          properties: {
            type: { type: 'string', enum: ['evidence_file'] },
            toolCallId: { type: 'string' },
            filePath: { type: 'string' },
            repository: { type: 'string' },
            branch: { type: 'string' },
            lineStart: { type: 'integer' },
            lineEnd: { type: 'integer' },
            language: { type: 'string' },
          },
          required: ['type', 'toolCallId', 'filePath', 'repository'],
        },

        SSEEvidenceCommitEvent: {
          type: 'object',
          description: 'A git commit referenced as evidence during investigation.',
          properties: {
            type: { type: 'string', enum: ['evidence_commit'] },
            toolCallId: { type: 'string' },
            commitUrl: { type: 'string' },
            commitMessage: { type: 'string' },
            filePaths: { type: 'array', items: { type: 'string' } },
          },
          required: ['type', 'toolCallId', 'commitUrl', 'commitMessage', 'filePaths'],
        },

        SSEEvidenceResourceEvent: {
          type: 'object',
          description: 'A Kubernetes resource referenced as evidence during investigation.',
          properties: {
            type: { type: 'string', enum: ['evidence_resource'] },
            toolCallId: { type: 'string' },
            resourceType: { type: 'string', description: 'Kubernetes resource kind (e.g. Pod, Deployment).' },
            resourceName: { type: 'string' },
            namespace: { type: 'string' },
            status: { type: 'string' },
          },
          required: ['type', 'toolCallId', 'resourceType', 'resourceName', 'namespace'],
        },

        SSEDebugContextEvent: {
          type: 'object',
          description: 'Debug info about the system prompt and model selection for this response.',
          properties: {
            type: { type: 'string', enum: ['debug_context'] },
            systemPrompt: { type: 'string' },
            maskingStats: {
              type: 'object',
              nullable: true,
              properties: {
                totalTokensBefore: { type: 'integer' },
                totalTokensAfter: { type: 'integer' },
                maskedParts: { type: 'integer' },
                savedTokens: { type: 'integer' },
              },
            },
            provider: { type: 'string' },
            modelId: { type: 'string' },
          },
          required: ['type', 'systemPrompt', 'provider', 'modelId'],
        },

        SSEDebugToolCallEvent: {
          type: 'object',
          description: 'Raw tool invocation data for debugging.',
          properties: {
            type: { type: 'string', enum: ['debug_tool_call'] },
            toolCallId: { type: 'string' },
            toolName: { type: 'string' },
            toolArgs: { type: 'object' },
          },
          required: ['type', 'toolCallId', 'toolName', 'toolArgs'],
        },

        SSEDebugToolResultEvent: {
          type: 'object',
          description: 'Raw tool result data for debugging.',
          properties: {
            type: { type: 'string', enum: ['debug_tool_result'] },
            toolCallId: { type: 'string' },
            toolName: { type: 'string' },
            toolResult: { description: 'The raw tool result value.' },
            toolDurationMs: { type: 'number' },
          },
          required: ['type', 'toolCallId', 'toolName', 'toolResult'],
        },

        SSEDebugMetricsEvent: {
          type: 'object',
          description: 'Aggregate metrics emitted once per response.',
          properties: {
            type: { type: 'string', enum: ['debug_metrics'] },
            iterations: { type: 'integer' },
            totalToolCalls: { type: 'integer' },
            totalDurationMs: { type: 'number' },
            inputTokens: { type: 'integer' },
            outputTokens: { type: 'integer' },
            inputCostPerMillion: { type: 'number' },
            outputCostPerMillion: { type: 'number' },
          },
          required: ['type', 'iterations', 'totalToolCalls', 'totalDurationMs'],
        },

        SSECompleteEvent: {
          type: 'object',
          description: 'Signals the end of a plain-text AI response. This is the final event in the stream.',
          properties: {
            type: { type: 'string', enum: ['complete'] },
            totalInvestigationTimeMs: { type: 'number' },
            assistantTimestamp: {
              type: 'number',
              description: 'Server-side timestamp (epoch ms) used for persisting the final assistant message.',
            },
          },
          required: ['type', 'totalInvestigationTimeMs'],
        },

        SSECompleteJsonEvent: {
          type: 'object',
          description:
            'Signals the end of a structured JSON AI response (e.g. investigation_complete). ' +
            'The content field contains the full JSON string. Sent before SSECompleteEvent.',
          properties: {
            type: { type: 'string', enum: ['complete_json'] },
            content: { type: 'string', description: 'The full JSON response as a string.' },
            preamble: {
              type: 'string',
              description:
                'Optional plain-text summary emitted before structured JSON when mixed text+JSON model output is split.',
            },
            totalInvestigationTimeMs: { type: 'number' },
          },
          required: ['type', 'content', 'totalInvestigationTimeMs'],
        },

        SSEErrorEvent: {
          type: 'object',
          description:
            'Streamed error event. Errors during SSE streaming are sent as events (not HTTP errors) ' +
            'because the HTTP 200 status has already been committed.',
          properties: {
            error: { type: 'boolean', enum: [true] },
            userMessage: { type: 'string', description: 'Human-readable error description.' },
            category: {
              type: 'string',
              enum: ['rate-limited', 'transient', 'deterministic', 'ambiguous'],
              description:
                'Error classification. rate-limited: provider rate limit hit (retryable). ' +
                'transient: temporary provider outage (retryable). ' +
                'deterministic: auth error, bad request, or config issue (not retryable). ' +
                'ambiguous: unknown error state (retryable).',
            },
            suggestedAction: {
              type: 'string',
              enum: ['retry', 'switch-model', 'check-config'],
              nullable: true,
              description: 'Recommended client action.',
            },
            retryAfter: {
              type: 'number',
              nullable: true,
              description: 'Seconds to wait before retrying (only for rate-limited errors).',
            },
            modelName: { type: 'string' },
            code: {
              type: 'string',
              description:
                'Machine-readable error code. Known codes: AI_AGENT_DISABLED, CONTEXT_ERROR, ' +
                'LLM_INIT_ERROR, LLM_API_ERROR, CIRCUIT_BREAKER_OPEN.',
            },
          },
          required: ['error', 'userMessage', 'category', 'suggestedAction', 'retryAfter', 'modelName'],
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
                  items: { $ref: '#/components/schemas/AgentSessionSummary' },
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
