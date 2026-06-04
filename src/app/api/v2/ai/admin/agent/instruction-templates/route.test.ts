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

import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import path from 'path';

const mockGetUser = jest.fn();
const mockGetRequestUserIdentity = jest.fn();
const mockSeedSystemTemplates = jest.fn();
const mockListTemplates = jest.fn();
const mockGetTemplate = jest.fn();
const mockUpdateOverride = jest.fn();
const mockResetOverride = jest.fn();

const routeFiles = ['route.ts', '[ref]/route.ts', '[ref]/override/route.ts', '[ref]/reset/route.ts'];

jest.mock('server/lib/get-user', () => ({
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (...args: unknown[]) => mockGetRequestUserIdentity(...args),
}));

jest.mock('server/services/agent/InstructionTemplateService', () => {
  class InstructionTemplateServiceError extends Error {
    readonly statusCode: number;
    readonly details?: Record<string, unknown>;

    constructor(
      public readonly code: string,
      message: string,
      options: { statusCode?: number; details?: Record<string, unknown> } = {}
    ) {
      super(message);
      this.name = 'InstructionTemplateServiceError';
      this.statusCode = options.statusCode || (code === 'unknown_ref' ? 404 : 400);
      this.details = options.details;
    }
  }

  return {
    __esModule: true,
    default: {
      seedSystemTemplates: (...args: unknown[]) => mockSeedSystemTemplates(...args),
      listTemplates: (...args: unknown[]) => mockListTemplates(...args),
      getTemplate: (...args: unknown[]) => mockGetTemplate(...args),
      updateOverride: (...args: unknown[]) => mockUpdateOverride(...args),
      resetOverride: (...args: unknown[]) => mockResetOverride(...args),
    },
    InstructionTemplateServiceError,
  };
});

import { GET as LIST } from './route';
import { GET as GET_TEMPLATE } from './[ref]/route';
import { PUT as PUT_OVERRIDE } from './[ref]/override/route';
import { POST as POST_RESET } from './[ref]/reset/route';
import { InstructionTemplateServiceError } from 'server/services/agent/InstructionTemplateService';

function makeRequest(url: string, body?: unknown, options: { rejectJson?: boolean } = {}): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL(url),
    json: options.rejectJson ? jest.fn().mockRejectedValue(new Error('bad json')) : jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

const defaultTemplate = {
  ref: 'system:debug',
  name: 'Debug',
  description: 'Debug agent instructions.',
  default: {
    content: 'Use the sample default debug instructions.',
    version: 1,
    hash: '0'.repeat(64),
  },
  override: null,
  effective: {
    source: 'default',
    content: 'Use the sample default debug instructions.',
    version: 1,
    hash: '0'.repeat(64),
  },
};

const overrideTemplate = {
  ...defaultTemplate,
  override: {
    content: 'Use the sample admin debug override.',
    version: 1,
    hash: '1'.repeat(64),
    baseDefaultVersion: 1,
    baseDefaultHash: '0'.repeat(64),
    updatedBy: 'sample-admin',
    updatedAt: '2026-05-01T00:00:00.000Z',
  },
  effective: {
    source: 'override',
    content: 'Use the sample admin debug override.',
    version: 1,
    hash: '1'.repeat(64),
  },
};

