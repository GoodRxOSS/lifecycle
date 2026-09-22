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

import swaggerJSDoc from 'swagger-jsdoc';
import { openApiSpecificationForV2Api } from '../openApiSpec';
import { V2_ROUTE_POLICY_MANIFEST, type V2RoutePolicyEntry } from '../../server/lib/v2RoutePolicyManifest';
import { API_TOKEN_SCOPES, USER_TOKEN_CEILING } from '../../server/services/apiToken';

const spec = swaggerJSDoc(openApiSpecificationForV2Api) as any;

// A few operations are documented under a public path that diverges from the manifest's filesystem
// route key (job list endpoints, and catch-all `{fullName+}` params rendered as `{owner}/{repo}`).
const SPEC_PATH_ALIASES: Record<string, string> = {
  '/api/v2/builds/{uuid}/services/{name}/build-jobs': '/api/v2/builds/{uuid}/services/{name}/builds',
  '/api/v2/builds/{uuid}/services/{name}/deploy-jobs': '/api/v2/builds/{uuid}/services/{name}/deploys',
  '/api/v2/repositories/{fullName+}': '/api/v2/repositories/{owner}/{repo}',
  '/api/v2/ai/agent/runtime-config/repos/{fullName+}': '/api/v2/ai/agent/runtime-config/repos/{owner}/{repo}',
  '/api/v2/ai/config/agent-session/repos/{fullName+}': '/api/v2/ai/config/agent-session/repos/{owner}/{repo}',
};

// Methods with no @openapi block in the route tree today. Listed so a NEW undocumented method fails
// the guard while this pre-existing gap does not.
const KNOWN_UNDOCUMENTED = ['POST /api/v2/ai/agent/preview-grants'];

const keyOf = (entry: { method: string; route: string }) => `${entry.method} ${entry.route}`;

function operationFor(entry: V2RoutePolicyEntry): any {
  const route = SPEC_PATH_ALIASES[entry.route] ?? entry.route;
  return spec.paths?.[route]?.[entry.method.toLowerCase()];
}

function requirementObjects(security: unknown): Record<string, unknown>[] {
  return Array.isArray(security) ? (security as Record<string, unknown>[]) : [];
}

function offersScheme(security: unknown, scheme: string): boolean {
  return requirementObjects(security).some((req) => req && Object.prototype.hasOwnProperty.call(req, scheme));
}

/** OR semantics: two separate single-scheme requirement objects, never both schemes AND-ed in one object. */
function isBearerAuthOrLifecycleKey(security: unknown): boolean {
  const reqs = requirementObjects(security);
  return (
    reqs.length === 2 &&
    reqs.every((req) => Object.keys(req).length === 1) &&
    reqs.some((req) => 'BearerAuth' in req) &&
    reqs.some((req) => 'LifecycleApiKey' in req)
  );
}

function principalSecurity(entry: Extract<V2RoutePolicyEntry, { policy: 'principal' }>) {
  const kinds = entry.kinds ?? ['user', 'personal_key', 'service_key'];
  return [
    ...(kinds.includes('user') ? [{ BearerAuth: [] }] : []),
    ...(kinds.some((kind) => kind === 'personal_key' || kind === 'service_key') ? [{ LifecycleApiKey: [] }] : []),
  ];
}

