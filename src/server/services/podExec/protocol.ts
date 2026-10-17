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

import type { Principal } from 'server/lib/principal';

/** V2 shell protocol. Existing login token is sent once, in memory only. */
export type Target = {
  buildId: number;
  uuid: string;
  namespace: string;
  podName: string;
  podUid: string;
  container: string;
  containerId: string;
  restartCount: number;
};
export type ShellSession = {
  principal: Principal;
  sessionId: string;
  userId: string;
  target: Target;
  shell: '/bin/sh' | '/bin/bash';
  cols: number;
  rows: number;
  tokenExpiresAt: number;
};
export type AuthFrame = {
  type: 'auth';
  accessToken: string;
  container: string;
  podUid: string;
  restartCount: number;
  shell: '/bin/sh' | '/bin/bash';
  cols: number;
  rows: number;
};
export type ClientFrame =
  | AuthFrame
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'disconnect' };
export type ServerFrame =
  | { type: 'ready'; sessionId: string }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; code: string; message: string };
export function size(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 2 && Number(value) <= 500;
}
export function parseFrame(text: string): ClientFrame {
  if (Buffer.byteLength(text) > 32768) throw new Error('frame_too_large');
  const m = JSON.parse(text);
  if (
    m?.type === 'auth' &&
    typeof m.accessToken === 'string' &&
    m.accessToken.length > 0 &&
    Buffer.byteLength(m.accessToken) <= 16384 &&
    typeof m.container === 'string' &&
    m.container.length > 0 &&
    m.container.length <= 253 &&
    typeof m.podUid === 'string' &&
    m.podUid.length > 0 &&
    m.podUid.length <= 128 &&
    Number.isInteger(m.restartCount) &&
    m.restartCount >= 0 &&
    ['/bin/sh', '/bin/bash'].includes(m.shell) &&
    size(m.cols) &&
    size(m.rows)
  )
    return m;
  if (m?.type === 'input' && typeof m.data === 'string' && Buffer.byteLength(m.data) <= 8192) return m;
  if (m?.type === 'resize' && size(m.cols) && size(m.rows)) return m;
  if (m?.type === 'disconnect') return m;
  throw new Error('invalid_frame');
}
