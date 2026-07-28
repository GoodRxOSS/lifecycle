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

jest.mock('server/lib/logger', () => ({
  getLogger: () => ({ warn: jest.fn() }),
}));

import { KeycloakAdminClient, KeycloakAdminError } from './adminClient';
import { KeycloakPrincipalStatus } from './principalStatus';

function service(get: jest.Mock): KeycloakPrincipalStatus {
  return new KeycloakPrincipalStatus({ get } as unknown as KeycloakAdminClient);
}

it('reports disabled and deleted users without role traversal', async () => {
  const disabledGet = jest.fn(async () => ({ enabled: false }));
  await expect(service(disabledGet).getUserStatus('user-1')).resolves.toBe('disabled');
  expect(disabledGet).toHaveBeenCalledTimes(1);

  const deletedGet = jest.fn(async () => {
    throw new KeycloakAdminError('not_found', 404, 'not found');
  });
  await expect(service(deletedGet).getUserStatus('user-2')).resolves.toBe('deleted');
});

it('accepts a base role assigned directly or through a top-level group', async () => {
  const direct = jest.fn(async (path: string) => {
    if (path.endsWith('/users/user-1')) return { enabled: true };
    if (path.includes('/role-mappings/realm/composite')) return [{ name: 'user' }];
    throw new Error(`unexpected ${path}`);
  });
  await expect(service(direct).getUserStatus('user-1')).resolves.toBe('active');

  const group = jest.fn(async (path: string) => {
    if (path.endsWith('/users/user-2')) return { enabled: true };
    if (path.includes('/users/user-2/role-mappings')) return [];
    if (path.includes('/users/user-2/groups')) return [{ id: 'group-1', path: '/developers' }];
    if (path.includes('/groups/group-1/role-mappings')) return [{ name: 'admin' }];
    throw new Error(`unexpected ${path}`);
  });
  await expect(service(group).getUserStatus('user-2')).resolves.toBe('active');
});

it('distinguishes a definite missing base role from an inconclusive hierarchy', async () => {
  const noRole = jest.fn(async (path: string) => {
    if (path.endsWith('/users/user-1')) return { enabled: true };
    if (path.includes('/role-mappings/realm/composite')) return [];
    if (path.includes('/groups')) return [];
    throw new Error(`unexpected ${path}`);
  });
  await expect(service(noRole).getUserStatus('user-1')).resolves.toBe('no_base_role');

  const nestedGroup = jest.fn(async (path: string) => {
    if (path.endsWith('/users/user-2')) return { enabled: true };
    if (path.includes('/users/user-2/role-mappings')) return [];
    if (path.includes('/users/user-2/groups')) return [{ id: 'group-2', path: '/parent/child' }];
    if (path.includes('/groups/group-2/role-mappings')) return [];
    throw new Error(`unexpected ${path}`);
  });
  await expect(service(nestedGroup).getUserStatus('user-2')).resolves.toBe('unknown');
});

it('fails safely to unknown on provider errors', async () => {
  const get = jest.fn(async () => {
    throw new KeycloakAdminError('unavailable', 503, 'unavailable');
  });
  await expect(service(get).getUserStatus('user-1')).resolves.toBe('unknown');
});
