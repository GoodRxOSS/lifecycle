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

import { EventEmitter } from 'events';
import { Writable } from 'stream';

var mockK8sLog: jest.Mock;
var mockLoadFromDefault: jest.Mock;
var mockLogger: { debug: jest.Mock; warn: jest.Mock; error: jest.Mock };

jest.mock('@kubernetes/client-node', () => {
  mockK8sLog = jest.fn();
  mockLoadFromDefault = jest.fn();

  return {
    KubeConfig: jest.fn().mockImplementation(() => ({ loadFromDefault: mockLoadFromDefault })),
    Log: jest.fn().mockImplementation(() => ({ log: mockK8sLog })),
  };
});

jest.mock('server/lib/logger', () => {
  mockLogger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { getLogger: () => mockLogger };
});

import { streamK8sLogs } from './k8sStreamer';

function callbacks() {
  return {
    onData: jest.fn(),
    onError: jest.fn(),
    onEnd: jest.fn(),
  };
}

function params(overrides: Partial<Parameters<typeof streamK8sLogs>[0]> = {}) {
  return {
    podName: 'pod-1',
    namespace: 'env-1',
    containerName: 'app',
    follow: true,
    tailLines: 25,
    timestamps: true,
    ...overrides,
  };
}

async function flushAsyncWork() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('streamK8sLogs', () => {
  beforeEach(() => {
    mockK8sLog.mockReset();
    mockLoadFromDefault.mockReset();
    mockLogger.debug.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
  });

  it('normalizes init container names, forwards log options, and emits complete lines plus the final fragment', async () => {
    const request = new EventEmitter();
    const handlers = callbacks();
    let destination!: Writable;
    mockK8sLog.mockImplementation(async (_namespace, _podName, _containerName, stream: Writable, _options) => {
      destination = stream;
      return request;
    });

    streamK8sLogs(params({ containerName: '[init] setup' }), handlers);
    await flushAsyncWork();

    expect(mockLoadFromDefault).toHaveBeenCalledTimes(1);
    expect(mockK8sLog).toHaveBeenCalledWith('env-1', 'pod-1', 'setup', destination, {
      follow: true,
      tailLines: 25,
      timestamps: true,
      pretty: false,
    });

    destination.write('first\npar');
    destination.write('tial\n\nlast');
    request.emit('complete');
    await flushAsyncWork();

    expect(handlers.onData.mock.calls.map(([line]) => line)).toEqual(['first', 'partial', 'last']);
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    expect(handlers.onError).not.toHaveBeenCalled();

    request.emit('complete');
    request.emit('error', new Error('late error'));
    destination.emit('data', Buffer.from('late\n'));
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    expect(handlers.onData).toHaveBeenCalledTimes(3);
  });

  it('omits an undefined tail limit and reports request errors exactly once', async () => {
    const request = new EventEmitter();
    const handlers = callbacks();
    mockK8sLog.mockResolvedValue(request);

    streamK8sLogs(params({ tailLines: undefined, follow: false, timestamps: false }), handlers);
    await flushAsyncWork();

    expect(mockK8sLog.mock.calls[0][4]).toEqual({ follow: false, timestamps: false, pretty: false });
    const failure = new Error('socket reset');
    request.emit('error', failure);
    request.emit('error', new Error('duplicate'));

    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(handlers.onError).toHaveBeenCalledWith(failure);
    expect(handlers.onEnd).not.toHaveBeenCalled();
  });

  it('reports stream errors and discards an incomplete buffered line', async () => {
    const request = new EventEmitter();
    const handlers = callbacks();
    let destination!: Writable;
    mockK8sLog.mockImplementation(async (_namespace, _podName, _containerName, stream: Writable) => {
      destination = stream;
      return request;
    });
    streamK8sLogs(params(), handlers);
    await flushAsyncWork();

    destination.write('incomplete');
    const failure = new Error('stream failed');
    destination.emit('error', failure);
    destination.emit('error', new Error('duplicate'));
    destination.emit('end');

    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(handlers.onError).toHaveBeenCalledWith(failure);
    expect(handlers.onData).not.toHaveBeenCalled();
    expect(handlers.onEnd).not.toHaveBeenCalled();
  });

  it('converts a synchronous end-callback failure into an error callback', async () => {
    const request = new EventEmitter();
    const failure = new Error('consumer rejected end');
    const handlers = callbacks();
    handlers.onEnd.mockImplementation(() => {
      throw failure;
    });
    let destination!: Writable;
    mockK8sLog.mockImplementation(async (_namespace, _podName, _containerName, stream: Writable) => {
      destination = stream;
      return request;
    });
    streamK8sLogs(params(), handlers);
    await flushAsyncWork();

    destination.end();
    await flushAsyncWork();

    expect(handlers.onError).toHaveBeenCalledWith(failure);
    expect(mockLogger.error).toHaveBeenCalledWith({ error: failure }, expect.stringContaining('end processing failed'));
  });

  it('normalizes a non-Error thrown by an end callback', async () => {
    const request = new EventEmitter();
    const handlers = callbacks();
    handlers.onEnd.mockImplementation(() => {
      throw 'consumer stopped';
    });
    let destination!: Writable;
    mockK8sLog.mockImplementation(async (_namespace, _podName, _containerName, stream: Writable) => {
      destination = stream;
      return request;
    });
    streamK8sLogs(params(), handlers);
    await flushAsyncWork();

    destination.end();
    await flushAsyncWork();

    expect(handlers.onError).toHaveBeenCalledWith(new Error('consumer stopped'));
  });

  it('contains consumer failures while processing data chunks', async () => {
    const request = new EventEmitter();
    const handlers = callbacks();
    const failure = new Error('consumer rejected line');
    handlers.onData.mockImplementation(() => {
      throw failure;
    });
    let destination!: Writable;
    mockK8sLog.mockImplementation(async (_namespace, _podName, _containerName, stream: Writable) => {
      destination = stream;
      return request;
    });
    streamK8sLogs(params(), handlers);
    await flushAsyncWork();

    expect(() => destination.write('line\n')).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalledWith(
      { error: failure },
      expect.stringContaining('data chunk processing failed')
    );
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it('reports connection failures but treats AbortError as a normal end', async () => {
    const failedHandlers = callbacks();
    const failure = new Error('authorization failed');
    mockK8sLog.mockRejectedValueOnce(failure);

    streamK8sLogs(params(), failedHandlers);
    await flushAsyncWork();
    expect(failedHandlers.onError).toHaveBeenCalledWith(failure);
    expect(failedHandlers.onEnd).not.toHaveBeenCalled();

    const abortedHandlers = callbacks();
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    mockK8sLog.mockRejectedValueOnce(abortError);
    streamK8sLogs(params(), abortedHandlers);
    await flushAsyncWork();
    expect(abortedHandlers.onEnd).toHaveBeenCalledTimes(1);
    expect(abortedHandlers.onError).not.toHaveBeenCalled();
  });

  it('delivers request and connection errors directly when the destination is no longer writable', async () => {
    const request = new EventEmitter();
    const requestHandlers = callbacks();
    let requestDestination!: Writable;
    mockK8sLog.mockImplementationOnce(async (_namespace, _podName, _containerName, stream: Writable) => {
      requestDestination = stream;
      return request;
    });
    streamK8sLogs(params(), requestHandlers);
    await flushAsyncWork();
    requestDestination.destroy();

    const requestFailure = new Error('request failed after destroy');
    request.emit('error', requestFailure);
    expect(requestHandlers.onError).toHaveBeenCalledWith(requestFailure);

    let rejectConnection!: (error: Error) => void;
    const connectionHandlers = callbacks();
    let connectionDestination!: Writable;
    mockK8sLog.mockImplementationOnce(
      (_namespace, _podName, _containerName, stream: Writable) =>
        new Promise((_resolve, reject) => {
          connectionDestination = stream;
          rejectConnection = reject;
        })
    );
    streamK8sLogs(params(), connectionHandlers);
    connectionDestination.destroy();
    const connectionFailure = new Error('connection failed after destroy');
    rejectConnection(connectionFailure);
    await flushAsyncWork();
    expect(connectionHandlers.onError).toHaveBeenCalledWith(connectionFailure);
  });

  it('aborts the Kubernetes request and suppresses all subsequent stream callbacks', async () => {
    const request = Object.assign(new EventEmitter(), { abort: jest.fn() });
    const handlers = callbacks();
    let destination!: Writable;
    mockK8sLog.mockImplementation(async (_namespace, _podName, _containerName, stream: Writable) => {
      destination = stream;
      return request;
    });
    const handle = streamK8sLogs(params(), handlers);
    await flushAsyncWork();

    handle.abort();
    request.emit('complete');
    request.emit('error', new Error('late'));
    destination.emit('data', Buffer.from('late\n'));
    destination.emit('end');

    expect(request.abort).toHaveBeenCalledTimes(1);
    expect(handlers.onData).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onEnd).not.toHaveBeenCalled();
  });

  it('logs unavailable and failed abort attempts without throwing', async () => {
    let rejectRequest!: (error: Error) => void;
    mockK8sLog.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectRequest = reject;
      })
    );
    const earlyHandle = streamK8sLogs(params(), callbacks());
    expect(() => earlyHandle.abort()).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('abort requested but request unavailable'));
    rejectRequest(new Error('late connection failure'));
    await flushAsyncWork();

    const abortFailure = new Error('abort failed');
    const request = Object.assign(new EventEmitter(), {
      abort: jest.fn(() => {
        throw abortFailure;
      }),
    });
    mockK8sLog.mockResolvedValueOnce(request);
    const handle = streamK8sLogs(params(), callbacks());
    await flushAsyncWork();

    expect(() => handle.abort()).not.toThrow();
    expect(mockLogger.error).toHaveBeenCalledWith(
      { error: abortFailure },
      expect.stringContaining('abort call failed')
    );
  });
});
