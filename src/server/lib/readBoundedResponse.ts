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

export class ResponseBodyTooLargeError extends Error {
  constructor() {
    super('Response body exceeds the configured limit');
    this.name = 'ResponseBodyTooLargeError';
  }
}

export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseBodyTooLargeError();
    }
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  let streamComplete = false;
  try {
    while (!streamComplete) {
      const { done, value } = await reader.read();
      if (done) {
        streamComplete = true;
        continue;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}
