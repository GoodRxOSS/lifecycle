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

import Model from './_Model';

export type ApiTokenScope =
  | 'env:read'
  | 'env:write'
  | 'env:admin'
  | 'sites:read'
  | 'sites:write'
  | 'repos:read'
  | 'repos:write';

export default class ApiToken extends Model {
  name!: string;
  tokenHash!: string;
  tokenPrefix!: string;
  kind!: 'personal' | 'service';
  scopes!: ApiTokenScope[];
  repositoryAllowlist!: string[] | null;
  createdBy!: string;
  lastUsedAt!: string | null;
  expiresAt!: string | null;
  revokedAt!: string | null;

  /* Identity binding for user-provisioned tokens; all null for admin-minted org tokens. */
  ownerUserId!: string | null;
  ownerGithubUsername!: string | null;
  ownerEmail!: string | null;
  ownerPreferredUsername!: string | null;
  ownerDisplayName!: string | null;
  ownerRoleAtIssue!: string | null;
  /* Allowlist bound to repo identity (githubRepositoryId), not the mutable fullName. */
  repositoryAllowlistRepoIds!: number[] | null;
  revokedBy!: string | null;
  revokeReason!: string | null;

  static tableName = 'api_tokens';
  static timestamps = true;
  static hidden = ['tokenHash'];

  static get jsonAttributes() {
    return ['scopes', 'repositoryAllowlist', 'repositoryAllowlistRepoIds'];
  }

  static jsonSchema = {
    type: 'object',
    required: ['name', 'tokenHash', 'tokenPrefix', 'kind', 'scopes', 'createdBy'],
    properties: {
      id: { type: 'integer' },
      name: { type: 'string', minLength: 1, maxLength: 255 },
      tokenHash: { type: 'string', minLength: 64, maxLength: 64 },
      tokenPrefix: { type: 'string', minLength: 1, maxLength: 16 },
      kind: { type: 'string', enum: ['personal', 'service'] },
      scopes: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['env:read', 'env:write', 'env:admin', 'sites:read', 'sites:write', 'repos:read', 'repos:write'],
        },
      },
      repositoryAllowlist: { type: ['array', 'null'], items: { type: 'string' } },
      createdBy: { type: 'string' },
      lastUsedAt: { type: ['string', 'null'] },
      expiresAt: { type: ['string', 'null'] },
      revokedAt: { type: ['string', 'null'] },
      ownerUserId: { type: ['string', 'null'] },
      ownerGithubUsername: { type: ['string', 'null'] },
      ownerEmail: { type: ['string', 'null'] },
      ownerPreferredUsername: { type: ['string', 'null'] },
      ownerDisplayName: { type: ['string', 'null'] },
      ownerRoleAtIssue: { type: ['string', 'null'] },
      repositoryAllowlistRepoIds: { type: ['array', 'null'], items: { type: 'integer' } },
      revokedBy: { type: ['string', 'null'] },
      revokeReason: { type: ['string', 'null'], maxLength: 32 },
    },
  };
}
