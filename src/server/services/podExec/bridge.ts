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

import * as k8s from '@kubernetes/client-node';
import { WebSocketHandler } from '@kubernetes/client-node/dist/web-socket-handler';
import { PassThrough, Writable } from 'node:stream';
import { WebSocket, type RawData } from 'ws';
import { loadKubeConfig } from 'server/lib/kubernetes/getDeploymentPods';
import { ExecError, safeError, kubernetesReadError, type ExecErrorCode } from './errors';
import { parseFrame, type AuthFrame, type ShellSession, type ServerFrame } from './protocol';

export interface BridgePorts {
  authorize(frame: AuthFrame, uuid: string, podName: string): Promise<ShellSession>;
  finish(session: ShellSession, reason: string): Promise<void>;
  denied(reason: string): Promise<void>;
  revalidate(session: ShellSession): Promise<void>;
  acquire(userId: string): boolean;
  release(userId: string): void;
}
export type TerminalOutput = Writable & { columns: number; rows: number };
export type OpenExec = (
  session: ShellSession,
  output: TerminalOutput,
  stdin: PassThrough,
  onStatus: (status: k8s.V1Status) => void,
  signal: AbortSignal
) => Promise<WebSocket>;
export const openKubernetesExec: OpenExec = (session, output, stdin, onStatus, signal) => {
  const t = session.target;
  const config = loadKubeConfig();
  let upgradeError: ExecError | undefined;
  const handler = new WebSocketHandler(config, (uri, protocols, options) => {
    if (signal.aborted) throw new ExecError('connect_timeout');
    const socket = new WebSocket(uri, protocols, { ...options, handshakeTimeout: 10000 });
    socket.on('unexpected-response', (_request, response) => {
      upgradeError = kubernetesReadError({ statusCode: response.statusCode });
      socket.emit('error', upgradeError);
      socket.terminate();
      response.destroy();
    });
    const abort = () => socket.terminate();
    signal.addEventListener('abort', abort, { once: true });
    socket.once('close', () => signal.removeEventListener('abort', abort));
    return socket;
  });
  return new k8s.Exec(config, handler)
    .exec(t.namespace, t.podName, t.container, [session.shell], output, null, stdin, true, onStatus)
    .catch((error) => {
      throw upgradeError ?? error;
    });
};

