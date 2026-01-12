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

import { KubeConfig } from '@kubernetes/client-node';
import { getLogger } from 'server/lib/logger/index';
import * as k8s from '@kubernetes/client-node';
import { PassThrough, Writable } from 'stream';

export interface AbortHandle {
  abort: () => void;
}

/**
 * Streams logs from a specific container within a Kubernetes pod.
 * @param params Parameters including podName, namespace, containerName, and options.
 * @param callbacks Callbacks for data, error, and end events.
 * @returns An AbortHandle to stop the stream.
 */
export function streamK8sLogs(
  params: {
    podName: string;
    namespace: string;
    containerName: string;
    follow: boolean;
    tailLines: number;
    timestamps: boolean;
  },
  callbacks: {
    // eslint-disable-next-line no-unused-vars
    onData: (line: string) => void;
    // eslint-disable-next-line no-unused-vars
    onError: (err: Error) => void;
    onEnd: () => void;
  }
): AbortHandle {
  const { podName, namespace, containerName: rawContainerName, follow, tailLines, timestamps } = params;
  const containerName = rawContainerName.startsWith('[init] ') ? rawContainerName.substring(7) : rawContainerName;

  const kc = new KubeConfig();
  kc.loadFromDefault();
  const k8sLog = new k8s.Log(kc);

  let k8sRequest: any | null = null;
  let streamEnded = false;

  const stream = new PassThrough();
  let buffer = '';

  stream.on('data', (chunk) => {
    if (streamEnded) return;
    try {
      buffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.substring(0, newlineIndex);
        buffer = buffer.substring(newlineIndex + 1);
        if (line) {
          callbacks.onData(line);
        }
      }
    } catch (e: any) {
      getLogger().error(
        { error: e },
        `K8sStream: data chunk processing failed podName=${podName} namespace=${namespace} containerName=${containerName}`
      );
    }
  });

  stream.on('end', () => {
    if (streamEnded) return;
    streamEnded = true;
    try {
      if (buffer) {
        callbacks.onData(buffer);
        buffer = '';
      }
      callbacks.onEnd();
    } catch (e: any) {
      getLogger().error(
        { error: e },
        `K8sStream: end processing failed podName=${podName} namespace=${namespace} containerName=${containerName}`
      );
      callbacks.onError(e instanceof Error ? e : new Error(String(e)));
    }
  });

  stream.on('error', (err) => {
    if (streamEnded) return;
    streamEnded = true;
    getLogger().error(
      { error: err },
      `K8sStream: error event received podName=${podName} namespace=${namespace} containerName=${containerName}`
    );
    buffer = '';
    callbacks.onError(err);
  });

  (async () => {
    try {
      const logOptions = {
        follow,
        tailLines,
        timestamps,
        pretty: false,
      };

      k8sRequest = await k8sLog.log(namespace, podName, containerName, stream as Writable, logOptions);

      getLogger().debug(
        `K8sStream: promise resolved podName=${podName} namespace=${namespace} containerName=${containerName} follow=${follow}`
      );

      if (k8sRequest) {
        k8sRequest.on('error', (err: Error) => {
          if (streamEnded) return;
          getLogger().error(
            { error: err },
            `K8sStream: request error emitted podName=${podName} namespace=${namespace} containerName=${containerName}`
          );
          if (stream.writable) {
            stream.emit('error', err);
          } else {
            callbacks.onError(err);
          }
        });
        k8sRequest.on('complete', () => {
          if (streamEnded) return;
          if (stream.writable) {
            stream.end();
          }
        });
      }
    } catch (err: any) {
      if (streamEnded) return;
      if (err.name !== 'AbortError') {
        getLogger().error(
          { error: err },
          `K8sStream: connection failed podName=${podName} namespace=${namespace} containerName=${containerName}`
        );
        buffer = '';
        if (stream.writable) {
          stream.emit('error', err);
        } else {
          callbacks.onError(err);
        }
      } else {
        if (stream.writable) {
          stream.end();
        }
      }
    }
  })();

  return {
    abort: () => {
      if (k8sRequest && typeof k8sRequest.abort === 'function') {
        try {
          k8sRequest.abort();
        } catch (abortErr) {
          getLogger().error(
            { error: abortErr },
            `K8sStream: abort call failed podName=${podName} namespace=${namespace} containerName=${containerName}`
          );
        }
      } else {
        getLogger().warn(
          `K8sStream: abort requested but request unavailable podName=${podName} namespace=${namespace} containerName=${containerName}`
        );
      }
      stream.destroy();
      streamEnded = true;
    },
  };
}
