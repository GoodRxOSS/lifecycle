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

/**
 * Source gate for the build deploy decision: reading deployOnUpdate through a
 * Build (`<expr>.pullRequest.deployOnUpdate`) bypasses isDeployEnabled and
 * silently mis-gates PR-less builds. New gate reads must go through
 * server/lib/buildSource.ts; PR-anchored reads (PR-lifecycle semantics) are fine.
 */

import { execFileSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

// Intentionally PR-only reads, reviewed with the buildSource seam (exact counts so new ones fail here).
const BUILD_ANCHORED_ALLOWLIST: Record<string, number> = {
  // legacy push filter: PR builds only by design; API builds use the autoTrack lookup
  'src/server/services/github.ts': 1,
  // cleanupBuilds sweep: guarded PR-only branch (currently unwired queue)
  'src/server/services/build.ts': 1,
  // v1 serializer derives display status for PR builds
  'src/pages/api/v1/builds/[uuid]/index.ts': 1,
};

function gitGrep(pattern: string): string[] {
  try {
    const out = execFileSync(
      'git',
      [
        'grep',
        '-nE',
        pattern,
        '--',
        'src/server',
        'src/app',
        'src/pages',
        // Narrow test excludes only: ':!*test*' would exempt production files like test-connection routes.
        ':!*__tests__*',
        ':!*.test.*',
        ':!*.spec.*',
        ':!*__mocks__*',
      ],
      { cwd: ROOT, encoding: 'utf8' }
    );
    return out.split('\n').filter(Boolean);
  } catch (error: any) {
    if (error?.status === 1) return []; // git grep exits 1 on no matches
    throw error;
  }
}

describe('buildSource gate', () => {
  it('forbids build-anchored deployOnUpdate reads outside the allowlist', () => {
    const hits = gitGrep('\\.pullRequest\\??\\.deployOnUpdate').filter((line) => !line.includes('lib/buildSource.ts'));

    const counts: Record<string, number> = {};
    for (const hit of hits) {
      const file = hit.split(':')[0];
      counts[file] = (counts[file] ?? 0) + 1;
    }

    expect(counts).toEqual(BUILD_ANCHORED_ALLOWLIST);
  });

  it('forbids pullRequest-or-build dual-reads outside the accessor module', () => {
    const hits = gitGrep('pullRequest\\??\\.[A-Za-z]+ \\?\\? build\\.').filter(
      (line) => !line.includes('lib/buildSource.ts')
    );

    expect(hits).toEqual([]);
  });
});
