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

jest.mock('dd-trace', () => {
  const finish = jest.fn();
  const setTag = jest.fn();
  const activate = jest.fn((_span, callback) => callback());
  const active = jest.fn(() => ({ setTag }));
  return {
    tracer: {
      startSpan: jest.fn(() => ({ finish })),
      scope: jest.fn(() => ({ activate, active })),
      wrap: jest.fn((_name, _tags, fn) => fn),
      trace: jest.fn((_name, _tags, fn) => fn()),
      __test: { finish, setTag, activate, active },
    },
  };
});
jest.mock('server/lib/logger', () => {
  const error = jest.fn();
  return {
    getLogger: jest.fn(() => ({ error })),
    __test: { error },
  };
});

import DefaultTracer, { Tracer } from 'server/lib/tracer';

const mockDdTracer = jest.requireMock('dd-trace').tracer as Record<string, any>;
const mockStartSpan = mockDdTracer.startSpan as jest.Mock;
const mockScope = mockDdTracer.scope as jest.Mock;
const mockWrap = mockDdTracer.wrap as jest.Mock;
const mockTrace = mockDdTracer.trace as jest.Mock;
const mockFinish = mockDdTracer.__test.finish as jest.Mock;
const mockSetTag = mockDdTracer.__test.setTag as jest.Mock;
const mockActivate = mockDdTracer.__test.activate as jest.Mock;
const mockLoggerError = jest.requireMock('server/lib/logger').__test.error as jest.Mock;

describe('Tracer', () => {
  let profiler: Tracer;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockDdTracer, {
      startSpan: mockStartSpan,
      scope: mockScope,
      wrap: mockWrap,
      trace: mockTrace,
    });
    profiler = Tracer.getInstance();
    Object.assign(profiler as any, { isInitialized: false, tags: {} });
  });

  it('is a singleton and rejects direct construction after initialization', () => {
    expect(DefaultTracer).toBe(Tracer);
    expect(Tracer.getInstance()).toBe(profiler);
    expect(() => new (Tracer as any)()).toThrow('This class is a singleton!');
    expect(mockLoggerError).toHaveBeenCalledWith('Tracer: singleton violation');
  });

  it('starts and activates an initial span with service tags', () => {
    expect(profiler.initialize('test-service', { version: '1.0.0' })).toBe(profiler);

    expect(mockStartSpan).toHaveBeenCalledWith('test-service', {
      tags: { name: 'test-service', version: '1.0.0' },
    });
    expect(mockActivate).toHaveBeenCalledWith(expect.any(Object), expect.any(Function));
    expect(mockFinish).toHaveBeenCalledTimes(1);
    expect((profiler as any).isInitialized).toBe(true);
  });

  it('updates tags instead of creating another root span after initialization', () => {
    profiler.initialize('test-service', { version: '1' });
    mockStartSpan.mockClear();

    profiler.initialize('ignored-name', { region: 'us-west-2' });

    expect(mockStartSpan).not.toHaveBeenCalled();
    expect((profiler as any).tags).toEqual({ name: 'test-service', version: '1', region: 'us-west-2' });
  });

  it('finishes directly when scope activation is unavailable', () => {
    mockDdTracer.scope = undefined;

    profiler.initialize('test-service');

    expect(mockFinish).toHaveBeenCalledTimes(1);
  });

  it('contains invalid names and tracer startup failures', () => {
    expect(profiler.initialize('')).toBe(profiler);
    expect((profiler as any).isInitialized).toBe(false);

    const failure = new Error('datadog unavailable');
    mockStartSpan.mockImplementationOnce(() => {
      throw failure;
    });
    expect(profiler.initialize('test-service')).toBe(profiler);
    expect(mockLoggerError).toHaveBeenCalledWith({ error: failure }, 'Tracer: initialization failed');
  });

  it('still initializes when no startSpan API is installed', () => {
    mockDdTracer.startSpan = undefined;

    profiler.initialize('test-service');

    expect((profiler as any).isInitialized).toBe(true);
  });

  it('merges root and call tags for wrap, trace, and startSpan', () => {
    Object.assign(profiler as any, { tags: { service: 'lifecycle', shared: 'root' } });
    const fn = jest.fn(() => 'result');

    expect(profiler.wrap('wrapped', fn, { shared: 'call' })()).toBe('result');
    expect(profiler.trace('traced', fn, { operation: 'query' })).toBe('result');
    expect(profiler.startSpan('child', { resource: 'repo' })).toEqual({ finish: mockFinish });

    expect(mockWrap).toHaveBeenCalledWith('wrapped', { service: 'lifecycle', shared: 'call' }, fn);
    expect(mockTrace).toHaveBeenCalledWith('traced', { service: 'lifecycle', shared: 'root', operation: 'query' }, fn);
    expect(mockStartSpan).toHaveBeenCalledWith('child', {
      tags: { service: 'lifecycle', shared: 'root', resource: 'repo' },
    });
  });

  it('returns safe fallbacks when optional tracer APIs are unavailable', () => {
    const fn = jest.fn();
    mockDdTracer.wrap = undefined;
    mockDdTracer.trace = undefined;
    mockDdTracer.startSpan = undefined;

    expect(profiler.wrap('wrapped', fn)).toBe(fn);
    expect(profiler.trace('traced', fn)).toBe(fn);
    expect(profiler.startSpan('child')).toBeUndefined();
  });

  it('decorates initialized methods and records synchronous failures on the active span', () => {
    profiler.initialize('test-service', { version: '1' });
    const descriptor: PropertyDescriptor = {
      configurable: true,
      value: jest.fn((value: number) => value * 2),
    };
    Tracer.Trace()({}, 'double', descriptor);

    expect(descriptor.value(4)).toBe(8);
    expect(mockTrace).toHaveBeenLastCalledWith(
      'double',
      { tags: { name: 'test-service', version: '1', decorator: 'Trace' } },
      expect.any(Function)
    );

    const failure = new Error('method failed');
    descriptor.value = jest.fn(() => {
      throw failure;
    });
    Tracer.Trace()({}, Symbol.for('failingMethod'), descriptor);
    expect(() => descriptor.value()).toThrow(failure);
    expect(mockSetTag).toHaveBeenCalledWith('error', true);
    expect(mockLoggerError).toHaveBeenCalledWith(
      { error: failure },
      'Tracer: decorator failed method=Symbol(failingMethod)'
    );
  });

  it('calls the original decorated method without tracing before initialization', () => {
    const original = jest.fn(() => 'plain');
    const descriptor: PropertyDescriptor = { value: original };
    Tracer.Trace()({}, 'plainMethod', descriptor);

    expect(descriptor.value()).toBe('plain');
    expect(original).toHaveBeenCalledTimes(1);
    expect(mockTrace).not.toHaveBeenCalled();
  });
});
