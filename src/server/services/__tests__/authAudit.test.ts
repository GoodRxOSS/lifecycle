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

const mockAuthAuditQuery = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('server/models/AuthAuditEvent', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockAuthAuditQuery(...args),
  },
}));

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ warn: mockLoggerWarn })),
}));

import { recordAuthAuditEvent, recordAuthAuditEventInTransaction } from '../authAudit';

const input = {
  event: 'token.created',
  principalKind: 'api_token',
  outcome: 'success',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('authAudit', () => {
  it('persists a complete row with null defaults for absent optional context', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    mockAuthAuditQuery.mockReturnValue({ insert });

    await recordAuthAuditEvent(input);

    expect(insert).toHaveBeenCalledWith({
      event: 'token.created',
      principalKind: 'api_token',
      principalId: null,
      actorId: null,
      tokenId: null,
      requestId: null,
      route: null,
      outcome: 'success',
      meta: null,
    });
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('contains best-effort insert failures and records diagnostic context', async () => {
    const error = new Error('database unavailable');
    mockAuthAuditQuery.mockReturnValue({ insert: jest.fn().mockRejectedValue(error) });

    await expect(recordAuthAuditEvent({ ...input, event: 'token.denied', outcome: 'denied' })).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { error },
      'AuthAudit: event insert failed event=token.denied outcome=denied'
    );
  });

  it('uses the caller transaction and propagates insert failures', async () => {
    const trx = { transaction: true };
    const error = new Error('transaction rolled back');
    const insert = jest.fn().mockRejectedValue(error);
    mockAuthAuditQuery.mockReturnValue({ insert });

    await expect(
      recordAuthAuditEventInTransaction(trx as never, {
        ...input,
        principalId: 'credential-1',
        actorId: 'admin-1',
        tokenId: 12,
        requestId: 'request-1',
        route: '/api/v2/tokens',
        meta: { source: 'admin' },
      })
    ).rejects.toBe(error);

    expect(mockAuthAuditQuery).toHaveBeenCalledWith(trx);
    expect(insert).toHaveBeenCalledWith({
      event: 'token.created',
      principalKind: 'api_token',
      principalId: 'credential-1',
      actorId: 'admin-1',
      tokenId: 12,
      requestId: 'request-1',
      route: '/api/v2/tokens',
      outcome: 'success',
      meta: { source: 'admin' },
    });
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});
