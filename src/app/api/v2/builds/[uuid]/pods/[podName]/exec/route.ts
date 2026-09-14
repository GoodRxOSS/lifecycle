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

import { NextResponse } from 'next/server';
import { createApiHandler } from 'server/lib/createApiHandler';

/**
 * @openapi
 * /api/v2/builds/{uuid}/pods/{podName}/exec:
 *   get:
 *     summary: Open an interactive pod shell over WebSocket
 *     tags: [Builds]
 *     description: |
 *       Requires POD_EXEC_ENABLED=true, ENABLE_AUTH=true and an Origin in
 *       POD_EXEC_ALLOWED_ORIGINS. The custom WebSocket server verifies authentication
 *       independently of HTTP middleware. The first text message must be
 *       {type: "auth", accessToken, container, podUid, restartCount, shell, cols, rows}.
 *       accessToken is the existing session JWT with user or admin role. No credentials
 *       are accepted in the URL. shell is /bin/sh or /bin/bash; dimensions are 2..500.
 *       Client frames after ready: {type: "input", data}, {type: "resize", cols, rows},
 *       {type: "disconnect"}. Server frames: {type: "ready", sessionId},
 *       {type: "output", data} (base64 bytes), {type: "exit", code} (nullable integer),
 *       {type: "error", code, message}. Input is UTF-8, at most 8192 bytes per frame.
 *       Sessions close at JWT expiry, after 10 minutes without input, or on disconnect,
 *       target loss or server shutdown. Each replica permits 64 connections and four
 *       active shells per user. Only running regular/init containers in a dedicated
 *       Environment namespace are supported; build tooling and sandboxes are excluded.
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema: {type: string}
 *       - in: path
 *         name: podName
 *         required: true
 *         schema: {type: string}
 *     responses:
 *       '101':
 *         description: WebSocket connected; first-message authentication is still required.
 *       '403':
 *         description: Origin denied or query parameters supplied.
 *       '426':
 *         description: WebSocket upgrade required.
 *       '429':
 *         description: Connection limit reached.
 *       '503':
 *         description: Shells disabled or server draining.
 */
const getHandler = async () => {
  return NextResponse.json({ error: 'WebSocket upgrade required' }, { status: 426, headers: { Upgrade: 'websocket' } });
};

export const GET = createApiHandler(getHandler, { auth: 'session' });
