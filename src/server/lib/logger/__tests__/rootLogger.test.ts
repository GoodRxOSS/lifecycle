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

const mockPino = jest.fn();
const mockPinoCaller = jest.fn();
let mockLogLevel: string | undefined;

jest.mock('pino', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockPino(...args),
}));

jest.mock('pino-caller', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockPinoCaller(...args),
}));

jest.mock('../../../../shared/config', () => ({
  get LOG_LEVEL() {
    return mockLogLevel;
  },
}));

type PinoOptions = {
  enabled: boolean;
  level: string;
  transport?: {
    target: string;
    options: { colorize: boolean };
  };
  serializers: {
    error: (value: unknown) => Record<string, unknown> | string;
  };
  formatters: {
    level: (label: string) => { level: string };
  };
};

const originalPinoLogger = process.env.PINO_LOGGER;
const originalPinoPretty = process.env.PINO_PRETTY;

function restoreEnvironmentVariable(name: 'PINO_LOGGER' | 'PINO_PRETTY', value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function loadRootLogger(): typeof import('../rootLogger') {
  return require('../rootLogger') as typeof import('../rootLogger');
}

describe('rootLogger', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockLogLevel = undefined;
    delete process.env.PINO_LOGGER;
    delete process.env.PINO_PRETTY;

    mockPino.mockReturnValue({ kind: 'base-logger' });
    mockPinoCaller.mockReturnValue({ kind: 'caller-logger' });
  });

  afterAll(() => {
    restoreEnvironmentVariable('PINO_LOGGER', originalPinoLogger);
    restoreEnvironmentVariable('PINO_PRETTY', originalPinoPretty);
  });

  it('creates an enabled info logger without pretty transport by default', () => {
    const loaded = loadRootLogger();

    expect(loaded.enabled).toBe(true);
    expect(loaded.level).toBe('info');
    expect(loaded.pinoPretty).toBe(false);
    expect(mockPino).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        level: 'info',
      })
    );
    expect(mockPino.mock.calls[0][0]).not.toHaveProperty('transport');
    expect(mockPinoCaller).toHaveBeenCalledWith({ kind: 'base-logger' });
    expect(loaded.default).toEqual({ kind: 'caller-logger' });
  });

  it('honors logger disablement, configured level, and pretty transport', () => {
    process.env.PINO_LOGGER = 'false';
    process.env.PINO_PRETTY = 'true';
    mockLogLevel = 'debug';

    const loaded = loadRootLogger();

    expect(loaded.enabled).toBe(false);
    expect(loaded.level).toBe('debug');
    expect(loaded.pinoPretty).toBe(true);
    expect(mockPino).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        level: 'debug',
        transport: {
          target: 'pino-pretty',
          options: { colorize: true },
        },
      })
    );
  });

  it('serializes errors, objects, and primitives into stable log-safe values', () => {
    loadRootLogger();
    const options = mockPino.mock.calls[0][0] as PinoOptions;
    const error = Object.assign(new Error('request failed'), {
      code: 'request_failed',
      statusCode: 503,
    });

    expect(options.serializers.error(error)).toEqual(
      expect.objectContaining({
        type: 'Error',
        message: 'request failed',
        code: 'request_failed',
        statusCode: 503,
      })
    );
    expect(options.serializers.error(new Error('plain failure'))).toEqual(
      expect.not.objectContaining({ code: expect.anything(), statusCode: expect.anything() })
    );
    expect(options.serializers.error({ reason: 'bad input' })).toBe('{"reason":"bad input"}');
    expect(options.serializers.error(42)).toBe('42');
    expect(options.formatters.level('warn')).toEqual({ level: 'warn' });
  });

  it('uses a safe fallback when an object cannot be serialized', () => {
    loadRootLogger();
    const options = mockPino.mock.calls[0][0] as PinoOptions;
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(options.serializers.error(circular)).toBe('[Unserializable Object]');
  });
});
