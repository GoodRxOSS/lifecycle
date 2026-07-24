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

import { buildUpdateFilePreview, shouldRequestUpdateFileApproval } from '../diagnosticTools';
import type { GitHubClient } from '../tools/shared/githubClient';

function buildGithubClient(currentContent: string | null): GitHubClient {
  const octokit = {
    request: jest.fn(async () => {
      if (currentContent === null) {
        throw new Error('not found');
      }

      return {
        data: {
          content: Buffer.from(currentContent).toString('base64'),
        },
      };
    }),
  };
  return {
    isFilePathAllowed: jest.fn(() => true),
    validateBranch: jest.fn(() => ({ valid: true })),
    getOctokit: jest.fn(async () => octokit),
    getOctokitWithAuth: jest.fn(async () => ({
      octokit,
      auth: { provider: 'github', source: 'app', required: false },
    })),
  } as unknown as GitHubClient;
}

const updateFileInput = {
  repository_owner: 'sample-owner',
  repository_name: 'sample-repo',
  branch: 'sample-branch',
  file_path: 'lifecycle.yaml',
  new_content: 'services:\n  - name: sample-service\n',
  commit_message: 'fix: update sample service',
};

describe('diagnostic update_file previews', () => {
  it('does not request approval or emit a file-change preview for no-op updates', async () => {
    const githubClient = buildGithubClient(updateFileInput.new_content);

    await expect(shouldRequestUpdateFileApproval(githubClient, updateFileInput)).resolves.toBe(false);
    await expect(buildUpdateFilePreview(githubClient, updateFileInput, 'tool-call-1', 'update_file')).resolves.toEqual(
      []
    );
  });

  it('requests approval and emits a diff preview when update_file changes content', async () => {
    const githubClient = buildGithubClient('services:\n  - name: old-service\n');

    await expect(shouldRequestUpdateFileApproval(githubClient, updateFileInput)).resolves.toBe(true);
    const [preview] = await buildUpdateFilePreview(githubClient, updateFileInput, 'tool-call-1', 'update_file');

    expect(preview).toEqual(
      expect.objectContaining({
        path: 'lifecycle.yaml',
        displayPath: 'lifecycle.yaml',
        additions: 1,
        deletions: 1,
        oldSha256: expect.any(String),
        newSha256: expect.any(String),
      })
    );
    expect(preview.unifiedDiff).toContain('-  - name: old-service');
    expect(preview.unifiedDiff).toContain('+  - name: sample-service');
  });

  it('judges literal backslash-escape sequences verbatim, matching what update_file commits', async () => {
    // File holds a real newline; the model echoes it as a two-char \n sequence.
    const currentContent = 'RUN printf "a\nb"\n';
    const escapedContent = 'RUN printf "a\\nb"\n';
    const githubClient = buildGithubClient(currentContent);
    const input = { ...updateFileInput, file_path: 'Dockerfile', new_content: escapedContent };

    await expect(shouldRequestUpdateFileApproval(githubClient, input)).resolves.toBe(true);

    const [preview] = await buildUpdateFilePreview(githubClient, input, 'tool-call-1', 'update_file');
    expect(preview.unifiedDiff).toContain('+RUN printf "a\\nb"');
    expect(preview.afterTextPreview).toContain('a\\nb');
  });

  it('stamps the schema verdict on lifecycle.yaml previews so the approver sees it', async () => {
    const githubClient = buildGithubClient('services:\n  - name: old-service\n');

    const [invalidPreview] = await buildUpdateFilePreview(
      githubClient,
      { ...updateFileInput, new_content: 'services:\n  - name: sample-service\n    bogusField: nope\n' },
      'tool-call-1',
      'update_file'
    );
    expect(invalidPreview.schemaValidation).toEqual(
      expect.objectContaining({ valid: false, error: expect.stringContaining('bogusField') })
    );

    const [nonConfigPreview] = await buildUpdateFilePreview(
      githubClient,
      { ...updateFileInput, file_path: 'Dockerfile', new_content: 'FROM node:20\n' },
      'tool-call-2',
      'update_file'
    );
    expect(nonConfigPreview.schemaValidation).toBeUndefined();
  });
});
