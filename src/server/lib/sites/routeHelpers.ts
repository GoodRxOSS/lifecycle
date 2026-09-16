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
import { errorResponse, successResponse } from 'server/lib/response';
import { SitesServiceError } from 'server/services/sites';
import type { ListSitesFilters } from 'server/services/sites';

export function readSiteVisibility(value: unknown): 'private' | 'public' {
  if (value !== 'private' && value !== 'public')
    throw new SitesServiceError('visibility must be private or public.', 400);
  return value;
}

export function readSiteRevision(value: unknown, required = false): number | undefined {
  if (value === null || value === undefined || value === '') {
    if (required) throw new SitesServiceError('expectedAccessRevision is required.', 400);
    return undefined;
  }
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9][0-9]*$/.test(String(value))) {
    throw new SitesServiceError('Revision must be a positive integer.', 400);
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision > 2147483647) throw new SitesServiceError('Invalid revision.', 400);
  return revision;
}

export async function readUploadFile(
  req: NextRequest,
  maxUploadBytes?: number
): Promise<{
  fileName: string;
  content: Buffer;
  name?: string;
  visibility?: 'private' | 'public';
  expectedAccessRevision?: number;
  expectedContentRevision?: number;
}> {
  // Bound bytes while reading: Content-Length can be absent or dishonest, and formData buffers the whole body.
  const length = Number(req.headers?.get('content-length'));
  if (maxUploadBytes && Number.isFinite(length) && length > maxUploadBytes + 1024 * 1024) {
    throw new SitesServiceError('Upload exceeds the configured size limit.', 400);
  }
  let formData: FormData;
  if (maxUploadBytes && req.body) {
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let finished = false;
    try {
      while (!finished) {
        const chunk = await reader.read();
        if (chunk.done) {
          finished = true;
          continue;
        }
        total += chunk.value.byteLength;
        if (total > maxUploadBytes + 1024 * 1024) {
          await reader.cancel();
          throw new SitesServiceError('Upload exceeds the configured size limit.', 400);
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    formData = await new Response(Buffer.concat(chunks), {
      headers: { 'Content-Type': req.headers.get('content-type') || '' },
    }).formData();
  } else {
    formData = await req.formData();
  }
  const file = formData.get('file');
  if (!file || typeof file === 'string') throw new SitesServiceError('A file upload is required.', 400);
  if (maxUploadBytes && file.size > maxUploadBytes)
    throw new SitesServiceError('Upload exceeds the configured size limit.', 400);
  const nameValue = formData.get('name');
  const visibilityValue = formData.get('visibility');
  const expectedAccessRevision = readSiteRevision(formData.get('expectedAccessRevision'));
  const expectedContentRevision = readSiteRevision(formData.get('expectedContentRevision'));
  const visibility =
    visibilityValue === null || visibilityValue === undefined ? undefined : readSiteVisibility(visibilityValue);
  return {
    fileName: file.name || 'upload',
    content: Buffer.from(await file.arrayBuffer()),
    name: typeof nameValue === 'string' ? nameValue : undefined,
    ...(visibility ? { visibility } : {}),
    ...(expectedAccessRevision === undefined ? {} : { expectedAccessRevision }),
    ...(expectedContentRevision === undefined ? {} : { expectedContentRevision }),
  };
}

export function readSitesListFilters(searchParams: URLSearchParams): ListSitesFilters {
  const view = searchParams.get('view') || (searchParams.get('user')?.trim() ? 'mine' : undefined);
  if (view && !['mine', 'public', 'all'].includes(view)) throw new SitesServiceError('Invalid Sites view.', 400);
  const q = searchParams.get('q')?.trim();
  if (q && q.length > 200) throw new SitesServiceError('Search is too long.', 400);
  const page = readSiteRevision(searchParams.get('page'));
  const limit = readSiteRevision(searchParams.get('limit'));
  if (limit && limit > 100) throw new SitesServiceError('limit must be at most 100.', 400);
  return {
    ...(view ? { view: view as 'mine' | 'public' | 'all' } : {}),
    ...(q ? { q } : {}),
    ...(page === undefined ? {} : { page }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export function sitesErrorResponse(error: unknown, req: NextRequest): NextResponse {
  const response = errorResponse(error, { status: error instanceof SitesServiceError ? error.statusCode : 500 }, req);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export function sitesSuccessResponse<T>(
  data: T,
  options: Parameters<typeof successResponse>[1],
  req: NextRequest
): NextResponse {
  const response = successResponse(data, options, req);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
