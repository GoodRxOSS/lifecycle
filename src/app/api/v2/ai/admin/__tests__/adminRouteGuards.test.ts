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

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ADMIN_ROUTES_DIR = join(__dirname, '..');

function collectRouteFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectRouteFiles(full));
    } else if (entry === 'route.ts') {
      files.push(full);
    }
  }
  return files;
}

// SECURITY: admin authz is per-route; an unguarded sibling is silently open to any authenticated user.
describe('agent admin route authorization', () => {
  const routeFiles = collectRouteFiles(ADMIN_ROUTES_DIR);
  // Any export form counts — a raw handler export must fail the scan, not slip past it.
  const methodExport = /export\s+(?:const|let|var|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
  const wrappedExport = /export const (?:GET|POST|PUT|PATCH|DELETE)\s*=\s*createApiHandler\(([\s\S]*?)\);/g;

  it('discovers admin route files', () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  for (const file of routeFiles) {
    it(`guards every handler in ${file.slice(file.indexOf('/admin/'))} with roles: ['admin']`, () => {
      const source = readFileSync(file, 'utf-8');
      const exportedMethods = [...source.matchAll(methodExport)];
      const wrapped = [...source.matchAll(wrappedExport)];
      expect(exportedMethods.length).toBeGreaterThan(0);
      // Every exported method must be a createApiHandler(...) export...
      expect(wrapped.length).toBe(exportedMethods.length);
      // ...and every one of those must carry the admin role guard.
      for (const match of wrapped) {
        expect(match[1]).toMatch(/roles:\s*\[\s*'admin'\s*\]/);
      }
    });
  }
});
