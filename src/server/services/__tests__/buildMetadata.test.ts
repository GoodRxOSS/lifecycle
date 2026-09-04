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
const mockLoggerError = jest.fn();

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
    error: (...args: unknown[]) => mockLoggerError(...args),
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

  test.each([undefined, null, [], {}, { links: 'not-an-array' }])(
    'treats malformed stored config %# as empty',
    async (storedConfig) => {
      mockGetConfig.mockResolvedValueOnce(storedConfig);

      await expect(createService().getConfig()).resolves.toEqual({ links: [] });
    }
  );

  test('drops malformed stored links and uses text to break position ties', async () => {
    mockGetConfig.mockResolvedValueOnce({
      links: [
        null,
        { id: 'missing-position', text: 'Missing', icon: 'file', link: 'https://example.com' },
        { id: 'decimal', text: 'Decimal', icon: 'file', link: 'https://example.com', position: 1.5 },
        { id: 'zulu', text: 'Zulu', icon: 'file', link: 'https://example.com/z', position: 3 },
        { id: 'alpha', text: 'Alpha', icon: 'file', link: 'https://example.com/a', position: 3 },
      ],
    });

    await expect(createService().getConfig()).resolves.toEqual({
      links: [
        { id: 'alpha', text: 'Alpha', icon: 'file', link: 'https://example.com/a', position: 3 },
        { id: 'zulu', text: 'Zulu', icon: 'file', link: 'https://example.com/z', position: 3 },
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

  test('trims create fields and honors an explicit integer position', async () => {
    const metadata = await createService().createLink({
      text: '  Runbook  ',
      icon: '  file  ',
      link: '  {{scheme}}://example.com/runbook  ',
      position: -2,
    });

    expect(metadata.links).toEqual([
      {
        id: 'metadata-link-generated1',
        text: 'Runbook',
        icon: 'file',
        link: '{{scheme}}://example.com/runbook',
        position: -2,
      },
    ]);
  });

  test.each([
    {
      name: 'a non-object request',
      input: null,
      message: 'Request body must be an object.',
    },
    {
      name: 'an unsupported field',
      input: { text: 'Text', icon: 'file', link: 'https://example.com', extra: true },
      message: 'Unsupported metadata link fields: extra',
    },
    {
      name: 'a non-string link',
      input: { text: 'Text', icon: 'file', link: 42 },
      message: 'link must be a string.',
    },
    {
      name: 'empty text',
      input: { text: '   ', icon: 'file', link: 'https://example.com' },
      message: 'text must not be empty.',
    },
    {
      name: 'a non-string icon',
      input: { text: 'Text', icon: false, link: 'https://example.com' },
      message: 'icon must be a string.',
    },
    {
      name: 'a non-integer position',
      input: { text: 'Text', icon: 'file', link: 'https://example.com', position: 1.5 },
      message: 'position must be an integer.',
    },
  ])('rejects $name without persisting', async ({ input, message }) => {
    await expect(createService().createLink(input)).rejects.toMatchObject({
      code: 'invalid_input',
      message,
    });
    expect(mockSetConfig).not.toHaveBeenCalled();
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

  test('patches and trims optional icon and link fields', async () => {
    mockGetConfig.mockResolvedValueOnce({
      links: [{ id: 'logs', text: 'Logs', icon: 'file', link: 'https://example.com/logs', position: 1 }],
    });

    await expect(
      createService().updateLink('logs', {
        icon: '  route  ',
        link: '  https://example.com/new-logs  ',
      })
    ).resolves.toEqual({
      links: [{ id: 'logs', text: 'Logs', icon: 'route', link: 'https://example.com/new-logs', position: 1 }],
    });
  });

  test.each([
    {
      name: 'a missing target',
      id: 'missing',
      input: { text: 'Updated' },
      message: "Metadata link 'missing' not found.",
      code: 'not_found',
    },
    {
      name: 'a non-object patch',
      id: 'logs',
      input: [],
      message: 'Request body must be an object.',
      code: 'invalid_input',
    },
    {
      name: 'unsupported patch fields',
      id: 'logs',
      input: { unknown: true },
      message: 'Unsupported metadata link fields: unknown',
      code: 'invalid_input',
    },
    {
      name: 'an empty patch',
      id: 'logs',
      input: {},
      message: 'Request body must include at least one supported field.',
      code: 'invalid_input',
    },
    {
      name: 'an empty optional string',
      id: 'logs',
      input: { icon: '  ' },
      message: 'icon must not be empty.',
      code: 'invalid_input',
    },
    {
      name: 'a non-integer patch position',
      id: 'logs',
      input: { position: 'first' },
      message: 'position must be an integer.',
      code: 'invalid_input',
    },
    {
      name: 'an unsafe patched link',
      id: 'logs',
      input: { link: 'DATA:text/plain,unsafe' },
      message: 'Unsupported metadata link scheme: data:',
      code: 'invalid_input',
    },
  ])('rejects $name without persisting', async ({ id, input, message, code }) => {
    mockGetConfig.mockResolvedValueOnce({
      links: [{ id: 'logs', text: 'Logs', icon: 'file', link: 'https://example.com/logs', position: 1 }],
    });

    await expect(createService().updateLink(id, input)).rejects.toMatchObject({ code, message });
    expect(mockSetConfig).not.toHaveBeenCalled();
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

  test('rejects deleting an unknown metadata link without persisting', async () => {
    mockGetConfig.mockResolvedValueOnce({
      links: [{ id: 'logs', text: 'Logs', icon: 'file', link: 'https://example.com/logs', position: 1 }],
    });

    await expect(createService().deleteLink('missing')).rejects.toMatchObject({
      code: 'not_found',
      message: "Metadata link 'missing' not found.",
    });
    expect(mockSetConfig).not.toHaveBeenCalled();
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

  test('rejects rendered links that are not absolute URLs', async () => {
    mockGetConfig.mockResolvedValueOnce({
      links: [{ id: 'dynamic', text: 'Dynamic', icon: 'alert', link: '/builds/{{buildUUID}}', position: 1 }],
    });

    await expect(createService().renderMetadataForBuild({ uuid: 'sample-build' } as any)).rejects.toMatchObject({
      code: 'invalid_rendered_link',
      message: "Rendered metadata link 'dynamic' must be a valid URL.",
    });
  });

  test('returns empty rendered metadata without loading build variables', async () => {
    await expect(createService().renderMetadataForBuild({ uuid: 'sample-build' } as any)).resolves.toEqual({
      links: [],
    });
    expect(mockAvailableEnvironmentVariablesForBuild).not.toHaveBeenCalled();
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

  test('renders an empty dashboard as an empty string', async () => {
    await expect(createService().renderDashboardMarkdown({ uuid: 'sample-build' } as any)).resolves.toBe('');
  });

  test('renders dashboard markdown and escapes table delimiters and line breaks', async () => {
    mockGetConfig.mockResolvedValueOnce({
      links: [
        {
          id: 'logs',
          text: 'Logs | traces\ncombined',
          icon: 'file',
          link: 'https://example.com/logs?label=left|right',
          position: 1,
        },
      ],
    });

    await expect(createService().renderDashboardMarkdown({ uuid: 'sample-build' } as any)).resolves.toBe(
      '<details>\n' +
        '<summary>Dashboards</summary>\n\n' +
        '|| Links |\n' +
        '| ------------- | ------------- |\n' +
        '| Logs \\| traces combined | https://example.com/logs?label=left\\|right |\n' +
        '</details>\n'
    );
  });

  test('logs render failures with the original error', () => {
    const error = new Error('render failed');

    createService().logRenderFailure(error);

    expect(mockLoggerError).toHaveBeenCalledWith({ error }, 'Metadata: render failed');
  });

  test('exposes typed error metadata to callers', () => {
    const error = new BuildMetadataError('bad input', 'invalid_input');

    expect(error).toMatchObject({
      name: 'BuildMetadataError',
      message: 'bad input',
      code: 'invalid_input',
    });
    expect(error).toBeInstanceOf(Error);
  });
});
