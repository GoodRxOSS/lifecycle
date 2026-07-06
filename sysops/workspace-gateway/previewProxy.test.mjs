import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createConnection } from 'node:net';

const TOKEN = 'preview-proxy-test-token';

process.env.MCP_HOST = '127.0.0.1';
process.env.LIFECYCLE_GATEWAY_TOKEN = TOKEN;
process.env.LIFECYCLE_GATEWAY_PREVIEW_PROXY_TIMEOUT_MS = '2000';

const gateway = await import(new URL(`./index.mjs?preview-proxy-test=${Date.now()}`, import.meta.url));

let gatewayServer;
let gatewayBaseUrl;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function closeServer(server) {
  if (!server?.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startTargetServer(handler) {
  const server = await listen(createServer(handler));
  return {
    server,
    port: server.address().port,
  };
}

async function withTargetServer(handler, run) {
  const target = await startTargetServer(handler);
  try {
    return await run(target.port);
  } finally {
    await closeServer(target.server);
  }
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readSocketUntil(socket, predicate) {
  let text = '';
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for socket data. Received: ${text}`));
    }, 2000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onData = (chunk) => {
      text += chunk.toString('utf8');
      if (predicate(text)) {
        cleanup();
        resolve(text);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Socket closed before expected data. Received: ${text}`));
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

async function connectSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, '127.0.0.1', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

test.before(async () => {
  gatewayServer = gateway.app.listen(0, '127.0.0.1');
  await once(gatewayServer, 'listening');
  gateway.installPreviewProxyUpgradeHandler(gatewayServer, TOKEN);
  gatewayBaseUrl = `http://127.0.0.1:${gatewayServer.address().port}`;
});

test.after(async () => {
  await closeServer(gatewayServer);
});

test('preview proxy requires gateway auth', async () => {
  const response = await fetch(`${gatewayBaseUrl}/preview/3000/`);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Unauthorized' });
});

test('preview proxy rejects invalid ports after gateway auth', async () => {
  for (const path of ['/preview/0/', '/preview/65536/', '/preview/not-a-port/']) {
    const response = await fetch(`${gatewayBaseUrl}${path}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: 'Port must be an integer between 1 and 65535.' });
  }
});

test('preview proxy forwards HTTP requests to the requested local port', async () => {
  const body = '{"z":1, "a":2}';

  await withTargetServer(
    async (req, res) => {
      const requestBody = await readRequestBody(req);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          body: requestBody,
          contentType: req.headers['content-type'],
          customHeader: req.headers['x-custom-header'],
        })
      );
    },
    async (port) => {
      const response = await fetch(`${gatewayBaseUrl}/preview/${port}/api/thing?q=one&multi=a&multi=b`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'x-custom-header': 'kept',
        },
        body,
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        method: 'POST',
        url: '/api/thing?q=one&multi=a&multi=b',
        body,
        contentType: 'application/json',
        customHeader: 'kept',
      });
    }
  );
});

test('preview proxy preserves encoded path and query string', async () => {
  await withTargetServer(
    (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: req.url }));
    },
    async (port) => {
      const response = await fetch(`${gatewayBaseUrl}/preview/${port}/assets/a%2Fb/c%20d?space=a+b&encoded=%2Fok`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        url: '/assets/a%2Fb/c%20d?space=a+b&encoded=%2Fok',
      });
    }
  );
});

test('preview proxy strips gateway auth, cookie, grant, and forwarded request headers', async () => {
  await withTargetServer(
    (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.headers));
    },
    async (port) => {
      const response = await fetch(`${gatewayBaseUrl}/preview/${port}/headers`, {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          cookie: 'lfc_chat_preview_auth=grant; app_cookie=should-not-forward',
          forwarded: 'for=203.0.113.7;host=evil.example',
          origin: 'https://evil.example',
          'set-cookie': 'bad=1',
          'x-extra-ok': 'kept',
          'x-forwarded-for': '203.0.113.7',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'https',
          'x-lifecycle-bootstrap-token': 'bootstrap-secret',
          'x-lifecycle-chat-preview-grant': 'chat-grant',
          'x-lifecycle-gateway-token': TOKEN,
          'x-lifecycle-preview-grant': 'preview-grant',
          'x-real-ip': '203.0.113.9',
        },
      });

      assert.equal(response.status, 200);
      const headers = await response.json();

      assert.equal(headers.authorization, undefined);
      assert.equal(headers.cookie, undefined);
      assert.equal(headers.forwarded, undefined);
      assert.equal(headers.origin, undefined);
      assert.equal(headers['set-cookie'], undefined);
      assert.equal(headers['x-lifecycle-bootstrap-token'], undefined);
      assert.equal(headers['x-lifecycle-chat-preview-grant'], undefined);
      assert.equal(headers['x-lifecycle-gateway-token'], undefined);
      assert.equal(headers['x-lifecycle-preview-grant'], undefined);
      assert.equal(headers['x-real-ip'], undefined);
      assert.equal(headers['x-extra-ok'], 'kept');
      assert.equal(headers.host, `127.0.0.1:${port}`);
      assert.equal(headers['x-forwarded-host'], `127.0.0.1:${gatewayServer.address().port}`);
      assert.equal(headers['x-forwarded-prefix'], `/preview/${port}`);
      assert.equal(headers['x-forwarded-proto'], 'http');
      assert.ok(headers['x-forwarded-for']);
      assert.equal(headers['x-forwarded-for'].includes('203.0.113.7'), false);
    }
  );
});

test('preview proxy supports authenticated WebSocket upgrades', async () => {
  let targetRequest = null;
  let targetSocket = null;
  const targetServer = createServer();
  targetServer.on('upgrade', (req, socket) => {
    targetSocket = socket;
    targetRequest = {
      url: req.url,
      headers: req.headers,
    };
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Accept: test-accept',
        '',
        'upgraded',
      ].join('\r\n')
    );
  });
  await listen(targetServer);
  const port = targetServer.address().port;
  const client = await connectSocket(gatewayServer.address().port);

  try {
    client.write(
      [
        `GET /preview/${port}/ws?room=1 HTTP/1.1`,
        `Host: 127.0.0.1:${gatewayServer.address().port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        `Authorization: Bearer ${TOKEN}`,
        `x-lifecycle-gateway-token: ${TOKEN}`,
        '',
        '',
      ].join('\r\n')
    );

    const response = await readSocketUntil(client, (text) => text.includes('upgraded'));

    assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
    assert.equal(targetRequest.url, '/ws?room=1');
    assert.equal(targetRequest.headers.authorization, undefined);
    assert.equal(targetRequest.headers['x-lifecycle-gateway-token'], undefined);
    assert.equal(targetRequest.headers.upgrade, 'websocket');
    assert.equal(targetRequest.headers.host, `127.0.0.1:${port}`);
    assert.equal(targetRequest.headers['x-forwarded-prefix'], `/preview/${port}`);
  } finally {
    client.destroy();
    targetSocket?.destroy();
    await closeServer(targetServer);
  }
});
