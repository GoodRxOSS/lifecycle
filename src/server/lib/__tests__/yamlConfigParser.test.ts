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

const mockGetYamlFileContentFromPullRequest = jest.fn();
const mockGetYamlFileContentFromBranch = jest.fn();

jest.mock('server/lib/github', () => ({
  getYamlFileContentFromPullRequest: (...args: unknown[]) => mockGetYamlFileContentFromPullRequest(...args),
  getYamlFileContentFromBranch: (...args: unknown[]) => mockGetYamlFileContentFromBranch(...args),
}));

import { ParsingError, YamlConfigParser } from '../yamlConfigParser';

const lifecycleYaml = `
version: '1.0.0'
services:
  - name: api
`;

const lifecycleConfig = {
  version: '1.0.0',
  services: [{ name: 'api' }],
};

describe('YamlConfigParser', () => {
  let parser: YamlConfigParser;

  beforeEach(() => {
    jest.clearAllMocks();
    parser = new YamlConfigParser();
  });

  describe('raw GitHub content', () => {
    it('returns pull-request content from the requested repository and number', async () => {
      mockGetYamlFileContentFromPullRequest.mockResolvedValue(lifecycleYaml);

      await expect(parser.getRawYamlConfigFromPullRequest('goodrx/lifecycle', 42)).resolves.toBe(lifecycleYaml);

      expect(mockGetYamlFileContentFromPullRequest).toHaveBeenCalledWith('goodrx/lifecycle', 42);
      expect(mockGetYamlFileContentFromBranch).not.toHaveBeenCalled();
    });

    it('returns branch content from the requested repository and branch', async () => {
      mockGetYamlFileContentFromBranch.mockResolvedValue(lifecycleYaml);

      await expect(parser.getRawYamlConfigFromBranch('goodrx/lifecycle', 'release/1.0')).resolves.toBe(lifecycleYaml);

      expect(mockGetYamlFileContentFromBranch).toHaveBeenCalledWith('goodrx/lifecycle', 'release/1.0');
      expect(mockGetYamlFileContentFromPullRequest).not.toHaveBeenCalled();
    });

    it('preserves a pull-request fetch failure', async () => {
      const failure = new Error('GitHub unavailable');
      mockGetYamlFileContentFromPullRequest.mockRejectedValue(failure);

      await expect(parser.getRawYamlConfigFromPullRequest('goodrx/lifecycle', 42)).rejects.toBe(failure);

      expect(mockGetYamlFileContentFromBranch).not.toHaveBeenCalled();
    });

    it('preserves a branch fetch failure', async () => {
      const failure = new Error('branch missing');
      mockGetYamlFileContentFromBranch.mockRejectedValue(failure);

      await expect(parser.getRawYamlConfigFromBranch('goodrx/lifecycle', 'missing')).rejects.toBe(failure);

      expect(mockGetYamlFileContentFromPullRequest).not.toHaveBeenCalled();
    });
  });

  describe('fetching and parsing', () => {
    it('parses YAML fetched from a pull request', async () => {
      mockGetYamlFileContentFromPullRequest.mockResolvedValue(lifecycleYaml);

      await expect(parser.parseYamlConfigFromPullRequest('goodrx/lifecycle', 42)).resolves.toEqual(lifecycleConfig);

      expect(mockGetYamlFileContentFromPullRequest).toHaveBeenCalledWith('goodrx/lifecycle', 42);
      expect(mockGetYamlFileContentFromBranch).not.toHaveBeenCalled();
    });

    it('parses YAML fetched from a branch', async () => {
      mockGetYamlFileContentFromBranch.mockResolvedValue(lifecycleYaml);

      await expect(parser.parseYamlConfigFromBranch('goodrx/lifecycle', 'main')).resolves.toEqual(lifecycleConfig);

      expect(mockGetYamlFileContentFromBranch).toHaveBeenCalledWith('goodrx/lifecycle', 'main');
      expect(mockGetYamlFileContentFromPullRequest).not.toHaveBeenCalled();
    });

    it('does not parse when the pull-request fetch fails', async () => {
      const failure = new Error('GitHub unavailable');
      const parse = jest.spyOn(parser, 'parseYamlConfigFromString');
      mockGetYamlFileContentFromPullRequest.mockRejectedValue(failure);

      await expect(parser.parseYamlConfigFromPullRequest('goodrx/lifecycle', 42)).rejects.toBe(failure);

      expect(parse).not.toHaveBeenCalled();
      expect(mockGetYamlFileContentFromBranch).not.toHaveBeenCalled();
    });

    it('does not parse when the branch fetch fails', async () => {
      const failure = new Error('branch missing');
      const parse = jest.spyOn(parser, 'parseYamlConfigFromString');
      mockGetYamlFileContentFromBranch.mockRejectedValue(failure);

      await expect(parser.parseYamlConfigFromBranch('goodrx/lifecycle', 'missing')).rejects.toBe(failure);

      expect(parse).not.toHaveBeenCalled();
      expect(mockGetYamlFileContentFromPullRequest).not.toHaveBeenCalled();
    });
  });

  describe('string parsing', () => {
    it('wraps malformed YAML in a parser-specific error', () => {
      expect(() => parser.parseYamlConfigFromString('services: [unterminated')).toThrow(ParsingError);

      expect(mockGetYamlFileContentFromPullRequest).not.toHaveBeenCalled();
      expect(mockGetYamlFileContentFromBranch).not.toHaveBeenCalled();
    });

    it('returns no configuration for a blank, but present, YAML string', () => {
      expect(parser.parseYamlConfigFromString('')).toBeUndefined();

      expect(mockGetYamlFileContentFromPullRequest).not.toHaveBeenCalled();
      expect(mockGetYamlFileContentFromBranch).not.toHaveBeenCalled();
    });
  });
});
