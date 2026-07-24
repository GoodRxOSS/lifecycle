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
import { unstable_noStore as noStore } from 'next/cache';
import { isDynamicUsageError } from 'next/dist/export/helpers/is-dynamic-usage-error';
import { scopeSatisfies } from 'server/services/apiToken';
import { checkApiKeyRateLimit } from 'server/services/authRateLimit';
import { recordAuthAuditEvent } from 'server/services/authAudit';
import type { ApiTokenScope } from 'server/models/ApiToken';
import { errorResponse } from './response';
import { requireRole, type LifecycleRole } from './roles';
import { getRequestUserIdentity } from './get-user';
import { AppError, bearerChallenge, isAppError } from './appError';
import { resolvePrincipal, type Principal, type PrincipalKind } from './principal';

// eslint-disable-next-line no-unused-vars
type RouteHandler = (req: NextRequest, ...args: any[]) => Promise<NextResponse>;

// eslint-disable-next-line no-unused-vars
export type PrincipalRouteHandler = (req: NextRequest, principal: Principal, ...args: any[]) => Promise<NextResponse>;

export interface SessionApiHandlerOptions {
  auth: 'session';
  roles?: LifecycleRole[];
}

export interface PrincipalRoutePolicy {
  /** null = any authenticated principal; otherwise the key scope this method requires. */
  scope: ApiTokenScope | null;
  kinds?: PrincipalKind[];
}

type RoutePolicyMarker =
  | { readonly policy: 'session'; readonly roles?: readonly LifecycleRole[] }
  | { readonly policy: 'principal'; readonly scope: ApiTokenScope | null; readonly kinds?: readonly PrincipalKind[] }
  | { readonly policy: 'public' };

const INTERACTIVE_KEY_SHAPE = /^bearer\s+lfc_/i;

function attachRoutePolicy(handler: RouteHandler, marker: RoutePolicyMarker): RouteHandler {
  if ('roles' in marker && marker.roles) Object.freeze(marker.roles);
  if ('kinds' in marker && marker.kinds) Object.freeze(marker.kinds);
  Object.defineProperty(handler, '__routePolicy', { value: Object.freeze(marker), enumerable: false });
  return handler;
}

function unauthorizedResponse(error: AppError, req: NextRequest): NextResponse {
  const response = errorResponse(error, { status: 401 }, req);
  response.headers.set('WWW-Authenticate', bearerChallenge(error.code));
  return response;
}

function authenticationRequired(): AppError {
  return new AppError({ httpStatus: 401, code: 'authentication_required', message: 'Authentication is required.' });
}

function forbiddenRole(): AppError {
  return new AppError({
    httpStatus: 403,
    code: 'forbidden_role',
    message: 'This API requires the user or admin role.',
  });
}

function hasBaseRole(roles: readonly LifecycleRole[]): boolean {
  return roles.includes('user') || roles.includes('admin');
}

/** auth_audit_events.route/requestId are varchar(255); an overlong caller-chosen path or header must not void the row. */
const AUDIT_FIELD_MAX_LENGTH = 255;

/** Durable trail for authorization denials; best-effort so auditing can never turn a 403 into a 500. */
async function recordDeniedPrincipal(req: NextRequest, principal: Principal, error: AppError): Promise<void> {
  await recordAuthAuditEvent({
    event: 'auth.denied',
    principalKind: principal.kind,
    principalId: principal.userId,
    actorId: principal.actor,
    tokenId: principal.tokenId,
    requestId: req.headers.get('x-request-id')?.slice(0, AUDIT_FIELD_MAX_LENGTH) ?? null,
    route: `${req.method} ${req.nextUrl.pathname}`.slice(0, AUDIT_FIELD_MAX_LENGTH),
    outcome: 'denied',
    meta: { reason: error.code, ...(error.details ?? {}) },
  });
}

async function deniedResponse(req: NextRequest, principal: Principal, error: AppError): Promise<NextResponse> {
  await recordDeniedPrincipal(req, principal, error);
  return errorResponse(error, { status: 403 }, req);
}

/** noStore + error-mapping core shared by the policy wrappers. */
function createBaseApiHandler(handler: RouteHandler): RouteHandler {
  return async (req: NextRequest, ...args: any[]) => {
    noStore();

    try {
      return await handler(req, ...args);
    } catch (error) {
      if (isDynamicUsageError(error)) {
        throw error;
      }

      // errorResponse honors AppError.httpStatus; non-AppErrors fall back to 500.
      return errorResponse(error, { status: 500 }, req);
    }
  };
}

