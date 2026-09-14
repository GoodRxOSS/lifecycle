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

import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { attachExec, type BridgePorts, type OpenExec } from './bridge';
import { ExecError } from './errors';
import type { Principal } from 'server/lib/principal';
import type { AuthFrame, ShellSession } from './protocol';
jest.mock('server/lib/kubernetes/getDeploymentPods', () => ({ loadKubeConfig: jest.fn() }));

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  frames: any[] = [];
  send = jest.fn((data: string) => this.frames.push(JSON.parse(data)));
  close = jest.fn(() => {
    this.readyState = WebSocket.CLOSED as any;
    this.emit('close');
  });
  terminate = jest.fn(() => this.close());
  ping = jest.fn(() => this.emit('pong'));
  message(frame: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(frame)), false);
  }
}
const frame: AuthFrame = {
  type: 'auth',
  accessToken: 'credential',
  container: 'app',
  podUid: 'uid',
  restartCount: 0,
  shell: '/bin/sh',
  cols: 90,
  rows: 30,
};
function session(): ShellSession {
  return {
    principal: { kind: 'user' } as Principal,
    sessionId: 'session',
    userId: 'user',
    shell: '/bin/sh',
    cols: 90,
    rows: 30,
    tokenExpiresAt: Date.now() + 3600000,
    target: {
      buildId: 1,
      uuid: 'demo',
      namespace: 'env-demo',
      podName: 'app',
      podUid: 'uid',
      container: 'app',
      containerId: 'id',
      restartCount: 0,
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('pod exec bridge', () => {
  let ws: Socket, upstream: Socket, ports: BridgePorts, open: jest.MockedFunction<OpenExec>;
  let close: ReturnType<typeof attachExec>;
  beforeEach(() => {
    jest.useFakeTimers();
    ws = new Socket();
    upstream = new Socket();
    ports = {
      authorize: jest.fn().mockImplementation(async () => session()),
      finish: jest.fn().mockResolvedValue(undefined),
      denied: jest.fn().mockResolvedValue(undefined),
      revalidate: jest.fn().mockResolvedValue(undefined),
      acquire: jest.fn(() => true),
      release: jest.fn(),
    };
    open = jest.fn().mockResolvedValue(upstream);
    close = attachExec(ws as any, 'demo', 'app', ports, open);
  });
  afterEach(() => {
    close();
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  test('rejects input before authentication without opening Kubernetes', () => {
    ws.message({ type: 'input', data: 'id\n' });
    expect(open).not.toHaveBeenCalled();
    expect(ports.authorize).not.toHaveBeenCalled();
    expect(ws.frames[0].code).toBe('auth_required');
  });
  test('denied authentication stays closed and never forwards credentials to errors', async () => {
    (ports.authorize as jest.Mock).mockRejectedValue(new ExecError('forbidden'));
    ws.message(frame);
    await flush();
    expect(open).not.toHaveBeenCalled();
    expect(ws.frames[0].code).toBe('forbidden');
    expect(JSON.stringify(ws.frames)).not.toContain('credential');
    expect(ports.denied).toHaveBeenCalledWith('forbidden');
  });
  test('authenticates once and preserves terminal bytes, input and resize', async () => {
    ws.message(frame);
    await flush();
    expect(ports.authorize).toHaveBeenCalledTimes(1);
    expect(ws.frames[0].type).toBe('ready');
    const [, output, stdin] = open.mock.calls[0];
    const input: Buffer[] = [];
    stdin.on('data', (b) => input.push(b));
    output.write(Buffer.from('\u001b[31mhéllo\r\n'));
    expect(Buffer.from(ws.frames[1].data, 'base64').toString()).toBe('\u001b[31mhéllo\r\n');
    ws.message({ type: 'input', data: 'echo 日本語\u0003' });
    expect(Buffer.concat(input).toString()).toBe('echo 日本語\u0003');
    const resized = jest.fn();
    output.on('resize', resized);
    ws.message({ type: 'resize', cols: 120, rows: 40 });
    expect(output.columns).toBe(120);
    expect(output.rows).toBe(40);
    expect(resized).toHaveBeenCalled();
    ws.message({ type: 'disconnect' });
    expect(upstream.terminate).toHaveBeenCalled();
    expect(ports.release).toHaveBeenCalledTimes(1);
    expect(ports.finish).toHaveBeenCalledTimes(1);
  });
  test('disconnect during authentication cancels exec and finishes late authorization', async () => {
    let resolve!: (s: ShellSession) => void;
    (ports.authorize as jest.Mock).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    ws.message(frame);
    ws.close();
    resolve(session());
    await flush();
    expect(open).not.toHaveBeenCalled();
    expect(ports.finish).toHaveBeenCalledTimes(1);
  });
  test('times out upstream opening and terminates a late arriving socket', async () => {
    let resolve!: (s: any) => void;
    open.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    ws.message(frame);
    await flush();
    jest.advanceTimersByTime(10000);
    expect(ws.frames[0].code).toBe('connect_timeout');
    expect(open.mock.calls[0][4].aborted).toBe(true);
    resolve(upstream);
    await flush();
    expect(upstream.terminate).toHaveBeenCalled();
    expect(ports.release).toHaveBeenCalledTimes(1);
  });
  test('expires the existing credential and closes the upstream', async () => {
    (ports.authorize as jest.Mock).mockResolvedValue({ ...session(), tokenExpiresAt: Date.now() + 100 });
    ws.message(frame);
    await flush();
    jest.advanceTimersByTime(100);
    expect(ws.frames.at(-1).code).toBe('access_token_expired');
    expect(upstream.terminate).toHaveBeenCalled();
  });
  test('detects a replaced container after connection', async () => {
    (ports.revalidate as jest.Mock).mockRejectedValue(new ExecError('target_changed'));
    ws.message(frame);
    await flush();
    jest.advanceTimersByTime(10000);
    await flush();
    expect(ws.frames.at(-1).code).toBe('target_changed');
    expect(upstream.terminate).toHaveBeenCalled();
  });
  test('rejects excess sessions before opening upstream', async () => {
    (ports.acquire as jest.Mock).mockReturnValue(false);
    ws.message(frame);
    await flush();
    expect(open).not.toHaveBeenCalled();
    expect(ws.frames[0].code).toBe('connection_limit');
  });
  test('bounds outgoing data for slow clients', async () => {
    ws.message(frame);
    await flush();
    ws.bufferedAmount = 2 * 1024 * 1024;
    open.mock.calls[0][1].write(Buffer.alloc(16384));
    expect(ws.frames.at(-1).code).toBe('slow_client');
    expect(upstream.terminate).toHaveBeenCalled();
  });
  test('bounds resize pressure just like input pressure', async () => {
    ws.message(frame);
    await flush();
    upstream.bufferedAmount = 65537;
    ws.message({ type: 'resize', cols: 90, rows: 30 });
    expect(ws.frames.at(-1).code).toBe('input_overflow');
    expect(upstream.terminate).toHaveBeenCalled();
  });
  test('reports process exit status', async () => {
    ws.message(frame);
    await flush();
    open.mock.calls[0][3]({ status: 'Failure', details: { causes: [{ reason: 'ExitCode', message: '7' }] } });
    expect(ws.frames.at(-1)).toEqual({ type: 'exit', code: 7 });
    expect(upstream.terminate).toHaveBeenCalled();
  });
  test('reports no-shell execution failures without upstream details', async () => {
    ws.message(frame);
    await flush();
    open.mock.calls[0][3]({ status: 'Failure', message: 'sensitive runtime error' });
    expect(ws.frames.at(-1).code).toBe('shell_start_failed');
    expect(JSON.stringify(ws.frames)).not.toContain('sensitive');
  });
  test('bounds pending auth and refuses repeated authentication frames', async () => {
    jest.advanceTimersByTime(5000);
    expect(ws.frames[0].code).toBe('auth_timeout');
    expect(open).not.toHaveBeenCalled();
  });
  test('rejects invalid dimensions and oversized input', async () => {
    ws.message(frame);
    await flush();
    ws.message({ type: 'resize', cols: 999, rows: 24 });
    expect(ws.frames.at(-1).code).toBe('invalid_frame');
  });
});
