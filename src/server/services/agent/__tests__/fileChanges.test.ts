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

import { buildProposedFileChanges } from '../fileChanges';

describe('buildProposedFileChanges', () => {
  it('keeps workspace edit approvals as before-and-after previews instead of fake diffs', () => {
    const [change] = buildProposedFileChanges({
      toolCallId: 'tool-1',
      sourceTool: 'workspace.edit_file',
      input: {
        path: '/workspace/sample-service/app.js',
        oldText: 'before',
        newText: 'after',
      },
    });

    expect(change).toMatchObject({
      id: 'tool-1:sample-service/app.js',
      toolCallId: 'tool-1',
      sourceTool: 'workspace.edit_file',
      path: '/workspace/sample-service/app.js',
      displayPath: 'sample-service/app.js',
      stage: 'awaiting-approval',
      unifiedDiff: null,
      beforeTextPreview: 'before',
      afterTextPreview: 'after',
    });
  });

  it('keeps workspace writes as preview-only changes', () => {
    const [change] = buildProposedFileChanges({
      toolCallId: 'tool-2',
      sourceTool: 'workspace.write_file',
      input: {
        path: '/workspace/sample-service/README.md',
        content: '# Sample service',
      },
    });

    expect(change).toMatchObject({
      id: 'tool-2:sample-service/README.md',
      toolCallId: 'tool-2',
      sourceTool: 'workspace.write_file',
      path: '/workspace/sample-service/README.md',
      displayPath: 'sample-service/README.md',
      stage: 'awaiting-approval',
      unifiedDiff: null,
      beforeTextPreview: null,
      afterTextPreview: '# Sample service',
    });
  });
});