/** Session-only route: rejects key-shaped bearers before any resolver/DB work, then requires a session. */
export function createApiHandler(handler: RouteHandler, options: SessionApiHandlerOptions): RouteHandler {
  const guarded = options.roles?.length ? requireRole(...options.roles)(handler) : handler;

  const wrapped = createBaseApiHandler(async (req: NextRequest, ...args: any[]) => {
    const authorization = req.headers.get('authorization');
    if (authorization && INTERACTIVE_KEY_SHAPE.test(authorization)) {
      return errorResponse(
        new AppError({
          httpStatus: 403,
          code: 'interactive_auth_required',
          message: 'This endpoint requires an interactive session; API keys are not accepted here.',
        }),
        { status: 403 },
        req
      );
    }

    const identity = getRequestUserIdentity(req);
    if (!identity) {
      return unauthorizedResponse(authenticationRequired(), req);
    }
    if (!hasBaseRole(identity.roles)) {
      return errorResponse(forbiddenRole(), { status: 403 }, req);
    }

    return guarded(req, ...args);
  });

  return attachRoutePolicy(wrapped, {
    policy: 'session',
    ...(options.roles?.length ? { roles: options.roles } : {}),
  });
}

/** Session-or-key route: resolves a Principal, then enforces role, kind, and scope policy. */
export function createPrincipalApiHandler(policy: PrincipalRoutePolicy, handler: PrincipalRouteHandler): RouteHandler {
  const wrapped = createBaseApiHandler(async (req: NextRequest, ...args: any[]) => {
    let principal: Principal;
    try {
      principal = await resolvePrincipal(req);
    } catch (error) {
      if (isAppError(error) && error.httpStatus === 401) {
        return unauthorizedResponse(error, req);
      }
      throw error;
    }

    // Rate limit right after resolution and before kind/scope checks: a denied request still spends the bucket.
    if (principal.authMethod === 'api_key') {
      const rateLimit = await checkApiKeyRateLimit(principal);
      if (!rateLimit.allowed) {
        const response = errorResponse(
          new AppError({
            httpStatus: 429,
            code: 'rate_limited',
            message: 'API rate limit exceeded; slow down and retry.',
            retryable: true,
          }),
          { status: 429 },
          req
        );
        response.headers.set('Retry-After', String(rateLimit.retryAfterSeconds));
        return response;
      }
    }

    if (principal.kind === 'user' && !hasBaseRole(principal.roles)) {
      return deniedResponse(req, principal, forbiddenRole());
    }

    if (policy.kinds && !policy.kinds.includes(principal.kind)) {
      return deniedResponse(
        req,
        principal,
        new AppError({
          httpStatus: 403,
          code: 'forbidden_credential_kind',
          message: `This endpoint does not accept ${principal.kind} credentials.`,
          details: { allowedKinds: policy.kinds },
        })
      );
    }

    if (principal.scopes !== null && policy.scope !== null && !scopeSatisfies(principal.scopes, policy.scope)) {
      const response = await deniedResponse(
        req,
        principal,
        new AppError({
          httpStatus: 403,
          code: 'forbidden_scope',
          message: `This endpoint requires the ${policy.scope} scope.`,
          details: { requiredScope: policy.scope, grantedScopes: principal.scopes },
        })
      );
      response.headers.set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${policy.scope}"`);
      return response;
    }

    try {
      return await handler(req, principal, ...args);
    } catch (error) {
      // repositoryAuthorization.ts allowlist gates throw from inside handlers; capture them in the same trail.
      if (isAppError(error) && error.code === 'forbidden_repository') {
        await recordDeniedPrincipal(req, principal, error);
      }
      throw error;
    }
  });

  return attachRoutePolicy(wrapped, {
    policy: 'principal',
    scope: policy.scope,
    ...(policy.kinds ? { kinds: policy.kinds } : {}),
  });
}

/** No platform auth; the handler owns its own authentication (OAuth callback state param). */
export function createPublicApiHandler(handler: RouteHandler): RouteHandler {
  return attachRoutePolicy(createBaseApiHandler(handler), { policy: 'public' });
}
