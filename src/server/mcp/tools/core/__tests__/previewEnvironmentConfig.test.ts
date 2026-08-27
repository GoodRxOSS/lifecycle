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

jest.mock('server/services/build', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('server/services/apiAccessConfig', () => ({
  __esModule: true,
  default: { getInstance: jest.fn() },
}));

import BuildService from 'server/services/build';
import ApiAccessConfigService from 'server/services/apiAccessConfig';
import type { McpJsonObject, McpToolDefinition } from '../../../contracts';
import {
  createPreviewEnvironmentConfigToolDefinition,
  type PreviewEnvironmentConfigToolDependencies,
} from '../previewEnvironmentConfig';

const mockBuildServiceConstructor = BuildService as unknown as jest.Mock;
const mockDefaultPreview = jest.fn();
const mockGetApiEnvironmentsConfig = jest.fn();

function callHandler(
  definition: McpToolDefinition,
  input: McpJsonObject = { repository: 'goodrx/example', branch: 'main' }
) {
  return definition.handler(input, {} as never);
}

function onboardedRepository() {
  return { githubRepositoryId: 7, fullName: 'GoodRx/Example', defaultEnvId: 3 };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDefaultPreview.mockReset().mockResolvedValue({ valid: true, services: [] });
  mockGetApiEnvironmentsConfig.mockReset().mockResolvedValue({
    defaultTtlHours: 72,
    maxTtlHours: 720,
  });
  mockBuildServiceConstructor.mockReset().mockImplementation(() => ({
    previewEnvironmentConfig: mockDefaultPreview,
  }));
  (ApiAccessConfigService.getInstance as jest.Mock).mockReturnValue({
    getApiEnvironmentsConfig: mockGetApiEnvironmentsConfig,
  });
});

describe('default preview dependencies', () => {
  it('lazily reuses BuildService and returns canonical preview data with the configured policy', async () => {
    const findRepository = jest.fn().mockResolvedValue(onboardedRepository());
    mockDefaultPreview.mockResolvedValue({
      valid: true,
      services: [
        {
          name: 'api',
          type: 'docker',
          defaultActive: true,
          editable: true,
          repository: 'goodrx/shared-api',
          effectiveBranch: 'feature/preview',
          status: 'unresolved',
          reason: 'Referenced branch is not available yet',
          previewOnly: true,
        },
        {
          name: 'worker',
          type: 'github',
          defaultActive: false,
          editable: false,
        },
      ],
    });
    const definition = createPreviewEnvironmentConfigToolDefinition({ findRepository });

    expect(mockBuildServiceConstructor).not.toHaveBeenCalled();
    const result = await callHandler(definition, { repository: 'goodrx/example', branch: 'feature/preview' });
    await callHandler(definition, { repository: 'goodrx/example', branch: 'feature/preview' });

    expect(findRepository).toHaveBeenCalledWith('goodrx/example');
    expect(mockBuildServiceConstructor).toHaveBeenCalledTimes(1);
    expect(mockDefaultPreview).toHaveBeenCalledTimes(2);
    expect(mockDefaultPreview).toHaveBeenCalledWith('GoodRx/Example', 'feature/preview');
    expect(mockGetApiEnvironmentsConfig).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      valid: true,
      services: [
        {
          name: 'api',
          type: 'docker',
          defaultActive: true,
          editable: true,
          repository: 'goodrx/shared-api',
          effectiveBranch: 'feature/preview',
          status: 'unresolved',
          reason: 'Referenced branch is not available yet',
          previewOnly: true,
        },
        {
          name: 'worker',
          type: 'github',
          defaultActive: false,
          editable: false,
          status: 'resolved',
          previewOnly: false,
        },
      ],
      unresolved: ['api'],
      truncated: false,
      policy: { defaultTtlHours: 72, maxTtlHours: 720 },
    });
  });

  it('does not construct preview or policy dependencies when the repository is not onboarded', async () => {
    const findRepository = jest.fn().mockResolvedValue(null);
    const definition = createPreviewEnvironmentConfigToolDefinition({ findRepository });

    await expect(callHandler(definition)).rejects.toMatchObject({
      name: 'McpExecutionError',
      code: 'repo_not_onboarded',
      message: 'That repository is not onboarded. Call list_repositories to see repositories you can use.',
    });

    expect(mockBuildServiceConstructor).not.toHaveBeenCalled();
    expect(mockDefaultPreview).not.toHaveBeenCalled();
    expect(ApiAccessConfigService.getInstance).not.toHaveBeenCalled();
    expect(mockGetApiEnvironmentsConfig).not.toHaveBeenCalled();
  });
});