describe('OpenAPI v2 security contract', () => {
  it('preserves BearerAuth while declaring descriptive session and Lifecycle API-key schemes', () => {
    const schemes = spec.components.securitySchemes;
    expect(Object.keys(schemes).sort()).toEqual(['BearerAuth', 'KeycloakBearer', 'LifecycleApiKey']);
    expect(schemes.BearerAuth).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    expect(schemes.KeycloakBearer).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    expect(schemes.LifecycleApiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(schemes.LifecycleApiKey.description).toMatch(/lfc_pat_/);
    expect(schemes.LifecycleApiKey.description).toMatch(/lfc_svc_/);
  });
  it('defaults globally to the Keycloak session only', () => {
    expect(spec.security).toEqual([{ BearerAuth: [] }]);
  });

  it('documents the server scope vocabulary and offers only grantable scopes on issuance', () => {
    expect([...spec.components.schemas.ApiTokenScope.enum].sort()).toEqual([...API_TOKEN_SCOPES].sort());
    expect([...spec.components.schemas.ApiTokenGrantableScope.enum].sort()).toEqual([...USER_TOKEN_CEILING].sort());
    expect(spec.components.schemas.ApiTokenGrantableScope.enum).not.toContain('env:admin');
  });

  it('matches allowed principal kinds and requires handler credentials on every principal operation', () => {
    const missing: string[] = [];
    const mismatched: string[] = [];

    for (const entry of V2_ROUTE_POLICY_MANIFEST) {
      if (entry.policy !== 'principal') continue;
      const op = operationFor(entry);
      if (!op) {
        missing.push(keyOf(entry));
        continue;
      }
      // The array contains credential alternatives (OR); each object contains mandatory credentials (AND).
      // Compare complete objects, including scopes, so an extra anonymous or signature-only alternative fails.
      try {
        expect(op.security).toEqual(principalSecurity(entry));
      } catch {
        mismatched.push(`${keyOf(entry)} -> ${JSON.stringify(op.security)}`);
      }
    }

    // Every principal route must be documented: a future one that isn't fails here by name.
    expect({ missing, mismatched }).toEqual({ missing: [], mismatched: [] });
  });

  it('never offers LifecycleApiKey on a session operation', () => {
    const leaked: string[] = [];
    for (const entry of V2_ROUTE_POLICY_MANIFEST) {
      if (entry.policy !== 'session') continue;
      const op = operationFor(entry);
      if (!op) continue; // undocumented session ops inherit the KeycloakBearer-only global default.
      if (offersScheme(op.security, 'LifecycleApiKey')) leaked.push(keyOf(entry));
    }
    expect(leaked).toEqual([]);
  });

  it('covers every public operation, including anonymous public-link resolution', () => {
    for (const entry of V2_ROUTE_POLICY_MANIFEST) {
      if (entry.policy !== 'public') continue;
      expect({ operation: keyOf(entry), security: operationFor(entry)?.security }).toEqual({
        operation: keyOf(entry),
        security: [],
      });
    }
  });

  it('documents only JWT-authenticated mint and its minimal body', () => {
    const op = spec.paths['/api/v2/sites/browser/mint'].post;
    expect(op.security).toEqual([{ BearerAuth: [] }]);
    expect(op.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/SitesBrowserMintRequest',
    });
    expect(spec.components.schemas.SitesBrowserMintRequest.required).toEqual(['siteId', 'state']);
    expect(spec.components.schemas.SitesBrowserMintRequest.additionalProperties).toBe(false);
    expect(
      Object.keys(op.responses['200'].content['application/json'].schema.properties.data.properties).sort()
    ).toEqual(['consumeUrl', 'ticket']);
    expect(spec.paths['/api/v2/sites/browser/open/{siteId}'].get.security).toEqual([]);
    for (const action of ['bind', 'revoke']) {
      expect(spec.paths[`/api/v2/sites/browser/${action}`]).toBeUndefined();
    }
    expect(spec.components.schemas.SitesBrowserLoginRequest).toBeUndefined();
    expect(spec.components.schemas.SitesBrowserBindRequest).toBeUndefined();
  });

  it('documents auth/context with the OR form under operationId getAuthContext', () => {
    const op = spec.paths['/api/v2/auth/context'].get;
    expect(op.operationId).toBe('getAuthContext');
    expect(isBearerAuthOrLifecycleKey(op.security)).toBe(true);
  });

  it('leaves only known pre-existing methods undocumented', () => {
    const undocumented = V2_ROUTE_POLICY_MANIFEST.filter((entry) => !operationFor(entry)).map(keyOf);
    expect(undocumented.sort()).toEqual([...KNOWN_UNDOCUMENTED].sort());
  });
});
