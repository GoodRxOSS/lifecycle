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

export type AgentSessionStatus = 'active' | 'ended' | 'error';

export interface AgentSessionCreatePayload {
  buildUuid?: string;
  services?: string[];
  model?: string;
}

export interface AgentSessionResponse {
  id: string;
  buildUuid: string | null;
  userId: string;
  podName: string;
  namespace: string;
  model: string;
  status: AgentSessionStatus;
  services: string[];
  createdAt: string;
  endedAt: string | null;
  websocketUrl: string;
  editorUrl?: string;
}

export type AgentWSClientMessage =
  | { type: 'message'; content: string }
  | { type: 'cancel' }
  | { type: 'set_model'; model: string }
  | { type: 'resize'; cols: number; rows: number };

export type AgentWSPhase = 'thinking' | 'drafting' | 'preparing_tool' | 'running_tool' | 'reviewing_tool';

export interface AgentWSDebugMetrics {
  iterations: number;
  totalToolCalls: number;
  totalDurationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalCostUsd?: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
}

export type AgentWSServerMessage =
  | { type: 'chunk'; content: string }
  | { type: 'tool_use'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: string; success: boolean }
  | {
      type: 'usage';
      scope: 'step' | 'session';
      messageId?: string;
      metrics: AgentWSDebugMetrics;
    }
  | { type: 'phase'; phase: AgentWSPhase; label: string; tool?: string }
  | { type: 'prompt'; message: string; promptId: string }
  | { type: 'status'; status: 'connecting' | 'ready' | 'working' | 'idle' | 'error' | 'ended' }
  | { type: 'heartbeat'; ts: number }
  | { type: 'dev_reload'; service: string; trigger: string };
