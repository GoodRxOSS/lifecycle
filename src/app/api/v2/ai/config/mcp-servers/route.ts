/**
 * Copyright 2025 GoodRx, Inc.
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
import { createApiHandler } from 'server/lib/createApiHandler';
import { successResponse } from 'server/lib/response';
import { McpConfigService } from 'server/services/ai/mcp/config';
import 'server/lib/dependencies';

function redactHeaders(config: any): any {
  if (!config.headers || typeof config.headers !== 'object') return config;
  const redacted: Record<string, string> = {};
  for (const key of Object.keys(config.headers)) {
    redacted[key] = '******';
  }
  return { ...config, headers: redacted };
}

const getHandler = async (req: NextRequest) => {
  const scope = req.nextUrl.searchParams.get('scope') || 'global';
  const service = new McpConfigService();
  const configs = await service.listByScope(scope);
  const redacted = configs.map((c) => redactHeaders(c.toJSON ? c.toJSON() : c));
  return successResponse(redacted, { status: 200 }, req);
};

const postHandler = async (req: NextRequest) => {
  const body = await req.json();
  const { slug, name, url } = body;

  if (!slug || !name || !url) {
    return NextResponse.json(
      {
        request_id: req.headers.get('x-request-id'),
        data: null,
        error: { message: 'Missing required fields: slug, name, url' },
      },
      { status: 400 }
    );
  }

  const service = new McpConfigService();
  const input = {
    slug,
    name,
    url,
    scope: body.scope || 'global',
    description: body.description,
    headers: body.headers,
    envVars: body.envVars,
    enabled: body.enabled,
    timeout: body.timeout,
  };

  try {
    const config = await service.create(input);
    const result = redactHeaders(config.toJSON ? config.toJSON() : config);
    return successResponse(result, { status: 201 }, req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('already exists')) {
      return NextResponse.json(
        { request_id: req.headers.get('x-request-id'), data: null, error: { message } },
        { status: 409 }
      );
    }
    if (message.includes('connectivity validation failed') || message.includes('Invalid slug')) {
      return NextResponse.json(
        { request_id: req.headers.get('x-request-id'), data: null, error: { message } },
        { status: 422 }
      );
    }
    throw error;
  }
};

export const GET = createApiHandler(getHandler);
export const POST = createApiHandler(postHandler);
