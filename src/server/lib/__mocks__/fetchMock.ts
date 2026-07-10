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

export function res(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status-${status}`,
    text: async () => text,
  } as unknown as Response;
}

export type FetchRoute = [method: string, urlPart: string, responses: Response[]];

export interface FetchMockHarness {
  /** The active jest mock installed as globalThis.fetch (recreated per test). */
  fetch(): jest.Mock;
  /** Routes match in order (list specific paths first); the last queued response repeats. */
  routeFetch(routes: FetchRoute[]): void;
  callsMatching(method: string, urlPart: string): Array<[string, RequestInit | undefined]>;
}

/** Installs a route-based global-fetch mock for the current describe block. */
export default function setupFetchMock(): FetchMockHarness {
  let fetchMock: jest.Mock;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  return {
    fetch: () => fetchMock,
    routeFetch(routes: FetchRoute[]): void {
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const method = (init?.method || 'GET').toUpperCase();
        for (const [routeMethod, urlPart, responses] of routes) {
          if (routeMethod === method && String(url).includes(urlPart)) {
            return responses.length > 1 ? responses.shift() : responses[0];
          }
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      });
    },
    callsMatching(method: string, urlPart: string): Array<[string, RequestInit | undefined]> {
      return fetchMock.mock.calls.filter(
        ([url, init]: [string, RequestInit | undefined]) =>
          ((init?.method || 'GET') as string).toUpperCase() === method && String(url).includes(urlPart)
      );
    },
  };
}
