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

import { readBoundedResponseText, ResponseBodyTooLargeError } from '../readBoundedResponse';

type ReaderResult = { done: boolean; value?: Uint8Array };

function responseFixture({
  contentLength,
  reads = [],
  body = true,
}: {
  contentLength?: string;
  reads?: ReaderResult[];
  body?: boolean;
} = {}) {
  const bodyCancel = jest.fn().mockResolvedValue(undefined);
  const readerCancel = jest.fn().mockResolvedValue(undefined);
  const releaseLock = jest.fn();
  const read = jest.fn();
  for (const result of reads) read.mockResolvedValueOnce(result);
  const streamBody = body
    ? {
        cancel: bodyCancel,
        getReader: () => ({ read, cancel: readerCancel, releaseLock }),
      }
    : null;
  const headers = new Headers();
  if (contentLength !== undefined) headers.set('content-length', contentLength);

  return {
    response: { headers, body: streamBody } as unknown as Response,
    bodyCancel,
    readerCancel,
    read,
    releaseLock,
  };
}

describe('readBoundedResponseText', () => {
  it('returns an empty string when the response has no body', async () => {
    const { response } = responseFixture({ body: false });

    await expect(readBoundedResponseText(response, 100)).resolves.toBe('');
  });

  it('rejects an oversized declared body and cancels it before reading', async () => {
    const fixture = responseFixture({ contentLength: '101' });

    await expect(readBoundedResponseText(fixture.response, 100)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(fixture.bodyCancel).toHaveBeenCalledTimes(1);
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it('still reports an oversized declaration when body cancellation fails', async () => {
    const fixture = responseFixture({ contentLength: '101' });
    fixture.bodyCancel.mockRejectedValue(new Error('cancel failed'));

    await expect(readBoundedResponseText(fixture.response, 100)).rejects.toMatchObject({
      name: 'ResponseBodyTooLargeError',
      message: 'Response body exceeds the configured limit',
    });
  });

  it('rejects an oversized declaration even when there is no stream to cancel', async () => {
    const { response } = responseFixture({ contentLength: '101', body: false });

    await expect(readBoundedResponseText(response, 100)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
  });

  it.each(['not-a-number', 'Infinity'])(
    'ignores the non-finite content-length %p and reads the stream',
    async (value) => {
      const fixture = responseFixture({
        contentLength: value,
        reads: [{ done: false, value: new TextEncoder().encode('ok') }, { done: true }],
      });

      await expect(readBoundedResponseText(fixture.response, 2)).resolves.toBe('ok');
      expect(fixture.bodyCancel).not.toHaveBeenCalled();
    }
  );

  it('accepts a declared length exactly at the configured boundary', async () => {
    const fixture = responseFixture({
      contentLength: '2',
      reads: [{ done: false, value: new TextEncoder().encode('ok') }, { done: true }],
    });

    await expect(readBoundedResponseText(fixture.response, 2)).resolves.toBe('ok');
  });

  it('reassembles multiple chunks before decoding split UTF-8 characters', async () => {
    const encoded = new TextEncoder().encode('A€Z');
    const fixture = responseFixture({
      reads: [
        { done: false, value: encoded.slice(0, 2) },
        { done: false, value: encoded.slice(2, 4) },
        { done: false, value: encoded.slice(4) },
        { done: true },
      ],
    });

    await expect(readBoundedResponseText(fixture.response, encoded.byteLength)).resolves.toBe('A€Z');
    expect(fixture.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('cancels an incrementally oversized stream and always releases the reader', async () => {
    const fixture = responseFixture({
      reads: [
        { done: false, value: new Uint8Array([1, 2]) },
        { done: false, value: new Uint8Array([3]) },
      ],
    });

    await expect(readBoundedResponseText(fixture.response, 2)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(fixture.readerCancel).toHaveBeenCalledTimes(1);
    expect(fixture.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('preserves the size error when incremental stream cancellation rejects', async () => {
    const fixture = responseFixture({ reads: [{ done: false, value: new Uint8Array([1, 2, 3]) }] });
    fixture.readerCancel.mockRejectedValue(new Error('cancel failed'));

    await expect(readBoundedResponseText(fixture.response, 2)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(fixture.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('releases the reader and propagates a stream read failure', async () => {
    const fixture = responseFixture();
    const error = new Error('stream failed');
    fixture.read.mockRejectedValue(error);

    await expect(readBoundedResponseText(fixture.response, 100)).rejects.toBe(error);
    expect(fixture.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid UTF-8 after releasing the fully-read stream', async () => {
    const fixture = responseFixture({
      reads: [{ done: false, value: new Uint8Array([0xc3, 0x28]) }, { done: true }],
    });

    await expect(readBoundedResponseText(fixture.response, 2)).rejects.toMatchObject({ name: 'TypeError' });
    expect(fixture.releaseLock).toHaveBeenCalledTimes(1);
  });
});
