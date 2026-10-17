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

import { ExecError } from './errors';
import { randomUUID } from 'node:crypto';
import { verifyBearerToken } from 'server/lib/auth';
import { getIdentityFromClaims } from 'server/lib/get-user';
import type { Principal } from 'server/lib/principal';
import { recordAuthAuditEvent } from 'server/services/authAudit';
import { resolveTarget } from './target';
import type { AuthFrame, ShellSession } from './protocol';

/** Verify the existing login independently of HTTP middleware. */
export async function authenticateAccessToken(token: string) {
  if (process.env.ENABLE_AUTH !== 'true') throw new ExecError('auth_required');
  const verified = await verifyBearerToken(token);
  if (!verified.success || !verified.payload) throw new ExecError('invalid_credential');
  const identity = getIdentityFromClaims(verified.payload);
  const exp = verified.payload.exp;
  if (
    !identity ||
    !identity.roles.some((r) => r === 'user' || r === 'admin') ||
    typeof exp !== 'number' ||
    !Number.isFinite(exp * 1000) ||
    exp * 1000 <= Date.now()
  )
    throw new ExecError('forbidden');
  const principal: Principal = {
    kind: 'user',
    authMethod: 'session',
    userId: identity.userId,
    actor: identity.userId,
    roles: identity.roles,
    scopes: null,
    tokenId: null,
    repositoryAllowlist: null,
    repositoryAllowlistRepoIds: null,
    identity,
  };
  return { principal, tokenExpiresAt: exp * 1000 };
}

export function createShellPorts(isEnabled: () => boolean | Promise<boolean>) {
  return {
    async authorize(frame: AuthFrame, uuid: string, podName: string): Promise<ShellSession> {
      const { principal, tokenExpiresAt } = await authenticateAccessToken(frame.accessToken);
      if (!(await isEnabled())) throw new ExecError('exec_disabled');
      const target = await resolveTarget(principal, uuid, podName, frame.container);
      if (target.podUid !== frame.podUid || target.restartCount !== frame.restartCount) {
        throw new ExecError('target_changed');
      }
      if (tokenExpiresAt <= Date.now()) throw new ExecError('invalid_credential');
      const session: ShellSession = {
        principal,
        sessionId: randomUUID(),
        userId: principal.userId!,
        target,
        shell: frame.shell,
        cols: frame.cols,
        rows: frame.rows,
        tokenExpiresAt,
      };
      void recordAuthAuditEvent({
        event: 'pod.exec.opening',
        principalKind: 'user',
        principalId: session.userId,
        outcome: 'allowed',
        meta: { sessionId: session.sessionId, ...target, shell: session.shell },
      });
      return session;
    },
    async revalidate(session: ShellSession) {
      if (!(await isEnabled())) throw new ExecError('exec_disabled');
      const build = session.target;
      await resolveTarget(session.principal, build.uuid, build.podName, build.container, build);
    },
    async denied(reason: string) {
      await recordAuthAuditEvent({ event: 'pod.exec.denied', principalKind: 'anonymous', outcome: reason });
    },
    async finish(session: ShellSession, reason: string) {
      void recordAuthAuditEvent({
        event: 'pod.exec.closed',
        principalKind: 'user',
        principalId: session.userId,
        outcome: reason,
        meta: { sessionId: session.sessionId, ...session.target },
      });
    },
  };
}
