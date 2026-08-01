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

import type { Principal } from 'server/lib/principal';
import ApiAccessConfigService from 'server/services/apiAccessConfig';
import type { McpJsonObject, McpToolDefinition } from '../../contracts';
import { DEFAULT_MCP_WAIT_SECONDS, loadMcpRuntimeConfig, MAX_MCP_WAIT_SECONDS } from '../../config';
import { closedObjectSchema, successObjectSchema } from '../../schemaValidator';
import { mapCoreToolError, safeCoreText } from './listRepositories';

const DESCRIPTION =
  'Returns the signed-in Lifecycle user and the current preview-environment lifetime and wait policies.';

interface CoreContextConfig {
  apiEnvironments: {
    defaultTtlHours: number;
    maxTtlHours: number;
    extensionHours: number;
  };
  maxWaitSeconds: number;
}

export interface GetContextToolDependencies {
  loadConfig?: () => Promise<CoreContextConfig>;
}

export const getContextInputSchema = closedObjectSchema({});

export const getContextOutputSchema = successObjectSchema(
  {
    user: closedObjectSchema(
      {
        id: { type: 'string', minLength: 1, maxLength: 255 },
        displayName: { type: 'string', minLength: 1, maxLength: 512 },
      },
      ['id', 'displayName']
    ),
    environmentPolicy: closedObjectSchema(
      {
        defaultTtlHours: { type: 'integer', minimum: 1, maximum: 8760 },
        maxTtlHours: { type: 'integer', minimum: 1, maximum: 8760 },
        extensionHours: { type: 'integer', minimum: 1, maximum: 8760 },
      },
      ['defaultTtlHours', 'maxTtlHours', 'extensionHours']
    ),
    limits: closedObjectSchema(
      {
        defaultWaitSeconds: { type: 'integer', minimum: 5, maximum: DEFAULT_MCP_WAIT_SECONDS },
        maxWaitSeconds: { type: 'integer', minimum: 5, maximum: MAX_MCP_WAIT_SECONDS },
      },
      ['defaultWaitSeconds', 'maxWaitSeconds']
    ),
  },
  ['user', 'environmentPolicy', 'limits']
);

async function defaultLoadConfig(): Promise<CoreContextConfig> {
  const apiEnvironments = await ApiAccessConfigService.getInstance().getApiEnvironmentsConfig();
  return {
    apiEnvironments,
    maxWaitSeconds: loadMcpRuntimeConfig().maxWaitSeconds,
  };
}

function displayName(principal: Principal): string {
  return (
    safeCoreText(
      principal.identity?.displayName ??
        principal.identity?.preferredUsername ??
        principal.identity?.githubUsername ??
        principal.userId,
      512
    ) || 'Lifecycle user'
  );
}

export function createGetContextToolDefinition(dependencies: GetContextToolDependencies = {}): McpToolDefinition {
  const loadConfig = dependencies.loadConfig ?? defaultLoadConfig;
  return {
    name: 'get_context',
    title: 'Get context',
    description: DESCRIPTION,
    inputSchema: getContextInputSchema,
    outputSchema: getContextOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    capabilityId: 'understand-environments',
    access: 'read',
    async handler(_input, context): Promise<McpJsonObject> {
      try {
        const config = await loadConfig();
        const userId = context.principal.userId;
        if (!userId) throw new Error('OAuth principal is missing a Lifecycle user id');
        const maxWaitSeconds = Math.max(5, Math.min(MAX_MCP_WAIT_SECONDS, config.maxWaitSeconds));
        return {
          user: {
            id: userId,
            displayName: displayName(context.principal),
          },
          environmentPolicy: {
            defaultTtlHours: config.apiEnvironments.defaultTtlHours,
            maxTtlHours: config.apiEnvironments.maxTtlHours,
            extensionHours: config.apiEnvironments.extensionHours,
          },
          limits: {
            defaultWaitSeconds: Math.min(DEFAULT_MCP_WAIT_SECONDS, maxWaitSeconds),
            maxWaitSeconds,
          },
        };
      } catch (error) {
        throw mapCoreToolError(error);
      }
    },
  };
}
