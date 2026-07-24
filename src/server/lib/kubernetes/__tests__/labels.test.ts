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

import { buildLifecycleLabels } from '../labels';

describe('buildLifecycleLabels', () => {
  it('returns managed-by label when called with no arguments', () => {
    expect(buildLifecycleLabels()).toEqual({
      'app.kubernetes.io/managed-by': 'lifecycle',
    });
  });

  it('returns managed-by label when called with empty object', () => {
    expect(buildLifecycleLabels({})).toEqual({
      'app.kubernetes.io/managed-by': 'lifecycle',
    });
  });

  it('includes lc_uuid when buildUuid is provided', () => {
    expect(buildLifecycleLabels({ buildUuid: 'build-123' })).toEqual({
      'app.kubernetes.io/managed-by': 'lifecycle',
      lc_uuid: 'build-123',
    });
  });

  it('includes deploy_uuid when deployUuid is provided', () => {
    expect(buildLifecycleLabels({ deployUuid: 'deploy-456' })).toEqual({
      'app.kubernetes.io/managed-by': 'lifecycle',
      deploy_uuid: 'deploy-456',
    });
  });

  it('includes both lc_uuid and deploy_uuid when both are provided', () => {
    expect(buildLifecycleLabels({ buildUuid: 'build-123', deployUuid: 'deploy-456' })).toEqual({
      'app.kubernetes.io/managed-by': 'lifecycle',
      lc_uuid: 'build-123',
      deploy_uuid: 'deploy-456',
    });
  });

  it('omits lc_uuid when buildUuid is undefined', () => {
    const labels = buildLifecycleLabels({ buildUuid: undefined, deployUuid: 'deploy-456' });
    expect(labels).not.toHaveProperty('lc_uuid');
    expect(labels.deploy_uuid).toBe('deploy-456');
  });

  it('omits deploy_uuid when deployUuid is undefined', () => {
    const labels = buildLifecycleLabels({ buildUuid: 'build-123', deployUuid: undefined });
    expect(labels).not.toHaveProperty('deploy_uuid');
    expect(labels.lc_uuid).toBe('build-123');
  });

  it('can be spread with other labels without conflicts', () => {
    const labels = {
      ...buildLifecycleLabels({ buildUuid: 'build-123' }),
      name: 'my-pod',
      dd_name: 'lifecycle-build-123',
    };
    expect(labels).toEqual({
      'app.kubernetes.io/managed-by': 'lifecycle',
      lc_uuid: 'build-123',
      name: 'my-pod',
      dd_name: 'lifecycle-build-123',
    });
  });

  it('caller labels can override common labels when spread after', () => {
    const labels = {
      ...buildLifecycleLabels({ buildUuid: 'build-123' }),
      'app.kubernetes.io/managed-by': 'custom-controller',
    };
    expect(labels['app.kubernetes.io/managed-by']).toBe('custom-controller');
  });
});
