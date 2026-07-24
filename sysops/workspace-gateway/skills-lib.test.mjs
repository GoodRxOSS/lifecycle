import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSkillSourceRepoKey } from './skills-lib.mjs';

test('buildSkillSourceRepoKey separates same-repo different-branch checkouts', () => {
  assert.notEqual(
    buildSkillSourceRepoKey('example-org/example-repo', 'feature/one'),
    buildSkillSourceRepoKey('example-org/example-repo', 'feature/two')
  );
});

test('buildSkillSourceRepoKey stays stable for the same repo and branch', () => {
  assert.equal(
    buildSkillSourceRepoKey('example-org/example-repo', 'feature/one'),
    buildSkillSourceRepoKey('example-org/example-repo', 'feature/one')
  );
});

test('buildSkillSourceRepoKey keeps repo-only callers working', () => {
  assert.equal(buildSkillSourceRepoKey('example-org/example-repo'), 'example-org__example-repo');
});