export function attachExec(
  ws: WebSocket,
  uuid: string,
  podName: string,
  ports: BridgePorts,
  openExec: OpenExec = openKubernetesExec
) {
  let state: 'auth' | 'opening' | 'ready' | 'closed' = 'auth';
  const isClosed = () => state === 'closed';
  let session: ShellSession | undefined;
  let upstream: WebSocket | undefined;
  let acquired = false;
  let finished = false;
  let lastInput = Date.now();
  let alive = true;
  let checking = false;
  let openingTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const abortController = new AbortController();
  const stdin = new PassThrough({ highWaterMark: 16384 });
  function send(frame: ServerFrame) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }
  function finish(reason: string) {
    if (!session || finished) return;
    finished = true;
    void ports.finish(session, reason).catch(() => undefined);
  }
  function close(reason: string, code = 1000) {
    if (isClosed()) return;
    state = 'closed';
    clearTimeout(authTimer);
    clearTimeout(openingTimer);
    clearTimeout(expiryTimer);
    clearInterval(heartbeat);
    clearInterval(targetCheck);
    stdin.destroy();
    output.destroy();
    abortController.abort();
    upstream?.terminate();
    if (acquired && session) {
      ports.release(session.userId);
      acquired = false;
    }
    finish(reason);
    ws.close(code, reason);
    setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }, 1000).unref();
  }
  function fail(code: ExecErrorCode) {
    if (isClosed()) return;
    if (!session) void ports.denied(code).catch(() => undefined);
    send({ type: 'error', code, message: new ExecError(code).message });
    close(code, 1008);
  }
  const output: TerminalOutput = Object.assign(
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        if (isClosed()) {
          done();
          return;
        }
        for (let offset = 0; offset < chunk.length; offset += 8192) {
          if (ws.bufferedAmount > 1024 * 1024) {
            fail('slow_client');
            break;
          }
          send({ type: 'output', data: chunk.subarray(offset, offset + 8192).toString('base64') });
        }
        done();
      },
    }),
    { columns: 80, rows: 24 }
  );
  output.on('error', () => fail('kubernetes_error'));
  stdin.on('error', () => fail('kubernetes_error'));
  const authTimer = setTimeout(() => fail('auth_timeout'), 5000);
  const heartbeat = setInterval(() => {
    if (!alive) {
      fail('connection_lost');
      return;
    }
    if (state === 'ready' && Date.now() - lastInput > 10 * 60_000) {
      fail('idle_timeout');
      return;
    }
    alive = false;
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 15000);
  heartbeat.unref();
  const targetCheck = setInterval(() => {
    if (state !== 'ready' || !session || checking) return;
    checking = true;
    void ports
      .revalidate(session)
      .catch((error) => fail(safeError(error, 'target_changed').code))
      .finally(() => {
        checking = false;
      });
  }, 10000);
  targetCheck.unref();
  ws.on('pong', () => {
    alive = true;
  });
  ws.on('close', () => close('client_disconnected'));
  ws.on('error', () => close('client_error', 1011));
  ws.on('message', (raw: RawData, binary: boolean) => {
    if (isClosed()) return;
    try {
      if (binary) throw new ExecError('invalid_frame');
      const frame = parseFrame(raw.toString());
      if (frame.type === 'disconnect') {
        close('user_disconnected');
        return;
      }
      if (state === 'auth') {
        if (frame.type !== 'auth') throw new ExecError('auth_required');
        state = 'opening';
        void (async () => {
          try {
            session = await ports.authorize(frame, uuid, podName);
          } finally {
            frame.accessToken = '';
          }
          if (isClosed()) {
            finish('cancelled_before_connect');
            return;
          }
          if (!ports.acquire(session.userId)) throw new ExecError('connection_limit');
          acquired = true;
          clearTimeout(authTimer);
          openingTimer = setTimeout(() => fail('connect_timeout'), 10000);
          const expire = () => {
            const remaining = session!.tokenExpiresAt - Date.now();
            if (remaining <= 0) {
              fail('access_token_expired');
              return;
            }
            expiryTimer = setTimeout(expire, Math.min(remaining, 2147483647));
          };
          expire();
          if (isClosed()) return;
          output.columns = session.cols;
          output.rows = session.rows;
          const conn = await openExec(
            session,
            output,
            stdin,
            (status) => {
              if (isClosed()) return;
              const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode')?.message;
              const parsed = cause == null ? NaN : Number(cause);
              const code = status.status === 'Success' ? 0 : Number.isInteger(parsed) ? parsed : null;
              if (code == null) {
                fail('shell_start_failed');
                return;
              }
              send({ type: 'exit', code });
              close('process_exited');
            },
            abortController.signal
          );
          upstream = conn;
          conn.on('error', () => fail('kubernetes_error'));
          conn.on('close', () => {
            if (state !== 'closed') {
              send({ type: 'exit', code: null });
              close('upstream_closed');
            }
          });
          if (isClosed()) {
            conn.terminate();
            return;
          }
          if (conn.readyState !== WebSocket.OPEN) {
            fail('kubernetes_error');
            return;
          }
          clearTimeout(openingTimer);
          state = 'ready';
          lastInput = Date.now();
          send({ type: 'ready', sessionId: session.sessionId });
        })().catch((error) => fail(safeError(error).code));
        return;
      }
      if (state !== 'ready') throw new ExecError('invalid_frame');
      if (frame.type === 'input') {
        if (!upstream || upstream.bufferedAmount > 65536 || stdin.writableLength > 65536) {
          throw new ExecError('input_overflow');
        }
        lastInput = Date.now();
        stdin.write(frame.data, 'utf8');
      } else if (frame.type === 'resize') {
        if (!upstream || upstream.bufferedAmount > 65536) throw new ExecError('input_overflow');
        output.columns = frame.cols;
        output.rows = frame.rows;
        output.emit('resize');
      } else throw new ExecError('invalid_frame');
    } catch (error) {
      fail(safeError(error, 'invalid_frame').code);
    }
  });
  return (reason: ExecErrorCode = 'server_draining') => fail(reason);
}
