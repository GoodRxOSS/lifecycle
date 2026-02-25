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

import { useCallback, useRef, useState, useEffect } from 'react';

type LogMessage = {
  type: 'log' | 'error' | 'end';
  payload?: string;
  message?: string;
};

interface WebSocketParameters {
  podName: string;
  namespace: string;
  follow: boolean;
  timestamps: boolean;
  container?: string;
}

interface WebSocketConfig {
  websocket?: {
    endpoint: string;
    parameters: WebSocketParameters;
  };
  podName?: string | null;
}

export function useWebSocketLogs(showTimestamps: boolean, uuid?: string) {
  const [logsByContainer, setLogsByContainer] = useState<Record<string, string[]>>({});
  const [, setSocketsByContainer] = useState<Record<string, WebSocket | null>>({});
  const [connectingContainers, setConnectingContainers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const closeAllConnections = useCallback(() => {
    setSocketsByContainer((prev) => {
      Object.values(prev).forEach((socket) => {
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          socket.close();
        }
      });
      return {};
    });
  }, []);

  const connectToContainer = useCallback(
    (containerName: string, jobInfo: WebSocketConfig) => {
      if (!jobInfo || !isMountedRef.current) return;

      if (!jobInfo.websocket && !jobInfo.podName) return;

      setSocketsByContainer((prev) => {
        if (prev[containerName] && prev[containerName]?.readyState !== WebSocket.CLOSED) {
          prev[containerName]?.close();
        }
        return { ...prev, [containerName]: null };
      });

      if (isMountedRef.current) {
        setConnectingContainers((prev) => [...prev, containerName]);
        setLogsByContainer((prev) => ({
          ...prev,
          [containerName]: [],
        }));
      }

      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;

      const params = new URLSearchParams();

      if (jobInfo.websocket) {
        const follow = jobInfo.websocket.parameters.follow;
        params.append('podName', jobInfo.websocket.parameters.podName);
        params.append('namespace', jobInfo.websocket.parameters.namespace);
        params.append('containerName', containerName);
        params.append('follow', follow.toString());
        if (follow) params.append('tailLines', '1000');
        params.append('timestamps', showTimestamps.toString());
      } else if (jobInfo.podName) {
        params.append('podName', jobInfo.podName);
        params.append('namespace', `env-${uuid}`);
        params.append('containerName', containerName);
        params.append('follow', 'false');
        params.append('timestamps', showTimestamps.toString());
      }

      const wsUrl = `${wsProtocol}//${host}/api/logs/stream?${params.toString()}`;

      try {
        const newSocket = new WebSocket(wsUrl);

        newSocket.onopen = () => {
          if (isMountedRef.current) {
            setConnectingContainers((prev) => prev.filter((c) => c !== containerName));
          }
        };

        newSocket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as LogMessage;

            if (data.type === 'log' && data.payload) {
              if (isMountedRef.current) {
                setLogsByContainer((prev) => ({
                  ...prev,
                  [containerName]: [...(prev[containerName] || []), data.payload],
                }));
              }
            } else if (data.type === 'error' && data.message) {
              console.error(`Log stream error for ${containerName}:`, data.message);
              if (isMountedRef.current) {
                if (data.message !== 'No logs available') {
                  setError(`Log stream error for ${containerName}: ${data.message}`);
                }
              }
              setConnectingContainers((prev) => prev.filter((c) => c !== containerName));
            } else if (data.type === 'end') {
              if (isMountedRef.current) {
                setConnectingContainers((prev) => prev.filter((c) => c !== containerName));
              }
            }
          } catch (err) {
            console.error(`Error parsing WebSocket message for ${containerName}:`, err);
          }
        };

        newSocket.onerror = (err) => {
          console.error(`WebSocket error for ${containerName}:`, err);
          if (isMountedRef.current) {
            setError(`WebSocket connection error for ${containerName}`);
            setConnectingContainers((prev) => prev.filter((c) => c !== containerName));
          }
        };

        newSocket.onclose = () => {
          if (isMountedRef.current) {
            setConnectingContainers((prev) => prev.filter((c) => c !== containerName));
          }
        };

        if (isMountedRef.current) {
          setSocketsByContainer((prev) => ({
            ...prev,
            [containerName]: newSocket,
          }));
        } else {
          newSocket.close();
        }
      } catch (err) {
        console.error(`Error creating WebSocket for ${containerName}:`, err);
        if (isMountedRef.current) {
          setError(`Failed to create WebSocket for ${containerName}`);
          setConnectingContainers((prev) => prev.filter((c) => c !== containerName));
        }
      }
    },
    [showTimestamps, uuid]
  );

  return {
    logsByContainer,
    connectingContainers,
    error,
    setError,
    connectToContainer,
    closeAllConnections,
    setLogsByContainer,
  };
}
