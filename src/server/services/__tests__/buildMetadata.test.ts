/**
 * Copyright 2026 Lifecycle contributors
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

const mockGetConfig = jest.fn();
const mockSetConfig = jest.fn();
const mockAvailableEnvironmentVariablesForBuild = jest.fn();
const mockBuildQuery = jest.fn();

jest.mock('server/lib/dependencies', () => ({
  defaultDb: {},
  defaultRedis: {},
  defaultRedlock: {},
  defaultQueueManager: {},
}));

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'generated1'),
}));

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getConfig: (...args: unknown[]) => mockGetConfig(...args),
      setConfig: (...args: unknown[]) => mockSetConfig(...args),
    })),
  },
}));

jest.mock('server/lib/buildEnvVariables', () => ({
  BuildEnvironmentVariables: jest.fn().mockImplementation(() => ({
    availableEnvironmentVariablesForBuild: (...args: unknown[]) => mockAvailableEnvironmentVariablesForBuild(...args),
  })),
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
  })),
}));

import BuildMetadataService, { BuildMetadataError } from '../buildMetadata';

function createService() {
  return new BuildMetadataService(
    {
      models: {
        Build: {
          query: mockBuildQuery,
        },
      },
    } as any,
    {} as any,
    {} as any,
    {} as any
  );
}

describe('BuildMetadataService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockResolvedValue({ links: [] });
    mockSetConfig.mockResolvedValue(undefined);
    mockAvailableEnvironmentVariablesForBuild.mockResolvedValue({
      buildUUID: 'sample-build',
      branchName: 'feature/add-metadata',
      namespace: 'env-sample-build',
      web_publicUrl: 'web-sample-build.example.com',
    });
  });

  test('returns sorted metadata links from global config', async () => {
    mockGetConfig.mockResolvedValueOnce({
      links: [
        { id: 'two', text: 'Two', icon: 'route', link: 'https://example.com/two', position: 2 },
        { id: 'one', text: 'One', icon: 'file', link: 'https://example.com/one', position: 1 },
      ],
    });

    await expect(createService().getConfig()).resolves.toEqual({
      links: [
        { id: 'one', text: 'One', icon: 'file', link: 'https://example.com/one', position: 1 },
        { id: 'two', text: 'Two', icon: 'route', link: 'https://example.com/two', position: 2 },
      ],
    });
  });

  test('creates metadata links with generated IDs and append position', async () => {
    mockGetConfig.mockResolvedValueOnce({
      links: [{ id: 'existing', text: 'Existing', icon: 'file', link: 'https://example.com/old', position: 4 }],
    });

    const metadata = await createService().createLink({
      text: 'New link',
      icon: 'container',
      link: 'https://example.com/new?build={{{buildUUID}}}',
    });

    expect(metadata.links).toEqual([
      { id: 'existing', text: 'Existing', icon: 'file', link: 'https://example.com/old', position: 4 },
      {
        id: 'metadata-link-generated1',
        text: 'New link',
        icon: 'container',
        link: 'https://example.com/new?build={{{buildUUID}}}',
        position: 5,
      },
    ]);
    expect(mockSetConfig).toHaveBeenCalledWith('metadata', metadata);
  });

  test('patches metadata links without replacing unspecified fields', async () => {
    mockGetConfig.mockResolvedValueOnce({
      links: [{ id: 'logs', text: 'Logs', icon: 'file', link: 'https://example.com/logs', position: 1 }],
    });

    const metadata = await createService().updateLink('logs', { text: 'Runtime logs', position: 0 });

    expect(metadata.links).toEqual([
      { id: 'logs', text: 'Runtime logs', icon: 'file', link: 'https://example.com/logs', position: 0 },
    ]);
  });

  test('deletes metadata links', async () => {
    mockGetConfig.mockResolvedValueOnce({
      links: [
        { id: 'logs', text: 'Logs', icon: 'file', link: 'https://example.com/logs', position: 1 },
        { id: 'traces', text: 'Traces', icon: 'route', link: 'https://example.com/traces', position: 2 },
      ],
    });

    await createService().deleteLink('logs');

    expect(mockSetConfig).toHaveBeenCalledWith('metadata', {
      links: [{ id: 'traces', text: 'Traces', icon: 'route', link: 'https://example.com/traces', position: 2 }],
    });
  });

  test('rejects unsafe link schemes on write', async () => {
    await expect(
      createService().createLink({
        text: 'Unsafe',
        icon: 'alert',
        link: 'javascript:alert(1)',
      })
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'Unsupported metadata link scheme: javascript:',
    });
  });

  test('renders metadata links with the build environment variable context', async () => {
    mockGetConfig.mockResolvedValueOnce({
      links: [
        {
          id: 'logs',
          text: 'Logs',
          icon: 'file',
          link: 'https://example.com/logs?build={{buildUUID}}&branch={{branchName}}&service={{{web_publicUrl}}}&missing={{missingValue}}',
          position: 1,
        },
      ],
    });

    const metadata = await createService().renderMetadataForBuild({ uuid: 'sample-build' } as any);

    expect(mockAvailableEnvironmentVariablesForBuild).toHaveBeenCalledWith(
      { uuid: 'sample-build' },
      { applyNoDefaultEnvResolveFeatureFlag: false }
    );
    expect(metadata.links).toEqual([
      {
        id: 'logs',
        text: 'Logs',
        icon: 'file',
        link: 'https://example.com/logs?build=sample-build&branch=feature/add-metadata&service=web-sample-build.example.com&missing=',
        position: 1,
      },
    ]);
  });

  test('rejects unsafe rendered link schemes', async () => {
    mockGetConfig.mockResolvedValueOnce({
      links: [{ id: 'dynamic', text: 'Dynamic', icon: 'alert', link: '{{scheme}}:alert(1)', position: 1 }],
    });
    mockAvailableEnvironmentVariablesForBuild.mockResolvedValueOnce({ scheme: 'javascript' });

    await expect(createService().renderMetadataForBuild({ uuid: 'sample-build' } as any)).rejects.toBeInstanceOf(
      BuildMetadataError
    );
  });

  test('renders metadata by build UUID and returns not found for missing builds', async () => {
    const findOne = jest.fn().mockReturnThis();
    const select = jest.fn().mockResolvedValue({ uuid: 'sample-build' });
    mockBuildQuery.mockReturnValue({ findOne, select });

    await expect(createService().renderMetadataForBuildUUID('sample-build')).resolves.toEqual({ links: [] });
    expect(findOne).toHaveBeenCalledWith({ uuid: 'sample-build' });

    select.mockResolvedValueOnce(undefined);
    await expect(createService().renderMetadataForBuildUUID('missing-build')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
