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

import fs from 'fs';
import os from 'os';
import path from 'path';
import { collectV2RouteOperations } from '../../../../scripts/v2RouteInventory';

describe('collectV2RouteOperations', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-route-inventory-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeRoute = (route: string, contents: string, filename = 'route.ts') => {
    const dir = path.join(root, route);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), contents);
  };

  it('extracts wrapper, scope, and roles from wrapped const exports', () => {
    writeRoute(
      'things',
      `export const GET = createPrincipalApiHandler({ scope: 'env:read', auth: 'session' }, handler);
       export const POST = createApiHandler({ auth: 'session', roles: ['admin'] }, handler);`
    );
    const operations = collectV2RouteOperations(root);
    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({
      method: 'GET',
      route: '/api/v2/things',
      wrapper: 'createPrincipalApiHandler',
      declaredScope: 'env:read',
      hasScopeDeclaration: true,
    });
    expect(operations[1]).toMatchObject({
      method: 'POST',
      wrapper: 'createApiHandler',
      guard: 'admin',
      declaredRoles: ['admin'],
      declaresSessionAuth: true,
    });
  });

  it('sees function-declaration exports as unwrapped methods', () => {
    writeRoute(
      'things',
      `export async function GET(request: Request) { return new Response('ok'); }
       export function DELETE() { return createApiHandler; }`
    );
    const operations = collectV2RouteOperations(root);
    expect(operations.map((op) => [op.method, op.wrapper, op.guard])).toEqual([
      ['DELETE', null, 'plain'],
      ['GET', null, 'plain'],
    ]);
  });

  it('sees HEAD and OPTIONS exports', () => {
    writeRoute(
      'things',
      `export async function HEAD() { return new Response(null); }
       export const OPTIONS = createApiHandler({ auth: 'session' }, handler);`
    );
    const operations = collectV2RouteOperations(root);
    expect(operations.map((op) => [op.method, op.wrapper])).toEqual([
      ['HEAD', null],
      ['OPTIONS', 'createApiHandler'],
    ]);
  });

  it('resolves local re-exports to their wrapped definitions', () => {
    writeRoute(
      'things',
      `const handler = createApiHandler({ auth: 'session' }, impl);
       const POST = createPrincipalApiHandler({ scope: 'env:write' }, impl);
       export { handler as GET, POST };`
    );
    const operations = collectV2RouteOperations(root);
    expect(operations.map((op) => [op.method, op.wrapper, op.declaredScope])).toEqual([
      ['GET', 'createApiHandler', null],
      ['POST', 'createPrincipalApiHandler', 'env:write'],
    ]);
  });

  it('sees cross-file and namespace re-exports as unwrapped methods', () => {
    writeRoute(
      'things',
      `export { GET, POST as PUT } from './handlers';
       export * as OPTIONS from './handlers';`
    );
    const operations = collectV2RouteOperations(root);
    expect(operations.map((op) => [op.method, op.wrapper])).toEqual([
      ['GET', null],
      ['OPTIONS', null],
      ['PUT', null],
    ]);
  });

  it('sees destructured method exports as unwrapped methods', () => {
    writeRoute('things', `export const { GET, POST } = handlers;`);
    const operations = collectV2RouteOperations(root);
    expect(operations.map((op) => [op.method, op.wrapper])).toEqual([
      ['GET', null],
      ['POST', null],
    ]);
  });

  it('throws on star re-exports it cannot enumerate', () => {
    writeRoute('things', `export * from './handlers';`);
    expect(() => collectV2RouteOperations(root)).toThrow("'export *' hides route methods");
  });

  it('scans route files under every extension Next.js serves', () => {
    writeRoute('a', `export const GET = createApiHandler({ auth: 'session' }, handler);`, 'route.tsx');
    writeRoute('b', `export async function POST(request) { return new Response('ok'); }`, 'route.js');
    writeRoute('c', `export const PUT = createPrincipalApiHandler({ scope: 'env:read' }, handler);`, 'route.jsx');
    writeRoute('d', `export const DELETE = createApiHandler({ auth: 'session' }, handler);`, 'route.mjs');

    const operations = collectV2RouteOperations(root);
    expect(operations.map((op) => [op.route, op.method, op.wrapper])).toEqual([
      ['/api/v2/a', 'GET', 'createApiHandler'],
      ['/api/v2/b', 'POST', null],
      ['/api/v2/c', 'PUT', 'createPrincipalApiHandler'],
      ['/api/v2/d', 'DELETE', 'createApiHandler'],
    ]);
  });

  it('throws on a route file whose extension is outside the scanned set', () => {
    writeRoute('things', `export const GET = createApiHandler({ auth: 'session' }, handler);`, 'route.mts');
    expect(() => collectV2RouteOperations(root)).toThrow('route.mts');
  });

  it('ignores colocated route.test.ts files', () => {
    writeRoute('things', `export const GET = createApiHandler({ auth: 'session' }, handler);`);
    writeRoute('things', `export const POST = handlers.POST;`, 'route.test.ts');

    expect(collectV2RouteOperations(root).map((op) => op.method)).toEqual(['GET']);
  });

  it('ignores default and non-method exports', () => {
    writeRoute(
      'things',
      `export default function GET() {}
       export const helper = createApiHandler({ auth: 'session' }, impl);
       export { helper as buildThing };`
    );
    expect(collectV2RouteOperations(root)).toEqual([]);
  });
});
