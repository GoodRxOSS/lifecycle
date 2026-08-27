import type { NextApiRequest, NextApiResponse } from 'next';

export type MockRequest = NextApiRequest & {
  on: jest.Mock;
};

export type MockResponse = NextApiResponse & {
  body?: unknown;
  headers: Record<string, unknown>;
  chunks: string[];
};

export function request(overrides: Partial<NextApiRequest> = {}): MockRequest {
  return {
    method: 'GET',
    query: {},
    body: {},
    headers: {},
    on: jest.fn(),
    ...overrides,
  } as MockRequest;
}

export function response(): MockResponse {
  const res = {
    body: undefined,
    headers: {},
    chunks: [],
    statusCode: 0,
  } as unknown as MockResponse;

  res.status = jest.fn((statusCode: number) => {
    res.statusCode = statusCode;
    return res;
  });
  res.json = jest.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  res.send = jest.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  res.redirect = jest.fn(() => res);
  res.setHeader = jest.fn((name: string, value: unknown) => {
    res.headers[name] = value;
    return res;
  });
  res.writeHead = jest.fn(
    (
      statusCode: number,
      statusMessageOrHeaders?: string | Record<string, unknown>,
      headers?: Record<string, unknown>
    ) => {
      res.statusCode = statusCode;
      Object.assign(res.headers, typeof statusMessageOrHeaders === 'string' ? headers : statusMessageOrHeaders);
      return res;
    }
  ) as unknown as MockResponse['writeHead'];
  res.write = jest.fn((chunk: string) => {
    res.chunks.push(chunk);
    return true;
  });
  res.end = jest.fn(() => res);

  return res;
}
