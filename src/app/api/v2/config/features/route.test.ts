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

const mockGetUser = jest.fn();
const mockGetFeaturesConfig = jest.fn();
const mockUpdateFeaturesConfig = jest.fn();

jest.mock('server/lib/get-user', () => ({
  __esModule: true,
  getUser: (...args: unknown[]) => mockGetUser(...args),
  getRequestUserIdentity: (req: unknown) => {
    const payload = mockGetUser(req) as { sub?: string; realm_access?: { roles?: string[] } } | null;
    return payload ? { userId: payload.sub, roles: payload.realm_access?.roles ?? [] } : null;
  },
}));

jest.mock('server/services/featuresConfig', () => ({
  FEATURE_DEFINITIONS: [{ key: 'podShell' }, { key: 'envLens' }, { key: 'reconcileDeletedServices' }],
  getFeaturesConfig: (...args: unknown[]) => mockGetFeaturesConfig(...args),
  updateFeaturesConfig: (...args: unknown[]) => mockUpdateFeaturesConfig(...args),
}));

import { GET, PUT } from './route';

function makeRequest(body?: unknown): NextRequest {
  return {
    headers: new Headers([['x-request-id', 'req-test']]),
    nextUrl: new URL('http://localhost/api/v2/config/features'),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as NextRequest;
}

describe('V2 feature settings', () => {
  const original = process.env.ENABLE_AUTH;
  beforeEach(() => {
    process.env.ENABLE_AUTH = 'true';
    mockGetUser.mockReturnValue({ sub: 'admin', realm_access: { roles: ['admin'] } });
    mockGetFeaturesConfig.mockResolvedValue([]);
    mockUpdateFeaturesConfig.mockResolvedValue([]);
  });
  afterAll(() => {
    if (original === undefined) delete process.env.ENABLE_AUTH;
    else process.env.ENABLE_AUTH = original;
  });
  test('signed-in users can read but cannot edit flags', async () => {
    mockGetUser.mockReturnValue({ sub: 'user', realm_access: { roles: ['user'] } });
    expect((await GET(makeRequest())).status).toBe(200);
    expect((await PUT(makeRequest({ podShell: false }))).status).toBe(403);
    expect(mockUpdateFeaturesConfig).not.toHaveBeenCalled();
  });
  test('anonymous users cannot read or edit', async () => {
    mockGetUser.mockReturnValue(null);
    expect((await GET(makeRequest())).status).toBe(401);
    expect((await PUT(makeRequest({ podShell: false }))).status).toBe(401);
    expect(mockUpdateFeaturesConfig).not.toHaveBeenCalled();
  });
  test('an admin can save just one registered flag', async () => {
    expect((await PUT(makeRequest({ podShell: false }))).status).toBe(200);
    expect(mockUpdateFeaturesConfig).toHaveBeenCalledWith({ podShell: false });
  });
  test.each([null, [], {}, { podShell: 'false' }, { arbitrary: true }, { envLens: true, arbitrary: true }])(
    'rejects invalid updates %j',
    async (body) => {
      expect((await PUT(makeRequest(body))).status).toBe(400);
      expect(mockUpdateFeaturesConfig).not.toHaveBeenCalled();
    }
  );
  test('rejects malformed JSON', async () => {
    const req = makeRequest();
    req.json = jest.fn().mockRejectedValue(new SyntaxError('bad json'));
    expect((await PUT(req)).status).toBe(400);
    expect(mockUpdateFeaturesConfig).not.toHaveBeenCalled();
  });
  test('does not report success when refresh fails', async () => {
    mockUpdateFeaturesConfig.mockRejectedValue(new Error('cache unavailable'));
    expect((await PUT(makeRequest({ podShell: false }))).status).toBe(500);
  });
});
