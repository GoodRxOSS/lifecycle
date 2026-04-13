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

import 'server/lib/dependencies';
import UserApiKey from 'server/models/UserApiKey';
import { encrypt, decrypt, maskApiKey } from 'server/lib/encryption';
import { normalizeStoredAgentProviderName } from 'server/services/agent/providerConfig';

export default class UserApiKeyService {
  private static normalizeProvider(provider: string): string {
    const normalized = normalizeStoredAgentProviderName(provider);
    return normalized ?? provider.trim().toLowerCase();
  }

  private static getOwnerKey(userId: string, ownerGithubUsername?: string | null): string {
    const normalizedOwner = ownerGithubUsername?.trim();
    return normalizedOwner || userId;
  }

  private static async reconcileRecordOwnership(
    record: UserApiKey,
    userId: string,
    ownerGithubUsername: string
  ): Promise<UserApiKey> {
    if (record.userId === userId && record.ownerGithubUsername === ownerGithubUsername) {
      return record;
    }

    await UserApiKey.query().where({ id: record.id }).patch({ userId, ownerGithubUsername });

    record.userId = userId;
    record.ownerGithubUsername = ownerGithubUsername;
    return record;
  }

  private static async findRecord(userId: string, provider: string, ownerGithubUsername?: string | null) {
    const normalizedProvider = this.normalizeProvider(provider);
    const canonicalOwner = this.getOwnerKey(userId, ownerGithubUsername);

    const ownerMatch = await UserApiKey.query()
      .where({ ownerGithubUsername: canonicalOwner, provider: normalizedProvider })
      .first();
    if (ownerMatch) {
      return this.reconcileRecordOwnership(ownerMatch, userId, canonicalOwner);
    }

    if (canonicalOwner === userId) {
      return null;
    }

    const fallbackMatch = await UserApiKey.query().where({ userId, provider: normalizedProvider }).first();
    if (!fallbackMatch) {
      return null;
    }

    return this.reconcileRecordOwnership(fallbackMatch, userId, canonicalOwner);
  }

  static async storeKey(
    userId: string,
    provider: string,
    apiKey: string,
    ownerGithubUsername?: string | null
  ): Promise<void> {
    const encryptedKey = encrypt(apiKey);
    const normalizedProvider = this.normalizeProvider(provider);
    const canonicalOwner = this.getOwnerKey(userId, ownerGithubUsername);
    const existing = await this.findRecord(userId, provider, ownerGithubUsername);
    if (existing) {
      await UserApiKey.query()
        .where({ id: existing.id })
        .patch({ userId, encryptedKey, ownerGithubUsername: canonicalOwner });
    } else {
      await UserApiKey.query().insertAndFetch({
        userId,
        ownerGithubUsername: canonicalOwner,
        provider: normalizedProvider,
        encryptedKey,
      });
    }
  }

  static async getMaskedKey(userId: string, provider: string, ownerGithubUsername?: string | null) {
    const record = await this.findRecord(userId, provider, ownerGithubUsername);
    if (!record) return null;
    const decrypted = decrypt(record.encryptedKey);
    return {
      provider: record.provider,
      maskedKey: maskApiKey(decrypted),
      updatedAt: record.updatedAt,
    };
  }

  static async getDecryptedKey(
    userId: string,
    provider: string,
    ownerGithubUsername?: string | null
  ): Promise<string | null> {
    const record = await this.findRecord(userId, provider, ownerGithubUsername);
    if (!record) return null;
    return decrypt(record.encryptedKey);
  }

  static async deleteKey(userId: string, provider: string, ownerGithubUsername?: string | null): Promise<boolean> {
    const record = await this.findRecord(userId, provider, ownerGithubUsername);
    if (!record) {
      return false;
    }

    const count = await UserApiKey.query().where({ id: record.id }).delete();
    return count > 0;
  }
}
