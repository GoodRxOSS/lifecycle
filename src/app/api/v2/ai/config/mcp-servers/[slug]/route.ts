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

const getHandler = async (req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const scope = req.nextUrl.searchParams.get('scope') || 'global';
  const service = new McpConfigService();
  const config = await service.getBySlugAndScope(slug, scope);

  if (!config) {
    return NextResponse.json(
      {
        request_id: req.headers.get('x-request-id'),
        data: null,
        error: { message: `MCP server config '${slug}' not found` },
      },
      { status: 404 }
    );
  }

  const result = redactHeaders(config.toJSON ? config.toJSON() : config);
  return successResponse(result, { status: 200 }, req);
};

const putHandler = async (req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const scope = req.nextUrl.searchParams.get('scope') || 'global';
  const body = await req.json();
  const service = new McpConfigService();

  try {
    const config = await service.update(slug, scope, body);
    const result = redactHeaders(config.toJSON ? config.toJSON() : config);
    return successResponse(result, { status: 200 }, req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return NextResponse.json(
        { request_id: req.headers.get('x-request-id'), data: null, error: { message } },
        { status: 404 }
      );
    }
    if (message.includes('connectivity validation failed')) {
      return NextResponse.json(
        { request_id: req.headers.get('x-request-id'), data: null, error: { message } },
        { status: 422 }
      );
    }
    throw error;
  }
};

const deleteHandler = async (req: NextRequest, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const scope = req.nextUrl.searchParams.get('scope') || 'global';
  const service = new McpConfigService();

  try {
    await service.delete(slug, scope);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) {
      return NextResponse.json(
        { request_id: req.headers.get('x-request-id'), data: null, error: { message } },
        { status: 404 }
      );
    }
    throw error;
  }
};

export const GET = createApiHandler(getHandler);
export const PUT = createApiHandler(putHandler);
export const DELETE = createApiHandler(deleteHandler);
