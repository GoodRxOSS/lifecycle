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

import { applyMcpDefaultToolArgs } from '../runtimeConfig';

describe('applyMcpDefaultToolArgs', () => {
  const inputSchema = {
    type: 'object',
    properties: {
      siteUrl: { type: 'string' },
      includeArchived: { type: 'boolean' },
      limit: { type: 'integer' },
    },
  };

  it('applies missing defaults for declared schema properties', () => {
    expect(
      applyMcpDefaultToolArgs(
        inputSchema,
        {
          siteUrl: 'https://sample-site.example.com',
          includeArchived: 'true',
          limit: '25',
        },
        {}
      )
    ).toEqual({
      siteUrl: 'https://sample-site.example.com',
      includeArchived: true,
      limit: 25,
    });
  });

  it('does not override explicit input values', () => {
    expect(
      applyMcpDefaultToolArgs(
        inputSchema,
        {
          siteUrl: 'https://sample-site.example.com',
          includeArchived: 'true',
        },
        {
          siteUrl: 'https://override.example.com',
          includeArchived: false,
        }
      )
    ).toEqual({
      siteUrl: 'https://override.example.com',
      includeArchived: false,
    });
  });

  it('ignores defaults for undeclared schema properties', () => {
    expect(
      applyMcpDefaultToolArgs(
        inputSchema,
        {
          tenantId: 'tenant-123',
        },
        {}
      )
    ).toEqual({});
  });
});
