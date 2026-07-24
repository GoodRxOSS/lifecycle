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

export type LinkQueryParams = {
  name: string;
  value: string;
};

export type ConstructLink = {
  name: string;
  url: string;
  queryParams?: LinkQueryParams[];
  buildId?: string;
};

export type Link = {
  name: string;
  url: string;
};

export type FeatureFlags = Record<string, boolean>;

export interface ContainerInfo {
  name: string;
  state: string;
}

export interface StreamingInfo {
  status: 'Running' | 'Pending';
  streamingRequired: true;
  websocket: {
    endpoint: string;
    parameters: {
      podName: string;
      namespace: string;
      follow: boolean;
      tailLines: number;
      timestamps: boolean;
    };
  };
  containers: ContainerInfo[];
}

export interface LogSourceStatus {
  status: 'Completed' | 'Failed' | 'NotFound' | 'Unavailable' | 'NotApplicable' | 'Unknown';
  podName?: string | null;
  streamingRequired: false;
  containers?: ContainerInfo[];
  message: string;
}

export function isStreamingInfo(response: StreamingInfo | LogSourceStatus): response is StreamingInfo {
  return response && (response as StreamingInfo).websocket !== undefined && response.streamingRequired === true;
}

export interface LogMessage {
  type: 'log';
  payload: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export interface EndMessage {
  type: 'end';
  reason: string;
}

export type WebSocketMessage = LogMessage | ErrorMessage | EndMessage;

export interface K8sContainerInfo {
  name: string;
  state: string;
}
export interface K8sPodInfo {
  podName: string | null;
  namespace: string;
  status: 'Running' | 'Pending' | 'Succeeded' | 'Failed' | 'Unknown' | 'NotFound';
  containers: K8sContainerInfo[];
  message?: string;
}
