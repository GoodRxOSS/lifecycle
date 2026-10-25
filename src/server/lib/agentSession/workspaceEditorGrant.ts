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

import { randomUUID } from 'crypto';
import { openGrant, sealGrant, type OpaqueGrantKind } from 'server/lib/opaqueGrant';

const EDITOR_GRANT: OpaqueGrantKind = {
  prefix: 'lfceg_v1',
  aad: 'lifecycle.workspace-editor-grant.v1',
};
export const WORKSPACE_EDITOR_GRANT_TTL_SECONDS = 60 * 60;
const WORKSPACE_EDITOR_CLOCK_SKEW_SECONDS = 60;

export interface WorkspaceEditorGrantClaims {
  v: 1;
  purpose: 'workspace-editor';
  sessionId: string;
  userId: string;
  iat: number;
  exp: number;
  jti: string;
}

type EditorIdentity = Pick<WorkspaceEditorGrantClaims, 'sessionId' | 'userId'>;

export function createWorkspaceEditorGrant({
  sessionId,
  userId,
  tokenExpiresAt,
}: EditorIdentity & { tokenExpiresAt: number }): {
  grant: string;
  claims: WorkspaceEditorGrantClaims;
  maxAgeSeconds: number;
} {
  const iat = Math.floor(Date.now() / 1000);
  const exp = Math.min(iat + WORKSPACE_EDITOR_GRANT_TTL_SECONDS, Math.floor(tokenExpiresAt));
  if (!sessionId || !userId || !Number.isFinite(tokenExpiresAt) || !Number.isSafeInteger(exp) || exp <= iat) {
    throw new Error('Authentication token must have a future expiry to open the editor.');
  }
  const claims: WorkspaceEditorGrantClaims = {
    v: 1,
    purpose: 'workspace-editor',
    sessionId,
    userId,
    iat,
    exp,
    jti: randomUUID(),
  };
  return { grant: sealGrant(EDITOR_GRANT, claims), claims, maxAgeSeconds: exp - iat };
}

export function readWorkspaceEditorGrantClaims(grant: string | null | undefined): WorkspaceEditorGrantClaims | null {
  const claims = openGrant(EDITOR_GRANT, grant) as Partial<WorkspaceEditorGrantClaims> | null;
  const now = Math.floor(Date.now() / 1000);
  if (
    claims?.v !== 1 ||
    claims.purpose !== 'workspace-editor' ||
    typeof claims.sessionId !== 'string' ||
    !claims.sessionId ||
    typeof claims.userId !== 'string' ||
    !claims.userId ||
    typeof claims.iat !== 'number' ||
    !Number.isSafeInteger(claims.iat) ||
    claims.iat > now + WORKSPACE_EDITOR_CLOCK_SKEW_SECONDS ||
    typeof claims.exp !== 'number' ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > WORKSPACE_EDITOR_GRANT_TTL_SECONDS ||
    typeof claims.jti !== 'string' ||
    !claims.jti
  ) {
    return null;
  }
  return claims as WorkspaceEditorGrantClaims;
}

export function verifyWorkspaceEditorGrant(grant: string | null | undefined, expected: EditorIdentity): boolean {
  const claims = readWorkspaceEditorGrantClaims(grant);
  return Boolean(claims && claims.sessionId === expected.sessionId && claims.userId === expected.userId);
}
