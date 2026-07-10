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

import { BadRequestError } from 'server/lib/appError';
import { parseChatPreviewHost } from './chatPreviewFactory';

type PreviewGrantBody = {
  sessionId?: unknown;
  port?: unknown;
  previewHost?: unknown;
};

export function parsePreviewGrantBody(body: unknown): {
  sessionId: string;
  port: number;
  previewHost: string;
} {
  const payload = (body || {}) as PreviewGrantBody;
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  const port = typeof payload.port === 'number' ? payload.port : Number(payload.port);
  const rawPreviewHost =
    typeof payload.previewHost === 'string' && payload.previewHost.trim() ? payload.previewHost.trim() : null;

  if (!sessionId) {
    throw new BadRequestError('sessionId must be a non-empty string.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BadRequestError('port must be an integer between 1 and 65535.');
  }

  if (!rawPreviewHost) {
    throw new BadRequestError('previewHost must be a Lifecycle preview host for the requested port.');
  }

  const parsedHost = parseChatPreviewHost(rawPreviewHost);
  if (!parsedHost || parsedHost.port !== port) {
    throw new BadRequestError('previewHost must be a Lifecycle preview host for the requested port.');
  }

  return { sessionId, port, previewHost: parsedHost.host };
}
