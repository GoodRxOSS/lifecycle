/**
 * Copyright 2025 GoodRx, Inc.
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

import { kedaScaleToZero } from './keda';
import { deployment } from './deployment';
import { docker } from './docker';
import { webhooks } from './webhooks';

const schema_1_0_0 = {
  id: 'schema-1.0.0',
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'string', format: 'schema100Version' },
    environment: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabledFeatures: { type: 'array' },
        autoDeploy: { type: 'boolean' },
        githubDeployments: { type: 'boolean' },
        useGithubStatusComment: { type: 'boolean' },
        defaultServices: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              repository: { type: 'string' },
              branch: { type: 'string' },
              serviceId: { type: 'number' },
            },
            required: ['name'],
          },
        },
        optionalServices: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              repository: { type: 'string' },
              branch: { type: 'string' },
              serviceId: { type: 'number' },
            },
            required: ['name'],
          },
        },
        webhooks,
      },
    },
    services: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          appShort: { type: 'string' },
          defaultUUID: { type: 'string' },
          requires: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
              },
              required: ['name'],
            },
          },
          deploymentDependsOn: {
            type: 'array',
            minItems: 0,
            items: {
              type: 'string',
            },
          },
          kedaScaleToZero,
          helm: {
            type: 'object',
            additionalProperties: true,
            properties: {
              cfStepType: { type: 'string' },
              type: { type: 'string' },
              args: { type: 'string' },
              version: { type: 'string' },
              action: { type: 'string' },
              repository: { type: 'string' },
              branchName: { type: 'string' },
              chart: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  repoUrl: { type: 'string' },
                  version: { type: 'string' },
                  values: { type: 'array', items: { type: 'string' } },
                  valueFiles: { type: 'array', items: { type: 'string' } },
                },
                required: ['name'],
              },
              grpc: { type: 'boolean' },
              disableIngressHost: { type: 'boolean' },
              overrideDefaultIpWhitelist: { type: 'boolean' },
              docker,
            },
          },
          codefresh: {
            type: 'object',
            additionalProperties: false,
            properties: {
              repository: { type: 'string' },
              branchName: { type: 'string' },
              env: { type: 'object' },
              deploy: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  pipelineId: { type: 'string' },
                  trigger: { type: 'string' },
                },
              },
              destroy: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  pipelineId: { type: 'string' },
                  trigger: { type: 'string' },
                },
              },
              deployment,
            },
            required: ['repository', 'branchName'],
          },
          github: {
            type: 'object',
            additionalProperties: false,
            properties: {
              repository: { type: 'string' },
              branchName: { type: 'string' },
              docker,
              deployment,
            },
            required: ['repository', 'branchName', 'docker'],
          },
          docker: {
            type: 'object',
            additionalProperties: false,
            properties: {
              dockerImage: { type: 'string' },
              defaultTag: { type: 'string' },
              command: { type: 'string' },
              arguments: { type: 'string' },
              env: { type: 'object' },
              ports: { type: 'array' },
              deployment,
            },
            required: ['dockerImage', 'defaultTag'],
          },
          externalHttp: {
            type: 'object',
            additionalProperties: false,
            properties: {
              defaultInternalHostname: { type: 'string' },
              defaultPublicUrl: { type: 'string' },
            },
            required: ['defaultInternalHostname', 'defaultPublicUrl'],
          },
          auroraRestore: {
            type: 'object',
            additionalProperties: false,
            properties: {
              command: { type: 'string' },
              arguments: { type: 'string' },
            },
            required: ['command', 'arguments'],
          },
          configuration: {
            type: 'object',
            additionalProperties: false,
            properties: {
              defaultTag: { type: 'string' },
              branchName: { type: 'string' },
            },
            required: ['defaultTag', 'branchName'],
          },
        },
        required: ['name'],
      },
    },
  },
};
export { schema_1_0_0 };
