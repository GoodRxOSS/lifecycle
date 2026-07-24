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

import { collectV2RouteOperations } from '../../../../scripts/v2RouteInventory';
import { V2_ROUTE_POLICY_MANIFEST, type V2KeyScope } from '../v2RoutePolicyManifest';

const KEY_SCOPES: readonly V2KeyScope[] = [
  'env:read',
  'env:write',
  'sites:read',
  'sites:write',
  'repos:read',
  'repos:write',
];

const ANY_PRINCIPAL_ROUTES = ['GET /api/v2/auth/context'];

const keyOf = (entry: { method: string; route: string }) => `${entry.method} ${entry.route}`;

describe('v2 route policy manifest', () => {
  const operations = collectV2RouteOperations();
  const operationKeys = new Set(operations.map(keyOf));
  const manifestByKey = new Map(V2_ROUTE_POLICY_MANIFEST.map((entry) => [keyOf(entry), entry]));

  it('covers every exported v2 method exactly once', () => {
    expect(V2_ROUTE_POLICY_MANIFEST.length).toBe(manifestByKey.size);

    const unclassified = operations.map(keyOf).filter((k) => !manifestByKey.has(k));
    const stale = [...manifestByKey.keys()].filter((k) => !operationKeys.has(k));
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });

  it('declares the OAuth callback as the only public method', () => {
    const publicKeys = V2_ROUTE_POLICY_MANIFEST.filter((e) => e.policy === 'public').map(keyOf);
    expect(publicKeys).toEqual(['GET /api/v2/ai/agent/mcp-connections/{slug}/oauth/callback']);
  });

  it('keeps every admin-guarded method session-only with the admin role', () => {
    const mismatched = operations
      .filter((op) => op.guard === 'admin')
      .filter((op) => {
        const entry = manifestByKey.get(keyOf(op));
        return entry?.policy !== 'session' || entry.roles?.[0] !== 'admin';
      })
      .map(keyOf);
    expect(mismatched).toEqual([]);
  });

  it('keeps every machine-handled method principal with its declared scope', () => {
    const mismatched = operations
      .filter((op) => op.guard === 'machine')
      .filter((op) => {
        const entry = manifestByKey.get(keyOf(op));
        return entry?.policy !== 'principal' || entry.scope !== op.machineScope;
      })
      .map(keyOf);
    expect(mismatched).toEqual([]);
  });

  it('never grants API keys under ai/ or token management', () => {
    const violations = V2_ROUTE_POLICY_MANIFEST.filter(
      (e) =>
        e.policy === 'principal' &&
        (e.route.startsWith('/api/v2/ai/') ||
          e.route.startsWith('/api/v2/me/tokens') ||
          e.route.startsWith('/api/v2/tokens'))
    ).map(keyOf);
    expect(violations).toEqual([]);
  });

  it('applies the wrapper the manifest declares, in source', () => {
    const WRAPPER_BY_POLICY = {
      session: 'createApiHandler',
      principal: 'createPrincipalApiHandler',
      public: 'createPublicApiHandler',
    } as const;

    const mismatched = operations
      .map((op) => {
        const entry = manifestByKey.get(keyOf(op));
        if (!entry) return null;
        const expected = WRAPPER_BY_POLICY[entry.policy];
        return op.wrapper === expected ? null : `${keyOf(op)}: expected ${expected}, found ${op.wrapper ?? 'none'}`;
      })
      .filter(Boolean);
    expect(mismatched).toEqual([]);
  });

  it('passes the manifest scope to every principal wrapper, in source', () => {
    const mismatched = operations
      .map((op) => {
        const entry = manifestByKey.get(keyOf(op));
        if (entry?.policy !== 'principal') return null;
        if (!op.hasScopeDeclaration) return `${keyOf(op)}: principal wrapper declares no scope`;
        return op.declaredScope === entry.scope
          ? null
          : `${keyOf(op)}: expected scope ${entry.scope ?? 'null'}, found ${op.declaredScope ?? 'null'}`;
      })
      .filter(Boolean);
    expect(mismatched).toEqual([]);
  });

  it('passes the admin role to every admin-guarded wrapper, in source', () => {
    const mismatched = operations
      .map((op) => {
        const entry = manifestByKey.get(keyOf(op));
        if (entry?.policy !== 'session' || !entry.roles) return null;
        return op.declaredRoles?.includes('admin') ? null : `${keyOf(op)}: admin role not declared in source`;
      })
      .filter(Boolean);
    expect(mismatched).toEqual([]);
  });

  it('leaves no route on the deleted machine handler', () => {
    const stragglers = operations.filter((op) => op.wrapper === 'createMachineApiHandler').map(keyOf);
    expect(stragglers).toEqual([]);
  });

  it('scopes every principal method within the fixed vocabulary', () => {
    const anyPrincipal = V2_ROUTE_POLICY_MANIFEST.filter((e) => e.policy === 'principal' && e.scope === null).map(
      keyOf
    );
    expect(anyPrincipal).toEqual(ANY_PRINCIPAL_ROUTES);

    const invalidScopes = V2_ROUTE_POLICY_MANIFEST.filter(
      (e) => e.policy === 'principal' && e.scope !== null && !KEY_SCOPES.includes(e.scope)
    ).map(keyOf);
    expect(invalidScopes).toEqual([]);
  });
});
