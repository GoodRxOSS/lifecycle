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
      deployUuid: 'api-crimson-tooth-697165',
      jobId: 'k4hlde',
      shortSha: '28e350a',
    });

    expect(jobName).toBe('api-crimson-tooth-697165-deploy-k4hlde-28e350a');
  });

  it('truncates only the prefix and preserves the full suffix', () => {
    const jobName = buildDeployJobName({
      deployUuid: 'cyclerx-cosmosdb-emulator-crimson-tooth-697165',
      jobId: 'k4hlde',
      shortSha: '28e350a',
    });

    expect(jobName).toHaveLength(KUBERNETES_NAME_MAX_LENGTH);
    expect(jobName).toBe('cyclerx-cosmosdb-emulator-crimson-tooth-6-deploy-k4hlde-28e350a');
    expect(jobName.endsWith('deploy-k4hlde-28e350a')).toBe(true);
  });

  it('removes trailing separators after truncation', () => {
    const jobName = buildDeployJobName({
      deployUuid: 'service-ending-with-dash------crimson-tooth-697165',
      jobId: 'job123',
      shortSha: 'abcdef0',
    });

    expect(jobName).not.toContain('--deploy-');
    expect(jobName.endsWith('-')).toBe(false);
  });
});
