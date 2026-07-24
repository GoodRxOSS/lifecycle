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

import type { NextApiRequest, NextApiResponse } from 'next';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import GithubService from 'server/services/github';
import { Build } from 'server/models';

// Constants
const MAX_CONCURRENT_PODS = 5;
const LOG_TIMEOUT_MS = 3600000; // 1 hour
const MAX_INITIAL_LINES = 100;

const execAsync = promisify(exec);

// Types
interface LogStreamOptions {
  podName: string;
  namespace: string;
  sendSSE: (msg: string) => void; // eslint-disable-line no-unused-vars
}

type ContainerType = 'app' | 'init';

// Input validation helpers
const isValidContainerType = (type: string | undefined): type is ContainerType => {
  return type === undefined || type === 'app' || type === 'init';
};

/**
 * @openapi
 * /api/v1/builds/{uuid}/services/{name}/logs:
 *   get:
 *     summary: Stream logs from a service's containers
 *     description: |
 *       Streams logs from either application containers or init containers of a service
 *       using Server-Sent Events (SSE). The stream will continue until the client disconnects
 *       or the timeout is reached.
 *     deprecated: true
 *     tags:
 *       - Logs
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the service
 *       - in: query
 *         name: containerType
 *         required: false
 *         schema:
 *           type: string
 *           enum: [app, init]
 *         description: Type of containers to stream logs from. Defaults to 'app'
 *     responses:
 *       200:
 *         description: Success. Returns a stream of Server-Sent Events
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *             example: |
 *               data: [pod/name] Log message content
 *       400:
 *         description: Bad request - invalid parameters
 *       405:
 *         description: Method not allowed
 */

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getPodNames(namespace: string, deployment: string): Promise<string[]> {
  const getPodsCmd = `kubectl get pods --namespace ${namespace} -l app.kubernetes.io/instance=${deployment} -o jsonpath="{range .items[*]}{.metadata.name}{'\\n'}{end}"`;
  const { stdout, stderr } = await execAsync(getPodsCmd);

  if (stderr) {
    throw new Error(`Failed to retrieve pods: ${stderr}`);
  }

  return stdout
    .trim()
    .split('\n')
    .filter((name) => name.trim() !== '');
}

function createPodLogStream({
  podName,
  namespace,
  sendSSE,
  containerType = 'app',
}: LogStreamOptions & { containerType?: ContainerType }) {
  const kubectlArgs = ['logs', podName, '--namespace', namespace, '-f', `--tail=${MAX_INITIAL_LINES}`];

  if (containerType === 'init') {
    kubectlArgs.push('--container=init-container');
  } else {
    kubectlArgs.push('--all-containers=true');
    kubectlArgs.push('--prefix=true');
  }

  const proc = spawn('kubectl', kubectlArgs);

  let buffer = '';
  const flush = () => {
    if (buffer) {
      sendSSE(buffer);
      buffer = '';
    }
  };

  proc.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    // Keep the last, possibly incomplete, line in the buffer
    buffer = lines.pop() || '';
    lines.forEach((line) => {
      if (line.trim()) {
        sendSSE(line);
      }
    });
  });

  proc.stderr.on('data', (data: Buffer) => {
    sendSSE(`Error: ${data.toString()}`);
  });

  proc.on('error', (error: Error) => {
    sendSSE(`Process error: ${error.message}`);
  });

  proc.on('close', (code: number) => {
    flush();
    sendSSE(`Log streaming ended with code ${code}`);
  });

  return proc;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const { uuid, name } = req.query;
  if (!uuid || !name || typeof uuid !== 'string' || typeof name !== 'string') {
    res.status(400).json({ error: 'Invalid path parameters' });
    return;
  }

  const deployment = `${name}-${uuid}`;
  const containerType = req.query.containerType as string | undefined;
  if (!isValidContainerType(containerType)) {
    res.status(400).json({ error: 'Invalid container type. Must be "app" or "init"' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  const sendSSE = (data: string) => {
    res.write(`data: ${data}\n\n`);
  };

  try {
    const githubService = new GithubService();
    const build: Build = await githubService.db.models.Build.query().findOne({
      uuid,
    });
    const deployNamespace = build.namespace;
    if (!deployNamespace) {
      throw new Error('Deployment namespace not configured');
    }

    const podNames = await getPodNames(deployNamespace, deployment);

    if (podNames.length === 0) {
      sendSSE(`No pods found for deployment "${deployment}" in namespace "${deployNamespace}"`);
      res.end();
      return;
    }

    if (podNames.length > MAX_CONCURRENT_PODS) {
      podNames.length = MAX_CONCURRENT_PODS;
    }

    const logProcesses = podNames.map((podName) => {
      return createPodLogStream({
        podName,
        namespace: deployNamespace,
        sendSSE,
        containerType: (containerType as ContainerType) || 'app',
      });
    });

    const timeout = setTimeout(() => {
      logProcesses.forEach((proc) => proc.kill());
      res.end();
    }, LOG_TIMEOUT_MS);

    req.on('close', () => {
      clearTimeout(timeout);
      logProcesses.forEach((proc) => proc.kill());
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    sendSSE(`Error: ${errorMessage}`);
    res.end();
  }
}
