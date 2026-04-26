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

import {
  DEFAULT_AGENT_SESSION_MAX_DURABLE_PAYLOAD_BYTES,
  DEFAULT_AGENT_SESSION_PAYLOAD_PREVIEW_BYTES,
} from 'server/lib/agentSession/runtimeConfig';

export const MAX_AGENT_DURABLE_PAYLOAD_BYTES = DEFAULT_AGENT_SESSION_MAX_DURABLE_PAYLOAD_BYTES;
const PREVIEW_BYTES = DEFAULT_AGENT_SESSION_PAYLOAD_PREVIEW_BYTES;

export interface DurablePayloadLimits {
  maxDurablePayloadBytes?: number;
  payloadPreviewBytes?: number;
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

export function limitDurablePayloadValue(value: unknown, limits: DurablePayloadLimits = {}): unknown {
  const maxBytes = limits.maxDurablePayloadBytes ?? MAX_AGENT_DURABLE_PAYLOAD_BYTES;
  const previewBytes = limits.payloadPreviewBytes ?? PREVIEW_BYTES;
  const serialized = JSON.stringify(value) ?? 'null';
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= maxBytes) {
    return value;
  }

  return {
    truncated: true,
    originalJsonBytes: bytes,
    preview: serialized.slice(0, previewBytes),
  };
}

export function limitDurablePayloadRecord(
  payload: Record<string, unknown>,
  limits: DurablePayloadLimits = {}
): Record<string, unknown> {
  const maxBytes = limits.maxDurablePayloadBytes ?? MAX_AGENT_DURABLE_PAYLOAD_BYTES;
  if (jsonByteLength(payload) <= maxBytes) {
    return payload;
  }

  const limited: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    limited[key] = limitDurablePayloadValue(value, limits);
  }

  if (jsonByteLength(limited) <= maxBytes) {
    return limited;
  }

  return limitDurablePayloadValue(payload, limits) as Record<string, unknown>;
}
