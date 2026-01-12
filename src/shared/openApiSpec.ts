import { OAS3Options } from 'swagger-jsdoc';
import { BuildStatus, DeployStatus } from './constants';

export const openApiSpecificationForV2Api: OAS3Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Lifecycle API',
      version: '2.0.0',
      description: 'API documentation for lifecycle',
    },
    components: {
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

        // ===================================================================
        // Resource-Specific Schemas
        // ===================================================================

        /**
         * @description Log streaming information for a build job.
         */
        LogStreamResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['Active', 'Complete', 'Failed', 'NotFound', 'Pending'] },
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
          },
          required: ['status', 'streamingRequired', 'podName', 'websocket', 'containers', 'message', 'error'],
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
          },
          required: ['jobName', 'buildUuid', 'sha', 'status', 'engine'],
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
            namespace: { type: 'string', example: 'env-white-poetry-596195' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
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
            'namespace',
            'manifest',
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
          },
          required: ['name'],
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
            active: { type: 'boolean', example: true },
            branchName: { type: 'string', example: 'main' },
            publicUrl: { type: 'string', example: 'http://myapp.example.com' },
            deployableId: { type: 'integer' },
            deployable: { $ref: '#/components/schemas/Deployable' },
          },
          required: ['id', 'uuid', 'status', 'active', 'deployableId', 'deployable'],
        },

        /**
         * @description A Pull Request associated with a Build.
         */
        PullRequest: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            title: { type: 'string', example: 'Add new feature' },
            fullName: { type: 'string', example: 'goodrx/lifecycle' },
            githubLogin: { type: 'string', example: 'lifecycle-bot' },
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
      },
    },
  },
  apis: ['./src/app/api/**/*.ts'],
};
