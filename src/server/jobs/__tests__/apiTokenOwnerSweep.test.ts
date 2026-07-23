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

const mockWarn = jest.fn();
const mockInfo = jest.fn();
const mockError = jest.fn();
let mockOwnerRows: { ownerUserId: string | null }[] = [];
const mockQuery = jest.fn(() => {
  const builder: any = {
    distinct: jest.fn(() => builder),
    where: jest.fn(() => builder),
    whereNotNull: jest.fn(() => builder),
    whereNull: jest.fn(() => builder),
    then: (onFulfilled: any, onRejected: any) => Promise.resolve(mockOwnerRows).then(onFulfilled, onRejected),
  };
  return builder;
});

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: mockWarn, info: mockInfo, error: mockError, debug: jest.fn() }),
}));
jest.mock('server/models/ApiToken', () => ({ __esModule: true, default: { query: () => mockQuery() } }));
jest.mock('server/services/apiToken', () => ({
  __esModule: true,
  default: { revokeByOwnerIdentifier: jest.fn() },
}));
jest.mock('server/services/authAudit', () => ({ recordAuthAuditEvent: jest.fn() }));
jest.mock('server/services/keycloakAdmin', () => ({ isConfigured: jest.fn(), getUserStatus: jest.fn() }));

import ApiTokenService from 'server/services/apiToken';
import { recordAuthAuditEvent } from 'server/services/authAudit';
import { getUserStatus, isConfigured } from 'server/services/keycloakAdmin';
import { processApiTokenOwnerSweep, warnIfApiTokenOwnerSweepUnconfigured } from '../apiTokenOwnerSweep';

const mockIsConfigured = isConfigured as jest.Mock;
const mockGetUserStatus = getUserStatus as jest.Mock;
const mockRevoke = ApiTokenService.revokeByOwnerIdentifier as jest.Mock;
const mockRecordAudit = recordAuthAuditEvent as jest.Mock;

beforeEach(() => {
  mockOwnerRows = [];
  mockIsConfigured.mockReturnValue(true);
  mockRevoke.mockResolvedValue({ count: 1 });
  mockRecordAudit.mockResolvedValue(undefined);
});

describe('processApiTokenOwnerSweep', () => {
  it('revokes keys of a disabled owner with reason owner_disabled and records an audit event', async () => {
    mockOwnerRows = [{ ownerUserId: 'sub-disabled' }];
    mockGetUserStatus.mockResolvedValue('disabled');
    mockRevoke.mockResolvedValue({ count: 2 });

    await processApiTokenOwnerSweep();

    expect(mockRevoke).toHaveBeenCalledWith('ownerUserId', 'sub-disabled', 'system:owner-sweep', 'owner_disabled');
    expect(mockRecordAudit).toHaveBeenCalledWith({
      event: 'api_token.owner_disabled_revoke',
      principalKind: 'user',
      principalId: 'sub-disabled',
      actorId: 'system:owner-sweep',
      outcome: 'revoked',
      meta: { count: 2 },
    });
  });

  it('revokes keys of a deleted owner the same way', async () => {
    mockOwnerRows = [{ ownerUserId: 'sub-deleted' }];
    mockGetUserStatus.mockResolvedValue('deleted');

    await processApiTokenOwnerSweep();

    expect(mockRevoke).toHaveBeenCalledWith('ownerUserId', 'sub-deleted', 'system:owner-sweep', 'owner_disabled');
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'api_token.owner_disabled_revoke', principalId: 'sub-deleted' })
    );
  });

  it('revokes keys of a role-stripped owner with reason owner_lost_role', async () => {
    mockOwnerRows = [{ ownerUserId: 'sub-norole' }];
    mockGetUserStatus.mockResolvedValue('no_base_role');
    mockRevoke.mockResolvedValue({ count: 3 });

    await processApiTokenOwnerSweep();

    expect(mockRevoke).toHaveBeenCalledWith('ownerUserId', 'sub-norole', 'system:owner-sweep', 'owner_lost_role');
    expect(mockRecordAudit).toHaveBeenCalledWith({
      event: 'api_token.owner_lost_role_revoke',
      principalKind: 'user',
      principalId: 'sub-norole',
      actorId: 'system:owner-sweep',
      outcome: 'revoked',
      meta: { count: 3 },
    });
  });

  it('never revokes when the lookup is inconclusive', async () => {
    mockOwnerRows = [{ ownerUserId: 'sub-unknown' }];
    mockGetUserStatus.mockResolvedValue('unknown');

    await processApiTokenOwnerSweep();

    expect(mockRevoke).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('inconclusive'));
  });

  it('leaves active owners untouched', async () => {
    mockOwnerRows = [{ ownerUserId: 'sub-active' }];
    mockGetUserStatus.mockResolvedValue('active');

    await processApiTokenOwnerSweep();

    expect(mockRevoke).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('skips with a warning and makes no Keycloak calls when unconfigured', async () => {
    mockIsConfigured.mockReturnValue(false);

    await processApiTokenOwnerSweep();

    expect(mockWarn).toHaveBeenCalledWith('API key owner sweep skipped: Keycloak principal-sync client not configured');
    expect(mockGetUserStatus).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('continues sweeping remaining owners when one revoke fails', async () => {
    mockOwnerRows = [{ ownerUserId: 'sub-a' }, { ownerUserId: 'sub-b' }];
    mockGetUserStatus.mockResolvedValue('disabled');
    mockRevoke.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce({ count: 1 });

    await processApiTokenOwnerSweep();

    expect(mockRevoke).toHaveBeenCalledTimes(2);
    expect(mockError).toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
  });
});

describe('warnIfApiTokenOwnerSweepUnconfigured', () => {
  it('warns once at boot when unconfigured', () => {
    mockIsConfigured.mockReturnValue(false);
    warnIfApiTokenOwnerSweepUnconfigured();
    expect(mockWarn).toHaveBeenCalledWith('API key owner sweep skipped: Keycloak principal-sync client not configured');
  });

  it('stays silent when configured', () => {
    mockIsConfigured.mockReturnValue(true);
    warnIfApiTokenOwnerSweepUnconfigured();
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
