/**
 * Copyright 2025 GoodRx, Inc.
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

import 'module-alias/register';
import { join } from 'path';
import moduleAlias from 'module-alias';

// Register path aliases
moduleAlias.addAliases({
  shared: join(__dirname, 'src/shared'),
  server: join(__dirname, 'src/server'),
  root: join(__dirname, '.'),
  src: join(__dirname, 'src'),
  scripts: join(__dirname, 'scripts'),
});

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import { rootLogger } from './src/server/lib/logger';
import { streamK8sLogs, AbortHandle } from './src/server/lib/k8sStreamer';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);

// --- Initialize Next.js App ---
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const LOG_STREAM_PATH = '/api/logs/stream'; // Path for WebSocket connections
const logger = rootLogger.child({ filename: __filename });

app.prepare().then(() => {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      logger.error({ err }, 'Error handling HTTP request');
      res.statusCode = 500;
      res.end('internal server error');
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const { pathname } = parse(request.url!, true);
    const connectionLogCtx = { path: pathname, remoteAddress: request.socket.remoteAddress };

    if (pathname === LOG_STREAM_PATH) {
      logger.debug(connectionLogCtx, 'Handling upgrade request for log stream');
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    let k8sStreamAbort: AbortHandle | null = null;
    let logCtx: Record<string, any> = {
      remoteAddress: request.socket.remoteAddress,
    };

    try {
      const { query } = parse(request.url || '', true);
      const {
        podName,
        namespace,
        containerName,
        follow: followStr,
        tailLines: tailLinesStr,
        timestamps: timestampsStr,
      } = query;

      logCtx = { ...logCtx, podName, namespace, containerName };
      logger.debug(logCtx, 'WebSocket connection established');

      if (
        !podName ||
        !namespace ||
        !containerName ||
        typeof podName !== 'string' ||
        typeof namespace !== 'string' ||
        typeof containerName !== 'string'
      ) {
        throw new Error('Missing or invalid required parameters: podName, namespace, containerName');
      }
      const follow = followStr === 'true';
      const tailLines = tailLinesStr ? parseInt(tailLinesStr as string, 10) : undefined;
      const timestamps = timestampsStr === 'true';
      if (tailLines !== undefined && isNaN(tailLines)) throw new Error('Invalid tailLines parameter.');

      logger.debug(logCtx, 'Initiating K8s log stream');
      k8sStreamAbort = streamK8sLogs(
        { podName, namespace, containerName, follow, tailLines, timestamps },
        {
          onData: (logLine: string) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'log', payload: logLine }));
            }
          },
          onError: (error: Error) => {
            logger.error({ ...logCtx, err: error }, 'K8s stream error');
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', message: `Kubernetes stream error: ${error.message}` }));
            }
            ws.close(1011, 'Kubernetes stream error');
          },
          onEnd: () => {
            logger.debug(logCtx, 'K8s stream ended');
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'end', reason: 'ContainerTerminated' }));
            }
            ws.close(1000, 'Stream ended');
          },
        }
      );
    } catch (error: any) {
      logger.error({ ...logCtx, err: error }, 'WebSocket connection setup error');
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.send(JSON.stringify({ type: 'error', message: `Connection error: ${error.message}` }));
        ws.close(1008, `Connection error: ${error.message}`);
      }
      return;
    }

    ws.on('close', (code, reason) => {
      const reasonString = reason instanceof Buffer ? reason.toString() : String(reason);
      logger.debug({ ...logCtx, code, reason: reasonString }, 'WebSocket connection closed by client');
      if (k8sStreamAbort && typeof k8sStreamAbort.abort === 'function') {
        logger.debug(logCtx, 'Aborting log stream due to client close');
        k8sStreamAbort.abort();
        k8sStreamAbort = null;
      }
    });

    ws.on('error', (error) => {
      logger.warn({ ...logCtx, err: error }, 'WebSocket error');
      if (k8sStreamAbort && typeof k8sStreamAbort.abort === 'function') {
        logger.debug(logCtx, 'Aborting log stream due to WebSocket error');
        k8sStreamAbort.abort();
        k8sStreamAbort = null;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1011, 'WebSocket error');
      }
    });
  });

  httpServer.listen(port);

  httpServer.on('error', (error) => {
    logger.error({ err: error }, 'HTTP Server Error');
    process.exit(1);
  });
});

/**
 * @openapi
 * /api/logs/stream:
 *   get:
 *     summary: Stream Kubernetes pod logs via WebSocket
 *     description: |
 *       Establishes a WebSocket connection to stream real-time logs from a
 *       specified Kubernetes pod container. The client must provide query
 *       parameters identifying the pod, namespace, and container.
 *
 *       The endpoint returns log messages as JSON objects with a type field
 *       indicating the message type (log, error, or end), and additional
 *       fields depending on the message type.
 *
 *       Note: This endpoint requires WebSocket protocol support.
 *     tags:
 *       - Logs
 *     parameters:
 *       - in: query
 *         name: podName
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the Kubernetes pod
 *       - in: query
 *         name: namespace
 *         required: true
 *         schema:
 *           type: string
 *         description: The Kubernetes namespace where the pod is located
 *       - in: query
 *         name: containerName
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the container within the pod
 *       - in: query
 *         name: follow
 *         required: false
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Whether to follow the log stream as new logs are generated
 *       - in: query
 *         name: tailLines
 *         required: false
 *         schema:
 *           type: integer
 *           default: 200
 *         description: Number of lines to retrieve from the end of the logs
 *       - in: query
 *         name: timestamps
 *         required: false
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Whether to include timestamps with each log line
 *     responses:
 *       101:
 *         description: WebSocket connection established
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: object
 *                   required:
 *                     - type
 *                     - payload
 *                   properties:
 *                     type:
 *                       type: string
 *                       enum: [log]
 *                       description: Indicates this is a log message
 *                     payload:
 *                       type: string
 *                       description: The content of the log line
 *                 - type: object
 *                   required:
 *                     - type
 *                     - message
 *                   properties:
 *                     type:
 *                       type: string
 *                       enum: [error]
 *                       description: Indicates this is an error message
 *                     message:
 *                       type: string
 *                       description: Error message describing what went wrong
 *                 - type: object
 *                   required:
 *                     - type
 *                   properties:
 *                     type:
 *                       type: string
 *                       enum: [end]
 *                       description: Indicates the log stream has ended
 *                     reason:
 *                       type: string
 *                       description: Reason why the stream ended (e.g., 'ContainerTerminated')
 *             examples:
 *               logMessage:
 *                 value:
 *                   type: "log"
 *                   payload: "2024-04-14T12:34:56.789Z INFO Starting application..."
 *               errorMessage:
 *                 value:
 *                   type: "error"
 *                   message: "Kubernetes stream error: Connection refused"
 *               endMessage:
 *                 value:
 *                   type: "end"
 *                   reason: "ContainerTerminated"
 *       400:
 *         description: Bad request - missing or invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Missing or invalid required parameters: podName, namespace, containerName"
 */

// Usage example:
// Connect to WebSocket using wscat (substitute your host with the appropriate environment):
// wscat -c "wss://<your-host>/api/logs/stream?podName=<pod-name>&namespace=<namespace>&follow=true&tailLines=200&timestamps=true&containerName=<container-name>"
//
// Example messages received from the WebSocket:
// {"type":"log","payload":"2024-04-14T12:34:56.789Z INFO Starting application..."}
// {"type":"error","message":"Kubernetes stream error: Connection refused"}
// {"type":"end","reason":"ContainerTerminated"}
