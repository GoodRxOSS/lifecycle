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

import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { createExecUpgrade } from './upgrade';
import type { BridgePorts } from './bridge';
jest.mock('./authenticate', () => ({ createShellPorts: jest.fn() }));
jest.mock('server/lib/kubernetes/getDeploymentPods', () => ({ loadKubeConfig: jest.fn() }));

const auth = {
  type: 'auth',
  accessToken: 'existing-jwt',
  container: 'app',
  podUid: 'uid',
  restartCount: 0,
  shell: '/bin/sh',
  cols: 80,
  rows: 24,
};
describe('real HTTP/WebSocket shell upgrade', () => {
  let server: Server, upgrade: ReturnType<typeof createExecUpgrade>, base: string, enabled: boolean;
  let ports: Omit<BridgePorts, 'acquire' | 'release'>;
  const clients: WebSocket[] = [];
  const upstreams: any[] = [];
  let open: jest.Mock;
  beforeEach(async () => {
    enabled = true;
    ports = {
      authorize: jest.fn().mockImplementation(async () => ({
        sessionId: 'session',
        userId: 'user',
        shell: '/bin/sh',
        cols: 80,
        rows: 24,
        tokenExpiresAt: Date.now() + 60000,
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
      })),
      finish: jest.fn().mockResolvedValue(undefined),
      denied: jest.fn().mockResolvedValue(undefined),
      revalidate: jest.fn().mockResolvedValue(undefined),
    };
    open = jest.fn().mockImplementation(async () => {
      const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, terminate: jest.fn() });
      upstreams.push(socket);
      return socket;
    });
    upgrade = createExecUpgrade({
      enabled: () => enabled,
      origins: () => new Set(['https://ui.test']),
      ports,
      openExec: open,
    });
    server = createServer();
    server.on('upgrade', (req, socket, head) => {
      if (!upgrade.handle(req, socket as any, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2/builds/demo/pods/app/exec`;
  });
  afterEach(async () => {
    clients.forEach((c) => c.terminate());
    clients.length = 0;
    upstreams.length = 0;
    upgrade.drain();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function connect(url = base, origin = 'https://ui.test') {
    const ws = new WebSocket(url, { origin });
    clients.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return ws;
  }
  const next = (ws: WebSocket) =>
    new Promise<any>((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw.toString()))));
  test.each([
    ['https://attacker.test', ''],
    ['https://ui.test', '?token=secret'],
    ['https://ui.test', '?namespace=kube-system'],
  ])('denies origin/query %s %s before authorization', async (origin, query) => {
    await expect(connect(base + query, origin)).rejects.toThrow('403');
    expect(ports.authorize).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  test('rejects a malformed encoded target without crashing the server', async () => {
    await expect(connect(base.replace('/app/exec', '/%FF/exec'))).rejects.toThrow('400');
    const ws = await connect();
    const response = next(ws);
    ws.send(JSON.stringify({ type: 'input', data: 'id\n' }));
    expect((await response).code).toBe('auth_required');
    expect(open).not.toHaveBeenCalled();
  });
  test('accepts the first auth frame and isolates the legacy log dispatcher', async () => {
    const ws = await connect();
    expect(open).not.toHaveBeenCalled();
    const response = next(ws);
    ws.send(JSON.stringify(auth));
    expect((await response).type).toBe('ready');
    expect(open).toHaveBeenCalledTimes(1);
  });
  test('bounds per-user active sessions and releases slots on disconnect', async () => {
    for (let i = 0; i < 4; i++) {
      const ws = await connect();
      const response = next(ws);
      ws.send(JSON.stringify(auth));
      expect((await response).type).toBe('ready');
    }
    const fifth = await connect();
    const denied = next(fifth);
    fifth.send(JSON.stringify(auth));
    expect((await denied).code).toBe('connection_limit');
    expect(open).toHaveBeenCalledTimes(4);
    const closed = new Promise((resolve) => clients[0].once('close', resolve));
    clients[0].close();
    await closed;
    const sixth = await connect();
    const response = next(sixth);
    sixth.send(JSON.stringify(auth));
    expect((await response).type).toBe('ready');
  });
  test('drains active shells and refuses new upgrades', async () => {
    const ws = await connect();
    const ready = next(ws);
    ws.send(JSON.stringify(auth));
    await ready;
    const response = next(ws);
    upgrade.drain();
    expect((await response).code).toBe('server_draining');
    expect(upstreams[0].terminate).toHaveBeenCalled();
    await expect(connect()).rejects.toThrow('503');
  });
  test('refuses upgrades while the feature is disabled', async () => {
    enabled = false;
    await expect(connect()).rejects.toThrow('503');
    expect(open).not.toHaveBeenCalled();
  });
});
