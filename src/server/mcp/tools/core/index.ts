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
import { createGetContextToolDefinition, type GetContextToolDependencies } from './getContext';
import { createGetEnvironmentToolDefinition, type GetEnvironmentToolDependencies } from './getEnvironment';
import { createListEnvironmentsToolDefinition, type ListEnvironmentsToolDependencies } from './listEnvironments';
import { createListRepositoriesToolDefinition, type ListRepositoriesToolDependencies } from './listRepositories';
import {
  createPreviewEnvironmentConfigToolDefinition,
  type PreviewEnvironmentConfigToolDependencies,
} from './previewEnvironmentConfig';
import {
  createValidateLifecycleConfigToolDefinition,
  type ValidateLifecycleConfigToolDependencies,
} from './validateLifecycleConfig';
import { createWaitForEnvironmentToolDefinition, type WaitForEnvironmentToolDependencies } from './waitForEnvironment';

export interface CoreToolDependencies {
  getContext?: GetContextToolDependencies;
  listRepositories?: ListRepositoriesToolDependencies;
  previewEnvironmentConfig?: PreviewEnvironmentConfigToolDependencies;
  validateLifecycleConfig?: ValidateLifecycleConfigToolDependencies;
  listEnvironments?: ListEnvironmentsToolDependencies;
  getEnvironment?: GetEnvironmentToolDependencies;
  waitForEnvironment?: WaitForEnvironmentToolDependencies;
}

export function createCoreToolDefinitions(dependencies: CoreToolDependencies = {}): McpToolDefinition[] {
  return [
    createGetContextToolDefinition(dependencies.getContext),
    createListRepositoriesToolDefinition(dependencies.listRepositories),
    createPreviewEnvironmentConfigToolDefinition(dependencies.previewEnvironmentConfig),
    createValidateLifecycleConfigToolDefinition(dependencies.validateLifecycleConfig),
    createListEnvironmentsToolDefinition(dependencies.listEnvironments),
    createGetEnvironmentToolDefinition(dependencies.getEnvironment),
    createWaitForEnvironmentToolDefinition(dependencies.waitForEnvironment),
  ];
}
