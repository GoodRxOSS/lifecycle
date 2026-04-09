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

import type { JWTPayload } from 'jose';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { ErrorResponse } from './response';
import { getUser } from './get-user';

export type LifecycleRole = 'lifecycle_user' | 'lifecycle_admin';

// eslint-disable-next-line no-unused-vars
type RouteHandler = (req: NextRequest, ...args: any[]) => Promise<NextResponse>;

export function getUserRoles(payload: JWTPayload): LifecycleRole[] {
  const realmAccess = payload.realm_access as { roles?: string[] } | undefined;
  const allRoles = realmAccess?.roles ?? [];
  return allRoles.filter((r): r is LifecycleRole => r === 'lifecycle_user' || r === 'lifecycle_admin');
}

export function requireRole(...roles: LifecycleRole[]) {
  return (handler: RouteHandler): RouteHandler => {
    return async (req: NextRequest, ...args: any[]) => {
      const user = getUser(req);

      if (!user) {
        return NextResponse.json(
          {
            request_id: req.headers.get('x-request-id'),
            error: { message: 'Unauthorized' },
            data: null,
          } satisfies ErrorResponse,
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const userRoles = getUserRoles(user);
      const hasRole = roles.some((r) => userRoles.includes(r));

      if (!hasRole) {
        return NextResponse.json(
          {
            request_id: req.headers.get('x-request-id'),
            error: { message: 'Forbidden: insufficient permissions' },
            data: null,
          } satisfies ErrorResponse,
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return handler(req, ...args);
    };
  };
}
