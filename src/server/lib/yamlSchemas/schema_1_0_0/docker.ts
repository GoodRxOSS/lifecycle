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

export const docker = {
  type: 'object',
  additionalProperties: false,
  properties: {
    defaultTag: { type: 'string' },
    pipelineId: { type: 'string' },
    ecr: { type: 'string' },
    builder: {
      type: 'object',
      additionalProperties: true,
      properties: {
        engine: { type: 'string' },
      },
    },
    app: {
      type: 'object',
      additionalProperties: false,
      properties: {
        afterBuildPipelineConfig: {
          type: 'object',
          additionalProperties: false,
          properties: {
            afterBuildPipelineId: { type: 'string' },
            detatchAfterBuildPipeline: { type: 'boolean' },
            description: { type: 'string' },
          },
        },
        dockerfilePath: { type: 'string' },
        command: { type: 'string' },
        arguments: { type: 'string' },
        env: { type: 'object' },
        ports: { type: 'array', minItems: 1 },
      },
      required: ['dockerfilePath'],
    },
    init: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dockerfilePath: { type: 'string' },
        command: { type: 'string' },
        arguments: { type: 'string' },
        env: { type: 'object' },
      },
      required: ['dockerfilePath'],
    },
  },
  required: ['defaultTag', 'app'],
};
