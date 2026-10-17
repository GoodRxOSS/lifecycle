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

import { createServer } from 'http';
import type { AddressInfo, Socket } from 'net';
import { PassThrough, Writable } from 'stream';
import * as k8s from '@kubernetes/client-node';
import { loadKubeConfig } from 'server/lib/kubernetes/getDeploymentPods';
import { openKubernetesExec } from './bridge';
import type { ShellSession } from './protocol';
jest.mock('server/lib/kubernetes/getDeploymentPods', () => ({ loadKubeConfig: jest.fn() }));

test('cancels an actual client-node handshake that never receives an upgrade response', async () => {
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const accepted = new Promise<void>((resolve) => server.once('upgrade', () => resolve()));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = new k8s.KubeConfig();
  config.loadFromOptions({
    clusters: [{ name: 'local', server: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }],
    users: [],
    contexts: [{ name: 'local', cluster: 'local', user: '' }],
    currentContext: 'local',
  });
  (loadKubeConfig as jest.Mock).mockReturnValue(config);
  const signal = new AbortController();
  const output = Object.assign(
    new Writable({
      write(_c, _e, done) {
        done();
      },
    }),
    { columns: 80, rows: 24 }
  );
  const session = {
    target: { namespace: 'env-test', podName: 'pod', container: 'app' },
    shell: '/bin/sh',
  } as ShellSession;
  try {
    const pending = openKubernetesExec(session, output, new PassThrough(), () => undefined, signal.signal);
    await accepted;
    const rejection = expect(pending).rejects.toBeDefined();
    signal.abort();
    await rejection;
  } finally {
    signal.abort();
    sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 5000);

test.each([
  [403, 'kubernetes_forbidden'],
  [404, 'pod_unavailable'],
  [503, 'kubernetes_error'],
])('classifies actual exec upgrade HTTP %s', async (statusCode, code) => {
  const server = createServer();
  server.on('upgrade', (_req, socket) =>
    socket.end(`HTTP/1.1 ${statusCode} Denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = new k8s.KubeConfig();
  config.loadFromOptions({
    clusters: [{ name: 'local', server: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }],
    users: [],
    contexts: [{ name: 'local', cluster: 'local', user: '' }],
    currentContext: 'local',
  });
  (loadKubeConfig as jest.Mock).mockReturnValue(config);
  const output = Object.assign(
    new Writable({
      write(_c, _e, done) {
        done();
      },
    }),
    { columns: 80, rows: 24 }
  );
  const session = {
    target: { namespace: 'env-test', podName: 'pod', container: 'app' },
    shell: '/bin/sh',
  } as ShellSession;
  try {
    await expect(
      openKubernetesExec(session, output, new PassThrough(), () => undefined, new AbortController().signal)
    ).rejects.toMatchObject({ code });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
