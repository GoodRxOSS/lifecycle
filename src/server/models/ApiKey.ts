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

import Model from './_Model';

export default class ApiKey extends Model {
  static tableName = 'api_keys';

  id!: number;
  keyId!: string;
  secretHash!: string;
  name!: string;
  description?: string;
  active!: boolean;
  scopes!: string[];
  githubUserId?: number;
  githubLogin?: string;
  createdAt!: string;
  updatedAt!: string;
  expiresAt?: string;
  lastUsedAt?: string;

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['keyId', 'secretHash', 'name'],
      properties: {
        id: { type: 'integer' },
        keyId: { type: 'string', minLength: 8, maxLength: 8 },
        secretHash: { type: 'string', maxLength: 255 },
        name: { type: 'string', maxLength: 255 },
        description: { type: 'string' },
        active: { type: 'boolean' },
        scopes: { type: 'array', items: { type: 'string' } },
        githubUserId: { type: ['integer', 'null'] },
        githubLogin: { type: ['string', 'null'], maxLength: 255 },
        createdAt: { type: 'string' },
        updatedAt: { type: 'string' },
        expiresAt: { type: ['string', 'null'] },
        lastUsedAt: { type: ['string', 'null'] },
      },
    };
  }

  static columnNameMappers = {
    parse(obj: any) {
      return {
        ...obj,
        keyId: obj.key_id,
        secretHash: obj.secret_hash,
        githubUserId: obj.github_user_id,
        githubLogin: obj.github_login,
        createdAt: obj.created_at,
        updatedAt: obj.updated_at,
        expiresAt: obj.expires_at,
        lastUsedAt: obj.last_used_at,
      };
    },
    format(obj: any) {
      const formatted: any = { ...obj };
      if ('keyId' in formatted) {
        formatted.key_id = formatted.keyId;
        delete formatted.keyId;
      }
      if ('secretHash' in formatted) {
        formatted.secret_hash = formatted.secretHash;
        delete formatted.secretHash;
      }
      if ('githubUserId' in formatted) {
        formatted.github_user_id = formatted.githubUserId;
        delete formatted.githubUserId;
      }
      if ('githubLogin' in formatted) {
        formatted.github_login = formatted.githubLogin;
        delete formatted.githubLogin;
      }
      if ('createdAt' in formatted) {
        formatted.created_at = formatted.createdAt;
        delete formatted.createdAt;
      }
      if ('updatedAt' in formatted) {
        formatted.updated_at = formatted.updatedAt;
        delete formatted.updatedAt;
      }
      if ('expiresAt' in formatted) {
        formatted.expires_at = formatted.expiresAt;
        delete formatted.expiresAt;
      }
      if ('lastUsedAt' in formatted) {
        formatted.last_used_at = formatted.lastUsedAt;
        delete formatted.lastUsedAt;
      }
      return formatted;
    },
  };
}
