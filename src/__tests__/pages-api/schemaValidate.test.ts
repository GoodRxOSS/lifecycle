import { request, response } from 'src/test-utils/pagesApi';

const mockFetchYaml = jest.fn();
const mockParse = jest.fn();
const mockValidate = jest.fn();
const mockLogger = { error: jest.fn() };

jest.mock('server/lib/github', () => ({
  getYamlFileContentFromBranch: (...args: unknown[]) => mockFetchYaml(...args),
  ConfigFileNotFound: class ConfigFileNotFound extends Error {},
}));

jest.mock('server/lib/yamlConfigParser', () => ({
  YamlConfigParser: jest.fn(() => ({ parseYamlConfigFromString: (...args: unknown[]) => mockParse(...args) })),
  ParsingError: class ParsingError extends Error {},
}));

jest.mock('server/lib/yamlConfigValidator', () => ({
  YamlConfigValidator: jest.fn(() => ({ validate: (...args: unknown[]) => mockValidate(...args) })),
  ValidationError: class ValidationError extends Error {},
}));

jest.mock('server/lib/logger', () => ({ getLogger: () => mockLogger }));

import handler from 'src/pages/api/v1/schema/validate';
import { ConfigFileNotFound } from 'server/lib/github';
import { ParsingError } from 'server/lib/yamlConfigParser';
import { ValidationError } from 'server/lib/yamlConfigValidator';

describe('POST /api/v1/schema/validate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParse.mockReturnValue({ version: 'v2', services: {} });
    mockValidate.mockReturnValue(true);
    mockFetchYaml.mockResolvedValue('version: v2');
  });

  it('rejects unsupported methods before parsing a request', async () => {
    const res = response();
    await handler(request({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it.each([undefined, 7, 'url'])('rejects unsupported source values: %j', async (source) => {
    const res = response();
    await handler(request({ method: 'POST', body: { source } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ valid: false, error: ['Invalid source in request body'] });
  });

  it('validates decoded base64 content', async () => {
    const content = Buffer.from('version: v2\nservices: {}').toString('base64');
    const res = response();
    await handler(request({ method: 'POST', body: { source: 'content', content } }), res);
    expect(mockParse).toHaveBeenCalledWith('version: v2\nservices: {}');
    expect(mockValidate).toHaveBeenCalledWith('v2', { version: 'v2', services: {} });
    expect(res.body).toEqual({ valid: true, error: null });
  });

  it('passes an absent parsed content version through to the validator', async () => {
    mockParse.mockReturnValueOnce(undefined);
    const res = response();
    await handler(
      request({ method: 'POST', body: { source: 'content', content: Buffer.from('').toString('base64') } }),
      res
    );
    expect(mockValidate).toHaveBeenCalledWith(undefined, undefined);
  });

  it.each([undefined, 7])('requires content to be a string: %j', async (content) => {
    const res = response();
    await handler(request({ method: 'POST', body: { source: 'content', content } }), res);
    expect(res.statusCode).toBe(400);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it.each([[{ repo: '', branch: 'main' }], [{ repo: 'goodrx/lifecycle', branch: ' ' }], [{ repo: 7, branch: 'main' }]])(
    'requires nonblank string path coordinates: %j',
    async (body) => {
      const res = response();
      await handler(request({ method: 'POST', body: { source: 'path', ...body } }), res);
      expect(res.statusCode).toBe(400);
      expect(mockFetchYaml).not.toHaveBeenCalled();
    }
  );

  it('fetches and validates repository YAML by repo and branch', async () => {
    mockValidate.mockReturnValue(false);
    const res = response();
    await handler(
      request({ method: 'POST', body: { source: 'path', repo: 'goodrx/lifecycle', branch: 'feature' } }),
      res
    );
    expect(mockFetchYaml).toHaveBeenCalledWith('goodrx/lifecycle', 'feature');
    expect(mockParse).toHaveBeenCalledWith('version: v2');
    expect(res.body).toEqual({ valid: false, error: null });
  });

  it('passes an absent parsed path version through to the validator', async () => {
    mockParse.mockReturnValueOnce(undefined);
    const res = response();
    await handler(
      request({ method: 'POST', body: { source: 'path', repo: 'goodrx/lifecycle', branch: 'empty' } }),
      res
    );
    expect(mockValidate).toHaveBeenCalledWith(undefined, undefined);
  });

  it.each([
    [new ParsingError('line one\nline two'), 400, { valid: false, error: ['line one', 'line two'] }],
    [new ValidationError('invalid service'), 400, { valid: false, error: ['invalid service'] }],
    [new ConfigFileNotFound('missing'), 404, { valid: false, error: ['Config file not found'] }],
    [new Error('unexpected'), 500, { error: 'Internal server error' }],
  ])('maps validation failures without leaking internals: %s', async (error, status, body) => {
    mockParse.mockImplementationOnce(() => {
      throw error;
    });
    const res = response();
    await handler(
      request({
        method: 'POST',
        body: { source: 'content', content: Buffer.from('invalid').toString('base64') },
      }),
      res
    );
    expect(res.statusCode).toBe(status);
    expect(res.body).toEqual(body);
    if (status === 500) expect(mockLogger.error).toHaveBeenCalledWith({ error }, 'Schema: YAML validation failed');
  });

  it('maps repository file-not-found failures', async () => {
    mockFetchYaml.mockRejectedValueOnce(new ConfigFileNotFound('missing'));
    const res = response();
    await handler(request({ method: 'POST', body: { source: 'path', repo: 'goodrx/lifecycle', branch: 'main' } }), res);
    expect(res.statusCode).toBe(404);
  });
});
