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

import { buildDeployJobName, KUBERNETES_NAME_MAX_LENGTH } from '../jobNames';

describe('buildDeployJobName', () => {
  it('preserves deploy job names that already fit', () => {
    const jobName = buildDeployJobName({
      deployUuid: 'api-preview-build-123456',
      jobId: 'k4hlde',
      shortSha: 'abcdef1',
    });

    expect(jobName).toBe('api-preview-build-123456-deploy-k4hlde-abcdef1');
  });

  it('truncates only the prefix and preserves the full suffix', () => {
    const jobName = buildDeployJobName({
      deployUuid: 'sample-cosmos-emulator-preview-build-123456',
      jobId: 'k4hlde',
      shortSha: 'abcdef1',
    });

    expect(jobName).toHaveLength(KUBERNETES_NAME_MAX_LENGTH);
    expect(jobName).toBe('sample-cosmos-emulator-preview-build-1234-deploy-k4hlde-abcdef1');
    expect(jobName.endsWith('deploy-k4hlde-abcdef1')).toBe(true);
  });

  it('removes trailing separators after truncation', () => {
    const jobName = buildDeployJobName({
      deployUuid: 'service-ending-with-dash------preview-build-123456',
      jobId: 'job123',
      shortSha: 'abcdef0',
    });

    expect(jobName).not.toContain('--deploy-');
    expect(jobName.endsWith('-')).toBe(false);
  });

  it('returns a truncated suffix when suffix length alone exceeds maxLength', () => {
    // suffix = 'deploy-k4hlde-abcdef1' (21 chars); maxLength=14 → maxPrefixLength = 14-21-1 = -8
    // falls back to suffix.substring(0, 14) = 'deploy-k4hlde-' → trailing dash stripped
    const jobName = buildDeployJobName({
      deployUuid: 'some-service',
      jobId: 'k4hlde',
      shortSha: 'abcdef1',
      maxLength: 14,
    });

    expect(jobName).toBe('deploy-k4hlde');
    expect(jobName.endsWith('-')).toBe(false);
  });
});
