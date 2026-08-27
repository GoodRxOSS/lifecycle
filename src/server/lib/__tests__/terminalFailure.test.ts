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

import { DeployStatus } from 'shared/constants';
import { compactStatusMessage, fallbackDeployStatusMessage, statusMessageFromError } from '../terminalFailure';

describe('terminal failure messages', () => {
  it('normalizes whitespace and truncates oversized status text to 1000 characters', () => {
    expect(compactStatusMessage('  build\n\tfailed   unexpectedly  ')).toBe('build failed unexpectedly');

    const compacted = compactStatusMessage('x'.repeat(1_200));
    expect(compacted).toHaveLength(1_000);
    expect(compacted.endsWith('...')).toBe(true);
  });

  it.each([
    [new Error(' provider\nfailed '), 'provider failed'],
    [' string\tfailure ', 'string failure'],
    [new Error(''), 'fallback message'],
    [null, 'fallback message'],
  ])('selects and compacts the most useful available failure text', (error, expected) => {
    expect(statusMessageFromError(error, ' fallback  message ')).toBe(expected);
  });

  it.each([
    [DeployStatus.BUILD_FAILED, 'Build failed. Check build logs for details.'],
    [DeployStatus.DEPLOY_FAILED, 'Deployment failed. Check deploy logs for details.'],
    [DeployStatus.ERROR, 'Deploy failed unexpectedly.'],
    [DeployStatus.READY, ''],
  ])('provides the fallback for %s', (status, expected) => {
    expect(fallbackDeployStatusMessage(status)).toBe(expected);
  });
});
