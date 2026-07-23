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

import ApiTokenService from 'server/services/apiToken';
import type ApiToken from 'server/models/ApiToken';

/** Admin oversight serializer: kind/status plus owner attribution; never the hash or plaintext. */
export const serializeAdminToken = (record: ApiToken) => ({
  id: record.id,
  name: record.name,
  tokenPrefix: record.tokenPrefix,
  kind: ApiTokenService.tokenKind(record),
  status: ApiTokenService.tokenStatus(record),
  scopes: record.scopes,
  repositoryAllowlist: record.repositoryAllowlist,
  repositoryAllowlistRepoIds: record.repositoryAllowlistRepoIds,
  ownerUserId: record.ownerUserId,
  ownerEmail: record.ownerEmail,
  ownerPreferredUsername: record.ownerPreferredUsername,
  ownerGithubUsername: record.ownerGithubUsername,
  ownerRoleAtIssue: record.ownerRoleAtIssue,
  createdBy: record.createdBy,
  revokedBy: record.revokedBy,
  lastUsedAt: record.lastUsedAt,
  expiresAt: record.expiresAt,
  revokedAt: record.revokedAt,
  createdAt: record.createdAt,
});
