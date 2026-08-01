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

import type { McpToolDefinition } from '../../contracts';
import { createConfigureEnvironmentToolDefinition } from './configureEnvironment';
import { createCreateEnvironmentToolDefinition } from './createEnvironment';
import { createDeployEnvironmentToolDefinition } from './deployEnvironment';
import { createDestroyEnvironmentToolDefinition } from './destroyEnvironment';
import { createExtendEnvironmentToolDefinition } from './extendEnvironment';
import { resolveEnvironmentOperationToolDependencies, type EnvironmentOperationToolDependencies } from './shared';

export type { EnvironmentOperationService, EnvironmentOperationToolDependencies } from './shared';

export function createEnvironmentOperationToolDefinitions(
  dependencies: EnvironmentOperationToolDependencies = {}
): McpToolDefinition[] {
  const resolved = resolveEnvironmentOperationToolDependencies(dependencies);
  return [
    createCreateEnvironmentToolDefinition(resolved),
    createConfigureEnvironmentToolDefinition(resolved),
    createDeployEnvironmentToolDefinition(resolved),
    createExtendEnvironmentToolDefinition(resolved),
    createDestroyEnvironmentToolDefinition(resolved),
  ];
}
