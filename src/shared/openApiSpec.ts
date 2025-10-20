import { OAS3Options } from 'swagger-jsdoc';
import { BuildStatus } from './constants';

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
            totalItems: { type: 'integer' },
            totalPages: { type: 'integer' },
            currentPage: { type: 'integer' },
            limit: { type: 'integer' },
          },
        },

        // ===================================================================
        // Resource-Specific Schemas
        // ===================================================================

        // =================================================================
        // Build Schemas
        // =================================================================

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
            uuid: { type: 'string', example: 'white-poetry-596195' },
            status: { $ref: '#/components/schemas/BuildStatus' },
            namespace: { type: 'string', example: 'env-white-poetry-596195' },
            pullRequest: { $ref: '#/components/schemas/PullRequest' },
          },
          required: ['id', 'uuid', 'status', 'namespace', 'pullRequest'],
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
          },
          required: ['id', 'title', 'fullName', 'githubLogin'],
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
      },
    },
  },
  apis: ['./src/app/api/**/*.ts'],
};
