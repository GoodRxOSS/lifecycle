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

import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { attachExec, type BridgePorts, type OpenExec } from './bridge';
import { createShellPorts } from './authenticate';

export function podExecEnabled() {
  return process.env.POD_EXEC_ENABLED === 'true' && process.env.ENABLE_AUTH === 'true';
}
export function podExecOrigins() {
  return new Set(
    (process.env.POD_EXEC_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}
export function createExecUpgrade(
  options: {
    enabled?: () => boolean;
    origins?: () => Set<string>;
    ports?: Omit<BridgePorts, 'acquire' | 'release'>;
    openExec?: OpenExec;
  } = {}
) {
  const enabled = options.enabled ?? podExecEnabled;
  const origins = options.origins ?? podExecOrigins;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32768, perMessageDeflate: false });
  const connections = new Set<ReturnType<typeof attachExec>>();
  const users = new Map<string, number>();
  let draining = false;
  const ports: BridgePorts = {
    ...(options.ports ?? createShellPorts(enabled)),
    acquire(userId) {
      const count = users.get(userId) ?? 0;
      if (count >= 4) return false;
      users.set(userId, count + 1);
      return true;
    },
    release(userId) {
      const count = (users.get(userId) ?? 1) - 1;
      if (count) users.set(userId, count);
      else users.delete(userId);
    },
  };
  const disableCheck = setInterval(() => {
    if (!enabled()) for (const close of connections) close('exec_disabled');
  }, 1000);
  disableCheck.unref();
  function handle(req: IncomingMessage, socket: Socket, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', 'http://internal.invalid');
    const match = /^\/api\/v2\/builds\/([^/]+)\/pods\/([^/]+)\/exec$/.exec(url.pathname);
    if (!match) return false;
    socket.on('error', () => socket.destroy());
    function reject(code: number, reason: string) {
      socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
    if (draining || !enabled()) {
      reject(503, 'Service Unavailable');
      return true;
    }
    if (!origins().has(req.headers.origin ?? '') || url.search) {
      reject(403, 'Forbidden');
      return true;
    }
    // This cap includes sockets awaiting their first authentication frame.
    if (connections.size >= 64) {
      reject(429, 'Too Many Requests');
      return true;
    }
    let uuid: string, podName: string;
    try {
      uuid = decodeURIComponent(match[1]);
      podName = decodeURIComponent(match[2]);
    } catch {
      reject(400, 'Bad Request');
      return true;
    }
    if (!/^[A-Za-z0-9-]{1,128}$/.test(uuid) || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(podName)) {
      reject(400, 'Bad Request');
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const close = attachExec(ws, uuid, podName, ports, options.openExec);
      connections.add(close);
      ws.once('close', () => connections.delete(close));
    });
    return true;
  }
  function drain() {
    draining = true;
    clearInterval(disableCheck);
    for (const close of connections) close();
    wss.close();
  }
  return { handle, drain };
}
