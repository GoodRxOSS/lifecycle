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

const toolRuleSchema = {
  type: 'object',
  properties: {
    toolKey: { type: 'string', minLength: 1, maxLength: 255 },
    mode: { type: 'string', enum: ['allow', 'deny'] },
  },
  required: ['toolKey', 'mode'],
  additionalProperties: false,
};

export const agentSessionControlPlaneConfigSchema = {
  type: 'object',
  properties: {
    systemPrompt: { type: 'string', maxLength: 50000 },
    appendSystemPrompt: { type: 'string', maxLength: 50000 },
    toolRules: {
      type: 'array',
      items: toolRuleSchema,
    },
  },
  additionalProperties: false,
};