describe('preview handler boundaries', () => {
  it('maps an unexpected preview dependency failure without exposing its message', async () => {
    const findRepository = jest.fn().mockResolvedValue(onboardedRepository());
    const previewEnvironmentConfig = jest.fn().mockRejectedValue(new Error('sensitive build failure'));
    const loadEnvironmentPolicy = jest.fn().mockResolvedValue({ defaultTtlHours: 72, maxTtlHours: 720 });
    const definition = createPreviewEnvironmentConfigToolDefinition({
      findRepository,
      previewEnvironmentConfig,
      loadEnvironmentPolicy,
    });

    await expect(callHandler(definition)).rejects.toMatchObject({
      name: 'McpExecutionError',
      code: 'internal_error',
      message: 'Lifecycle could not complete this request. Ask an administrator for help.',
    });

    expect(previewEnvironmentConfig).toHaveBeenCalledWith('GoodRx/Example', 'main');
    expect(loadEnvironmentPolicy).toHaveBeenCalledTimes(1);
    expect(mockBuildServiceConstructor).not.toHaveBeenCalled();
    expect(ApiAccessConfigService.getInstance).not.toHaveBeenCalled();
  });

  it('returns the stable fallback validation message when an invalid preview has no usable error', async () => {
    for (const preview of [
      { valid: false, services: [] },
      { valid: false, error: '', services: [] },
    ]) {
      const definition = createPreviewEnvironmentConfigToolDefinition({
        findRepository: jest.fn().mockResolvedValue(onboardedRepository()),
        previewEnvironmentConfig: jest.fn().mockResolvedValue(preview),
        loadEnvironmentPolicy: jest.fn().mockResolvedValue({ defaultTtlHours: 24, maxTtlHours: 168 }),
      });

      await expect(callHandler(definition)).resolves.toEqual({
        valid: false,
        validationMessage: 'lifecycle.yaml did not pass validation.',
        services: [],
        unresolved: [],
        truncated: false,
        policy: { defaultTtlHours: 24, maxTtlHours: 168 },
      });
    }
  });

  it('replaces a control-only invalid-config error with safe user-facing text', async () => {
    const definition = createPreviewEnvironmentConfigToolDefinition({
      findRepository: jest.fn().mockResolvedValue(onboardedRepository()),
      previewEnvironmentConfig: jest
        .fn()
        .mockResolvedValue({ valid: false, error: '\u001b[31m\u001b[0m', services: [] }),
      loadEnvironmentPolicy: jest.fn().mockResolvedValue({ defaultTtlHours: 24, maxTtlHours: 168 }),
    });

    await expect(callHandler(definition)).rejects.toMatchObject({
      name: 'McpExecutionError',
      code: 'config_invalid',
      message: 'Lifecycle could not read lifecycle.yaml from that repository and branch.',
    });
  });

  it('bounds a preview to 201 services and marks locally detected truncation', async () => {
    const services = Array.from({ length: 202 }, (_, index) => ({
      name: `service-${index}`,
      type: 'docker',
      defaultActive: true,
      editable: true,
      status: 'resolved',
      previewOnly: false,
    }));
    const dependencies: PreviewEnvironmentConfigToolDependencies = {
      findRepository: jest.fn().mockResolvedValue(onboardedRepository()),
      previewEnvironmentConfig: jest.fn().mockResolvedValue({ valid: true, services }),
      loadEnvironmentPolicy: jest.fn().mockResolvedValue({ defaultTtlHours: 72, maxTtlHours: 720 }),
    };

    const result = await callHandler(createPreviewEnvironmentConfigToolDefinition(dependencies));

    expect(result.services).toHaveLength(201);
    expect(result.services?.[0]).toMatchObject({ name: 'service-0', status: 'resolved' });
    expect(result.services?.[200]).toMatchObject({ name: 'service-200', status: 'resolved' });
    expect(result).toMatchObject({ valid: true, unresolved: [], truncated: true });
  });
});
