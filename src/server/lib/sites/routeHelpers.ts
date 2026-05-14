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
import { errorResponse } from 'server/lib/response';
import { SitesServiceError } from 'server/services/sites';
import type { ListSitesFilters } from 'server/services/sites';

export async function readUploadFile(req: NextRequest): Promise<{ fileName: string; content: Buffer; name?: string }> {
  const formData = await req.formData();
  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    throw new SitesServiceError('A file upload is required.', 400);
  }

  const nameValue = formData.get('name');
  const name = typeof nameValue === 'string' ? nameValue : undefined;
  const arrayBuffer = await file.arrayBuffer();
  return {
    fileName: file.name || 'upload',
    content: Buffer.from(arrayBuffer),
    name,
  };
}

export function readSitesListFilters(searchParams: URLSearchParams): ListSitesFilters {
  const user = searchParams.get('user')?.trim();
  const page = Number.parseInt(searchParams.get('page') || '', 10);
  const limit = Number.parseInt(searchParams.get('limit') || '', 10);

  return {
    ...(user ? { user } : {}),
    ...(Number.isNaN(page) ? {} : { page }),
    ...(Number.isNaN(limit) ? {} : { limit }),
  };
}

export function sitesErrorResponse(error: unknown, req: NextRequest): NextResponse {
  return errorResponse(error, { status: error instanceof SitesServiceError ? error.statusCode : 500 }, req);
}
