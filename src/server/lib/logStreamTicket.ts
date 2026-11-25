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

import { issueGrantEnvelope, openGrant, sealGrant, secondsUntil, type OpaqueGrantKind } from 'server/lib/opaqueGrant';

const LOG_STREAM_TICKET: OpaqueGrantKind = { prefix: 'lfclt_v1', aad: 'lifecycle.log-stream-ticket.v1' };

export const LOG_STREAM_TICKET_TTL_SECONDS = 5 * 60;

export interface LogStreamTarget {
  namespace: string;
  podName: string;
  containerName: string;
}

export interface LogStreamTicketClaims extends LogStreamTarget {
  v: 1;
  buildUuid: string;
  actor: string;
  iat: number;
  exp: number;
  jti: string;
}

export function createLogStreamTicket(input: LogStreamTarget & { buildUuid: string; actor: string }): {
  ticket: string;
  claims: LogStreamTicketClaims;
  maxAgeSeconds: number;
} {
  const { iat, exp, jti, maxAgeSeconds } = issueGrantEnvelope(LOG_STREAM_TICKET_TTL_SECONDS);
  const claims: LogStreamTicketClaims = {
    v: 1,
    buildUuid: input.buildUuid,
    namespace: input.namespace,
    podName: input.podName,
    containerName: input.containerName,
    actor: input.actor,
    iat,
    exp,
    jti,
  };
  return { ticket: sealGrant(LOG_STREAM_TICKET, claims), claims, maxAgeSeconds };
}

function isClaimsShape(value: unknown): value is LogStreamTicketClaims {
  const claims = value as Partial<LogStreamTicketClaims> | null;
  return (
    claims?.v === 1 &&
    typeof claims.buildUuid === 'string' &&
    claims.buildUuid.length > 0 &&
    typeof claims.namespace === 'string' &&
    claims.namespace.length > 0 &&
    typeof claims.podName === 'string' &&
    claims.podName.length > 0 &&
    typeof claims.containerName === 'string' &&
    claims.containerName.length > 0 &&
    typeof claims.actor === 'string' &&
    claims.actor.length > 0 &&
    typeof claims.iat === 'number' &&
    Number.isSafeInteger(claims.iat) &&
    typeof claims.exp === 'number' &&
    Number.isSafeInteger(claims.exp) &&
    claims.exp > claims.iat &&
    claims.exp - claims.iat <= LOG_STREAM_TICKET_TTL_SECONDS &&
    typeof claims.jti === 'string' &&
    claims.jti.length > 0
  );
}

export function readLogStreamTicketClaims(ticket: string | null | undefined): LogStreamTicketClaims | null {
  const claims = openGrant(LOG_STREAM_TICKET, ticket);
  if (!isClaimsShape(claims) || secondsUntil(claims.exp) <= 0) {
    return null;
  }
  return claims;
}
