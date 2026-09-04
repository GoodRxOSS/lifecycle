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

const mockDnsLookup = jest.fn();

jest.mock('dns', () => ({
  __esModule: true,
  default: {
    lookup: (...args: unknown[]) => mockDnsLookup(...args),
  },
}));

jest.mock('hot-shots', () => {
  class MockStatsD {
    static options: unknown;

    increment = jest.fn();
    timing = jest.fn();
    gauge = jest.fn();
    event = jest.fn();

    constructor(options: unknown) {
      MockStatsD.options = options;
    }
  }

  return { __esModule: true, default: MockStatsD };
});

import StatsD from 'hot-shots';
import MetricsDefault, { Metrics } from '../index';

type Lookup = (host: string, options: unknown, callback: (...args: unknown[]) => void) => void;

function configuredLookup(): Lookup {
  const configured = StatsD as unknown as {
    options: { udpSocketOptions: { lookup: Lookup } };
  };
  return configured.options.udpSocketOptions.lookup;
}

describe('Metrics StatsD DNS lookup', () => {
  it('uses the initialized StatsD client by default and preserves the default export', () => {
    const metrics = new Metrics('default-client', {});

    expect(MetricsDefault).toBe(Metrics);
    expect(metrics.client).toBeInstanceOf(StatsD);
  });

  it('returns an IPv4 literal directly without a DNS lookup', () => {
    const callback = jest.fn();

    configuredLookup()('127.0.0.1', { family: 4 }, callback);

    expect(callback).toHaveBeenCalledWith(null, '127.0.0.1', 4);
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });

  it('delegates host names to the system DNS resolver unchanged', () => {
    const callback = jest.fn();
    const options = { family: 4, all: false };

    configuredLookup()('metrics.example.com', options, callback);

    expect(mockDnsLookup).toHaveBeenCalledWith('metrics.example.com', options, callback);
    expect(callback).not.toHaveBeenCalled();
  });
});
