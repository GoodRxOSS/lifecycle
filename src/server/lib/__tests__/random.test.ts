/**
 * Copyright 2026 Lifecycle contributors
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

const mockSampleSize = jest.fn();
const mockRandomBytes = jest.fn();

jest.mock('lodash', () => ({
  sampleSize: (...args: unknown[]) => mockSampleSize(...args),
}));

jest.mock('crypto', () => ({
  __esModule: true,
  default: {
    randomBytes: (...args: unknown[]) => mockRandomBytes(...args),
  },
}));

import { randomAlphanumeric, randomHexString, randomLetters, randomNumeric, randomSample } from '../random';

describe('random helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSampleSize.mockReturnValue(['b', 'a']);
  });

  it('joins the characters selected by lodash and supports the empty defaults', () => {
    expect(randomSample('abc', 2)).toBe('ba');
    expect(mockSampleSize).toHaveBeenCalledWith('abc', 2);

    mockSampleSize.mockReturnValueOnce([]);
    expect(randomSample()).toBe('');
    expect(mockSampleSize).toHaveBeenLastCalledWith('', 0);
  });

  it.each([
    ['numeric', randomNumeric, '0123456789', 4],
    ['letters', randomLetters, 'abcdefghijklmnopqrstuvwxyz', 6],
    ['alphanumeric', randomAlphanumeric, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 6],
  ] as const)('samples the documented %s alphabet with its default length', (_label, generate, alphabet, length) => {
    expect(generate()).toBe('ba');
    expect(mockSampleSize).toHaveBeenCalledWith(alphabet, length);

    generate(2);
    expect(mockSampleSize).toHaveBeenLastCalledWith(alphabet, 2);
  });

  it('hex-encodes the requested number of random bytes', () => {
    const toString = jest.fn().mockReturnValue('aabbcc');
    mockRandomBytes.mockReturnValue({ toString });

    expect(randomHexString()).toBe('aabbcc');
    expect(mockRandomBytes).toHaveBeenCalledWith(64);
    expect(toString).toHaveBeenCalledWith('hex');

    randomHexString(3);
    expect(mockRandomBytes).toHaveBeenLastCalledWith(3);
  });
});