describe('/api/v2/ai/admin/agent/instruction-templates', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({
      sub: 'sample-admin',
      realm_access: {
        roles: ['admin'],
      },
    });
    mockGetRequestUserIdentity.mockReturnValue({
      userId: 'sample-admin',
      githubUsername: 'sample-admin',
    });
    mockSeedSystemTemplates.mockResolvedValue([]);
    mockListTemplates.mockResolvedValue([defaultTemplate]);
    mockGetTemplate.mockResolvedValue(defaultTemplate);
    mockUpdateOverride.mockResolvedValue(overrideTemplate);
    mockResetOverride.mockResolvedValue(defaultTemplate);
  });

  it('initializes shared server dependencies before route handlers use models', () => {
    for (const routeFile of routeFiles) {
      const routeSource = readFileSync(path.join(__dirname, routeFile), 'utf8');
      expect(routeSource).toContain("import 'server/lib/dependencies';");
    }
  });

  afterEach(() => {
    if (originalEnableAuth === undefined) {
      delete process.env.ENABLE_AUTH;
    } else {
      process.env.ENABLE_AUTH = originalEnableAuth;
    }
  });

  it('rejects non-admin users before listing templates', async () => {
    mockGetUser.mockReturnValue({
      sub: 'sample-user',
      realm_access: {
        roles: ['user'],
      },
    });

    const response = await LIST(makeRequest('http://localhost/api/v2/ai/admin/agent/instruction-templates'));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Forbidden: insufficient permissions');
    expect(mockSeedSystemTemplates).not.toHaveBeenCalled();
    expect(mockListTemplates).not.toHaveBeenCalled();
  });

  it('rejects non-admin users before mutating templates', async () => {
    mockGetUser.mockReturnValue({
      sub: 'sample-user',
      realm_access: {
        roles: ['user'],
      },
    });

    const response = await PUT_OVERRIDE(
      makeRequest('http://localhost/api/v2/ai/admin/agent/instruction-templates/system%3Adebug/override', {
        content: 'Use the sample admin debug override.',
      }),
      { params: Promise.resolve({ ref: 'system%3Adebug' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.message).toBe('Forbidden: insufficient permissions');
    expect(mockSeedSystemTemplates).not.toHaveBeenCalled();
    expect(mockUpdateOverride).not.toHaveBeenCalled();
  });

  it('lists templates with default override and effective metadata', async () => {
    const response = await LIST(makeRequest('http://localhost/api/v2/ai/admin/agent/instruction-templates'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockSeedSystemTemplates).toHaveBeenCalledTimes(1);
    expect(mockListTemplates).toHaveBeenCalledTimes(1);
    expect(mockSeedSystemTemplates.mock.invocationCallOrder[0]).toBeLessThan(
      mockListTemplates.mock.invocationCallOrder[0]
    );
    expect(body.data).toEqual({
      templates: [defaultTemplate],
    });
  });

  it('gets one template by decoded ref', async () => {
    const response = await GET_TEMPLATE(
      makeRequest('http://localhost/api/v2/ai/admin/agent/instruction-templates/system%3Adebug'),
      { params: Promise.resolve({ ref: 'system%3Adebug' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockSeedSystemTemplates).toHaveBeenCalledTimes(1);
    expect(mockGetTemplate).toHaveBeenCalledWith('system:debug');
    expect(mockSeedSystemTemplates.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetTemplate.mock.invocationCallOrder[0]
    );
    expect(body.data).toEqual({
      template: defaultTemplate,
    });
  });

  it('maps unknown refs to 404 responses', async () => {
    mockGetTemplate.mockRejectedValueOnce(
      new InstructionTemplateServiceError('unknown_ref', 'Instruction template not found: system:missing')
    );

    const response = await GET_TEMPLATE(
      makeRequest('http://localhost/api/v2/ai/admin/agent/instruction-templates/system%3Amissing'),
      { params: Promise.resolve({ ref: 'system%3Amissing' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(mockSeedSystemTemplates).toHaveBeenCalledTimes(1);
    expect(body.error.message).toBe('Instruction template not found: system:missing');
  });

  it.each([
    ['missing content', {}],
    ['non-string content', { content: 123 }],
  ])('rejects malformed override body: %s', async (_label, body) => {
    const response = await PUT_OVERRIDE(
      makeRequest('http://localhost/api/v2/ai/admin/agent/instruction-templates/system%3Adebug/override', body),
      { params: Promise.resolve({ ref: 'system%3Adebug' }) }
    );
    const responseBody = await response.json();

    expect(response.status).toBe(400);
    expect(responseBody.error.message).toBe('Request body must include content.');
    expect(mockUpdateOverride).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON override bodies', async () => {
    const response = await PUT_OVERRIDE(
      makeRequest('http://localhost/api/v2/ai/admin/agent/instruction-templates/system%3Adebug/override', undefined, {
        rejectJson: true,
      }),
      { params: Promise.resolve({ ref: 'system%3Adebug' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe('Invalid JSON in request body');
    expect(mockUpdateOverride).not.toHaveBeenCalled();
  });

  it('updates override content with admin identity', async () => {
    const response = await PUT_OVERRIDE(
      makeRequest('http://localhost/api/v2/ai/admin/agent/instruction-templates/system%3Adebug/override', {
        content: 'Use the sample admin debug override.',
      }),
      { params: Promise.resolve({ ref: 'system%3Adebug' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockSeedSystemTemplates).toHaveBeenCalledTimes(1);
    expect(mockUpdateOverride).toHaveBeenCalledWith('system:debug', {
      content: 'Use the sample admin debug override.',
      updatedBy: 'sample-admin',
    });
    expect(mockSeedSystemTemplates.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateOverride.mock.invocationCallOrder[0]
    );
    expect(body.data).toEqual({
      template: overrideTemplate,
    });
  });

  it('maps service validation errors to 400 responses', async () => {
    mockUpdateOverride.mockRejectedValueOnce(
      new InstructionTemplateServiceError('invalid_content', 'Instruction template content must be non-empty.')
    );

    const response = await PUT_OVERRIDE(
      makeRequest('http://localhost/api/v2/ai/admin/agent/instruction-templates/system%3Adebug/override', {
        content: ' ',
      }),
      { params: Promise.resolve({ ref: 'system%3Adebug' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(mockSeedSystemTemplates).toHaveBeenCalledTimes(1);
    expect(body.error.message).toBe('Instruction template content must be non-empty.');
  });

  it('resets overrides back to default effective metadata', async () => {
    const response = await POST_RESET(
      makeRequest('http://localhost/api/v2/ai/admin/agent/instruction-templates/system%3Adebug/reset'),
      { params: Promise.resolve({ ref: 'system%3Adebug' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockSeedSystemTemplates).toHaveBeenCalledTimes(1);
    expect(mockResetOverride).toHaveBeenCalledWith('system:debug');
    expect(mockSeedSystemTemplates.mock.invocationCallOrder[0]).toBeLessThan(
      mockResetOverride.mock.invocationCallOrder[0]
    );
    expect(body.data).toEqual({
      template: defaultTemplate,
    });
  });

  it('maps reset not-found errors to 404 responses', async () => {
    mockResetOverride.mockRejectedValueOnce(
      new InstructionTemplateServiceError('unknown_ref', 'Instruction template not found: system:missing')
    );

    const response = await POST_RESET(
      makeRequest('http://localhost/api/v2/ai/admin/agent/instruction-templates/system%3Amissing/reset'),
      { params: Promise.resolve({ ref: 'system%3Amissing' }) }
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(mockSeedSystemTemplates).toHaveBeenCalledTimes(1);
    expect(body.error.message).toBe('Instruction template not found: system:missing');
  });
});
