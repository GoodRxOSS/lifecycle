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

jest.mock('server/models/UserApiKey');
jest.mock('server/lib/encryption');
jest.mock('server/lib/dependencies', () => ({}));

import UserApiKeyService from 'server/services/userApiKey';
import UserApiKey from 'server/models/UserApiKey';
import { encrypt, decrypt, maskApiKey } from 'server/lib/encryption';

const mockEncrypt = encrypt as jest.MockedFunction<typeof encrypt>;
const mockDecrypt = decrypt as jest.MockedFunction<typeof decrypt>;
const mockMaskApiKey = maskApiKey as jest.MockedFunction<typeof maskApiKey>;

const mockQuery = {
  where: jest.fn().mockReturnThis(),
  first: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn(),
};

(UserApiKey.query as jest.Mock) = jest.fn().mockReturnValue(mockQuery);
(UserApiKey as any).query.insertAndFetch = undefined;

describe('UserApiKeyService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (UserApiKey.query as jest.Mock) = jest.fn().mockReturnValue(mockQuery);
    mockQuery.where.mockReturnThis();
    mockQuery.first.mockReset();
    mockQuery.patch.mockReset();
    mockQuery.delete.mockReset();
  });

  describe('storeKey', () => {
    test('stores a new key under the canonical owner key', async () => {
      mockEncrypt.mockReturnValue('encrypted-value');
      mockQuery.first.mockResolvedValue(null);

      const insertAndFetchMock = jest.fn().mockResolvedValue({
        id: 1,
        userId: 'user-1',
        ownerGithubUsername: 'user-1',
        provider: 'anthropic',
        encryptedKey: 'encrypted-value',
      });
      (UserApiKey.query as jest.Mock)
        .mockReturnValueOnce(mockQuery)
        .mockReturnValueOnce({ insertAndFetch: insertAndFetchMock });

      await UserApiKeyService.storeKey('user-1', 'anthropic', 'sk-ant-api03-abc');

      expect(mockEncrypt).toHaveBeenCalledWith('sk-ant-api03-abc');
      expect(mockQuery.where).toHaveBeenCalledWith({
        ownerGithubUsername: 'user-1',
        provider: 'anthropic',
      });
      expect(insertAndFetchMock).toHaveBeenCalledWith({
        userId: 'user-1',
        ownerGithubUsername: 'user-1',
        provider: 'anthropic',
        encryptedKey: 'encrypted-value',
      });
    });

    test('updates an existing owner-matched key', async () => {
      mockEncrypt.mockReturnValue('encrypted-value-updated');
      mockQuery.first.mockResolvedValue({
        id: 1,
        userId: 'user-1',
        ownerGithubUsername: 'sample-user',
        provider: 'anthropic',
        encryptedKey: 'old-encrypted-value',
      });

      const patchMock = jest.fn().mockResolvedValue(1);
      const whereForPatch = jest.fn().mockReturnValue({ patch: patchMock });
      (UserApiKey.query as jest.Mock).mockReturnValueOnce(mockQuery).mockReturnValueOnce({ where: whereForPatch });

      await UserApiKeyService.storeKey('user-1', 'anthropic', 'sk-ant-api03-xyz', 'sample-user');

      expect(mockEncrypt).toHaveBeenCalledWith('sk-ant-api03-xyz');
      expect(whereForPatch).toHaveBeenCalledWith({ id: 1 });
      expect(patchMock).toHaveBeenCalledWith({
        userId: 'user-1',
        encryptedKey: 'encrypted-value-updated',
        ownerGithubUsername: 'sample-user',
      });
    });

    test('falls back to userId and rebinds the row to the current github username', async () => {
      mockEncrypt.mockReturnValue('encrypted-value-updated');
      mockQuery.first.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: 9,
        userId: 'user-1',
        ownerGithubUsername: 'old-handle',
        provider: 'anthropic',
        encryptedKey: 'old-encrypted-value',
      });

      const patchMock = jest.fn().mockResolvedValue(1);
      const whereForPatch = jest.fn().mockReturnValue({ patch: patchMock });
      (UserApiKey.query as jest.Mock)
        .mockReturnValueOnce(mockQuery)
        .mockReturnValueOnce(mockQuery)
        .mockReturnValueOnce({ where: whereForPatch })
        .mockReturnValueOnce({ where: whereForPatch });

      await UserApiKeyService.storeKey('user-1', 'anthropic', 'sk-ant-api03-xyz', 'sample-user');

      expect(mockQuery.where).toHaveBeenNthCalledWith(1, {
        ownerGithubUsername: 'sample-user',
        provider: 'anthropic',
      });
      expect(mockQuery.where).toHaveBeenNthCalledWith(2, {
        userId: 'user-1',
        provider: 'anthropic',
      });
      expect(whereForPatch).toHaveBeenNthCalledWith(1, { id: 9 });
      expect(patchMock).toHaveBeenNthCalledWith(1, {
        userId: 'user-1',
        ownerGithubUsername: 'sample-user',
      });
      expect(whereForPatch).toHaveBeenNthCalledWith(2, { id: 9 });
      expect(patchMock).toHaveBeenNthCalledWith(2, {
        userId: 'user-1',
        encryptedKey: 'encrypted-value-updated',
        ownerGithubUsername: 'sample-user',
      });
    });

    test('stores google alias keys under the gemini provider id', async () => {
      mockEncrypt.mockReturnValue('encrypted-google-value');
      mockQuery.first.mockResolvedValue(null);

      const insertAndFetchMock = jest.fn().mockResolvedValue({
        id: 10,
        userId: 'user-1',
        ownerGithubUsername: 'user-1',
        provider: 'gemini',
        encryptedKey: 'encrypted-google-value',
      });
      (UserApiKey.query as jest.Mock)
        .mockReturnValueOnce(mockQuery)
        .mockReturnValueOnce({ insertAndFetch: insertAndFetchMock });

      await UserApiKeyService.storeKey('user-1', 'google', 'sample-google-key');

      expect(mockQuery.where).toHaveBeenCalledWith({
        ownerGithubUsername: 'user-1',
        provider: 'gemini',
      });
      expect(insertAndFetchMock).toHaveBeenCalledWith({
        userId: 'user-1',
        ownerGithubUsername: 'user-1',
        provider: 'gemini',
        encryptedKey: 'encrypted-google-value',
      });
    });
  });

  describe('getMaskedKey', () => {
    test('returns masked key info when an owner-matched record exists', async () => {
      mockQuery.first.mockResolvedValue({
        id: 1,
        userId: 'user-1',
        ownerGithubUsername: 'user-1',
        provider: 'anthropic',
        encryptedKey: 'encrypted-value',
        updatedAt: '2025-01-01T00:00:00Z',
      });
      mockDecrypt.mockReturnValue('sk-ant-api03-abcdefghijklmnop');
      mockMaskApiKey.mockReturnValue('sk-ant...mnop');

      const result = await UserApiKeyService.getMaskedKey('user-1', 'anthropic');

      expect(result).toEqual({
        provider: 'anthropic',
        maskedKey: 'sk-ant...mnop',
        updatedAt: '2025-01-01T00:00:00Z',
      });
      expect(mockDecrypt).toHaveBeenCalledWith('encrypted-value');
      expect(mockMaskApiKey).toHaveBeenCalledWith('sk-ant-api03-abcdefghijklmnop');
    });

    test('returns null when no key exists', async () => {
      mockQuery.first.mockResolvedValue(null);

      const result = await UserApiKeyService.getMaskedKey('user-1', 'anthropic');

      expect(result).toBeNull();
      expect(mockDecrypt).not.toHaveBeenCalled();
    });

    test('reconciles userId when ownerGithubUsername matches', async () => {
      mockQuery.first.mockResolvedValue({
        id: 2,
        userId: 'old-user',
        ownerGithubUsername: 'sample-user',
        provider: 'anthropic',
        encryptedKey: 'encrypted-value',
        updatedAt: '2025-01-01T00:00:00Z',
      });
      mockDecrypt.mockReturnValue('sk-ant-api03-abcdefghijklmnop');
      mockMaskApiKey.mockReturnValue('sk-ant...mnop');

      const patchMock = jest.fn().mockResolvedValue(1);
      const whereForPatch = jest.fn().mockReturnValue({ patch: patchMock });
      (UserApiKey.query as jest.Mock).mockReturnValueOnce(mockQuery).mockReturnValueOnce({ where: whereForPatch });

      const result = await UserApiKeyService.getMaskedKey('user-1', 'anthropic', 'sample-user');

      expect(result).toEqual({
        provider: 'anthropic',
        maskedKey: 'sk-ant...mnop',
        updatedAt: '2025-01-01T00:00:00Z',
      });
      expect(whereForPatch).toHaveBeenCalledWith({ id: 2 });
      expect(patchMock).toHaveBeenCalledWith({
        userId: 'user-1',
        ownerGithubUsername: 'sample-user',
      });
    });
  });

  describe('getDecryptedKey', () => {
    test('returns decrypted key when an owner-matched record exists', async () => {
      mockQuery.first.mockResolvedValue({
        id: 1,
        userId: 'user-1',
        ownerGithubUsername: 'user-1',
        provider: 'anthropic',
        encryptedKey: 'encrypted-value',
      });
      mockDecrypt.mockReturnValue('sk-ant-api03-abcdefghijklmnop');

      const result = await UserApiKeyService.getDecryptedKey('user-1', 'anthropic');

      expect(result).toBe('sk-ant-api03-abcdefghijklmnop');
      expect(mockDecrypt).toHaveBeenCalledWith('encrypted-value');
    });

    test('returns null when no key exists', async () => {
      mockQuery.first.mockResolvedValue(null);

      const result = await UserApiKeyService.getDecryptedKey('user-1', 'anthropic');

      expect(result).toBeNull();
    });

    test('reconciles userId during owner-based decryption', async () => {
      mockQuery.first.mockResolvedValue({
        id: 3,
        userId: 'old-user',
        ownerGithubUsername: 'sample-user',
        provider: 'anthropic',
        encryptedKey: 'encrypted-value',
      });
      mockDecrypt.mockReturnValue('sk-ant-api03-abcdefghijklmnop');

      const patchMock = jest.fn().mockResolvedValue(1);
      const whereForPatch = jest.fn().mockReturnValue({ patch: patchMock });
      (UserApiKey.query as jest.Mock).mockReturnValueOnce(mockQuery).mockReturnValueOnce({ where: whereForPatch });

      const result = await UserApiKeyService.getDecryptedKey('user-1', 'anthropic', 'sample-user');

      expect(result).toBe('sk-ant-api03-abcdefghijklmnop');
      expect(whereForPatch).toHaveBeenCalledWith({ id: 3 });
      expect(patchMock).toHaveBeenCalledWith({
        userId: 'user-1',
        ownerGithubUsername: 'sample-user',
      });
    });

    test('resolves google alias lookups through gemini storage', async () => {
      mockQuery.first.mockResolvedValue({
        id: 6,
        userId: 'user-1',
        ownerGithubUsername: 'user-1',
        provider: 'gemini',
        encryptedKey: 'encrypted-google-value',
      });
      mockDecrypt.mockReturnValue('sample-google-key');

      const result = await UserApiKeyService.getDecryptedKey('user-1', 'google');

      expect(result).toBe('sample-google-key');
      expect(mockQuery.where).toHaveBeenCalledWith({
        ownerGithubUsername: 'user-1',
        provider: 'gemini',
      });
    });
  });

  describe('deleteKey', () => {
    test('returns true when key exists and is deleted', async () => {
      mockQuery.first.mockResolvedValue({
        id: 1,
        userId: 'user-1',
        ownerGithubUsername: 'user-1',
        provider: 'anthropic',
        encryptedKey: 'encrypted-value',
      });
      const deleteMock = jest.fn().mockResolvedValue(1);
      const whereForDelete = jest.fn().mockReturnValue({ delete: deleteMock });
      (UserApiKey.query as jest.Mock).mockReturnValueOnce(mockQuery).mockReturnValueOnce({ where: whereForDelete });

      const result = await UserApiKeyService.deleteKey('user-1', 'anthropic');

      expect(result).toBe(true);
      expect(whereForDelete).toHaveBeenCalledWith({ id: 1 });
    });

    test('returns false when no key exists', async () => {
      mockQuery.first.mockResolvedValue(null);

      const result = await UserApiKeyService.deleteKey('user-1', 'anthropic');

      expect(result).toBe(false);
    });

    test('reconciles userId before deleting an owner-matched key', async () => {
      mockQuery.first.mockResolvedValue({
        id: 5,
        userId: 'old-user',
        ownerGithubUsername: 'sample-user',
        provider: 'anthropic',
        encryptedKey: 'encrypted-value',
      });
      const patchMock = jest.fn().mockResolvedValue(1);
      const whereForPatch = jest.fn().mockReturnValue({ patch: patchMock });
      const deleteMock = jest.fn().mockResolvedValue(1);
      const whereForDelete = jest.fn().mockReturnValue({ delete: deleteMock });
      (UserApiKey.query as jest.Mock)
        .mockReturnValueOnce(mockQuery)
        .mockReturnValueOnce({ where: whereForPatch })
        .mockReturnValueOnce({ where: whereForDelete });

      const result = await UserApiKeyService.deleteKey('user-1', 'anthropic', 'sample-user');

      expect(result).toBe(true);
      expect(whereForPatch).toHaveBeenCalledWith({ id: 5 });
      expect(patchMock).toHaveBeenCalledWith({
        userId: 'user-1',
        ownerGithubUsername: 'sample-user',
      });
      expect(whereForDelete).toHaveBeenCalledWith({ id: 5 });
    });
  });
});
