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

import { NextRequest, NextResponse } from 'next/server';

const mockVerifyAuth = jest.fn();

jest.mock('server/lib/auth', () => ({
  verifyAuth: (...args: unknown[]) => mockVerifyAuth(...args),
}));

import { authMiddleware } from './auth';

describe('authMiddleware', () => {
  const originalEnableAuth = process.env.ENABLE_AUTH;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_AUTH = 'true';
  });

  afterAll(() => {
    process.env.ENABLE_AUTH = originalEnableAuth;
  });

  it('allows MCP OAuth callbacks without bearer auth', async () => {
    const next = jest.fn().mockResolvedValue(NextResponse.next());
    const request = new NextRequest(
      'http://localhost/api/v2/ai/agent/mcp-connections/sample-oauth/oauth/callback?scope=global&flow=flow-123'
    );

    await authMiddleware(request, next);

    expect(mockVerifyAuth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(request);
  });

  it('rejects other API requests without valid bearer auth', async () => {
    const next = jest.fn().mockResolvedValue(NextResponse.next());
    mockVerifyAuth.mockResolvedValue({
      success: false,
      error: { message: 'Unauthorized', status: 401 },
    });
    const request = new NextRequest('http://localhost/api/v2/ai/agent/settings');

    const response = await authMiddleware(request, next);
    const body = await response.json();

    expect(mockVerifyAuth).toHaveBeenCalledWith(request);
    expect(next).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    expect(body.error.message).toBe('Unauthorized');
  });
});
