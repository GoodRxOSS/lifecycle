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

const mockError = jest.fn();

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ error: mockError })),
}));

import { NextRequest } from 'next/server';
import { SitesServiceError } from 'server/services/sites';
import { readSitesListFilters, readUploadFile, sitesErrorResponse } from './routeHelpers';

function uploadRequest(values: Record<string, unknown>): NextRequest {
  return {
    formData: jest.fn().mockResolvedValue({
      get: jest.fn((key: string) => values[key] ?? null),
    }),
  } as unknown as NextRequest;
}

describe('Sites route helpers', () => {
  beforeEach(() => {
    mockError.mockReset();
  });

  describe('readUploadFile', () => {
    it('reads the uploaded bytes, filename, and optional display name', async () => {
      const bytes = new Uint8Array([0, 1, 2, 255]);
      const file = {
        name: 'site.zip',
        arrayBuffer: jest.fn().mockResolvedValue(bytes.buffer),
      };

      await expect(readUploadFile(uploadRequest({ file, name: 'Docs site' }))).resolves.toEqual({
        fileName: 'site.zip',
        content: Buffer.from(bytes),
        name: 'Docs site',
      });
      expect(file.arrayBuffer).toHaveBeenCalledTimes(1);
    });

    it('uses a safe filename fallback and ignores a non-string display name', async () => {
      const file = {
        name: '',
        arrayBuffer: jest.fn().mockResolvedValue(new Uint8Array([65]).buffer),
      };

      await expect(readUploadFile(uploadRequest({ file, name: { unexpected: true } }))).resolves.toEqual({
        fileName: 'upload',
        content: Buffer.from('A'),
        name: undefined,
      });
    });

    it.each([null, 'not-a-file'])('rejects a missing or malformed file field (%p)', async (file) => {
      await expect(readUploadFile(uploadRequest({ file }))).rejects.toMatchObject({
        message: 'A file upload is required.',
        statusCode: 400,
      });
    });
  });

  describe('readSitesListFilters', () => {
    it('trims the user filter and parses integer pagination values', () => {
      expect(readSitesListFilters(new URLSearchParams('user=%20Alice%40Example.com%20&page=2&limit=50'))).toEqual({
        user: 'Alice@Example.com',
        page: 2,
        limit: 50,
      });
    });

    it('omits blank and non-numeric filters', () => {
      expect(readSitesListFilters(new URLSearchParams('user=%20%20&page=not-a-page&limit='))).toEqual({});
    });

    it('returns no filters when the query string is empty', () => {
      expect(readSitesListFilters(new URLSearchParams())).toEqual({});
    });
  });

  describe('sitesErrorResponse', () => {
    const request = () =>
      new NextRequest('http://localhost/api/v2/sites', {
        headers: { 'x-request-id': 'request-123' },
      });

    it('preserves a Sites service error status and message', async () => {
      const response = sitesErrorResponse(new SitesServiceError('Invalid upload.', 400), request());

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        request_id: 'request-123',
        data: null,
        error: { message: 'Invalid upload.' },
      });
    });

    it('uses the generic internal-error contract for unexpected failures', async () => {
      const response = sitesErrorResponse(new Error('object store unavailable'), request());

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        request_id: 'request-123',
        data: null,
        error: { message: 'object store unavailable' },
      });
    });
  });
});
