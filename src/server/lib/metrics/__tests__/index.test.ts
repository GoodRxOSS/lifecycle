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

import StatsD from 'hot-shots';
import { METRIC_DEFAULTS } from 'server/lib/metrics/constants';
import { Metrics } from 'server/lib/metrics';

interface MetricsInternals {
  constructTags(tags?: Record<string, unknown>): Record<string, unknown>;
  constructScopedMetric(metric: string): string;
  constructConfig(type: string, options: Record<string, unknown>): unknown;
}

function internals(metrics: Metrics): MetricsInternals {
  return metrics as unknown as MetricsInternals;
}

describe('Metrics', () => {
  let metrics: Metrics;
  let mockClient;

  beforeEach(() => {
    mockClient = new StatsD();
    metrics = new Metrics('test-type', {
      branchName: 'test-branch',
      uuid: 'test-uuid',
      repositoryName: 'test-repo',
      sha: 'sha',
      client: mockClient,
    });
    jest.clearAllMocks();
  });

  it('should initialize metrics with default values', () => {
    expect(metrics.config.namespace).toBe(METRIC_DEFAULTS.namespace);
    expect(metrics.config.options.alert_type).toBe(METRIC_DEFAULTS.alert_type);
    expect(metrics.config.options.source_type_name).toBe(METRIC_DEFAULTS.source_type_name);
    expect(metrics.config.tags).toMatchObject({
      env: 'prd',
      uuid: 'test-uuid',
      repositoryName: 'test-repo',
      branchName: 'test-branch',
    });
  });

  it('should increment a metric', () => {
    metrics.increment('test-metric', { tag1: 'value1' });
    expect(mockClient.increment).toHaveBeenCalledWith('lifecycle.test-type.test-metric', {
      env: 'prd',
      uuid: 'test-uuid',
      repositoryName: 'test-repo',
      branchName: 'test-branch',
      tag1: 'value1',
      sha: 'sha',
    });
  });

  it('should record a duration metric', () => {
    metrics.timing('test-duration', 125, { tag1: 'value1' });
    expect(mockClient.timing).toHaveBeenCalledWith('lifecycle.test-type.test-duration', 125, {
      env: 'prd',
      uuid: 'test-uuid',
      repositoryName: 'test-repo',
      branchName: 'test-branch',
      tag1: 'value1',
      sha: 'sha',
    });
  });

  it('should record a gauge metric', () => {
    metrics.gauge('test-gauge', 7, { tag1: 'value1' });
    expect(mockClient.gauge).toHaveBeenCalledWith('lifecycle.test-type.test-gauge', 7, {
      env: 'prd',
      uuid: 'test-uuid',
      repositoryName: 'test-repo',
      branchName: 'test-branch',
      tag1: 'value1',
      sha: 'sha',
    });
  });

  it('should trigger an event metric', () => {
    metrics.event('test-metric', 'this is a test', { tag1: 'value1' });
    expect(mockClient.event).toHaveBeenCalledWith(
      'test-metric',
      'this is a test',
      {
        source_type_name: 'lifecycle-job',
        alert_type: 'info',
        aggregation_key: 'test-type',
      },
      {
        env: 'prd',
        uuid: 'test-uuid',
        repositoryName: 'test-repo',
        branchName: 'test-branch',
        tag1: 'value1',
        sha: 'sha',
      }
    );
  });

  it('should construct tags correctly', () => {
    const tags = internals(metrics).constructTags({ tag1: 'value1' });
    expect(tags).toMatchObject({
      env: 'prd',
      uuid: 'test-uuid',
      repositoryName: 'test-repo',
      branchName: 'test-branch',
      tag1: 'value1',
      sha: 'sha',
    });
  });

  it('should construct scoped metric correctly', () => {
    const scopedMetric = internals(metrics).constructScopedMetric('test-metric');
    expect(scopedMetric).toBe('lifecycle.test-type.test-metric');
  });

  it('should construct the config object correctly', () => {
    const type = 'test-type';
    const options = {
      alert_type: 'info',
      branchName: 'test-branch',
      namespace: 'test-namespace',
      sha: 'sha',
      uuid: 'test-uuid',
      repositoryName: 'test-repo',
      source_type_name: 'test-source-type',
      tags: {
        tag1: 'value1',
        tag2: 'value2',
      },
      eventDetails: {
        detail1: 'value1',
        detail2: 'value2',
      },
    };

    const expectedConfig = {
      branchName: 'test-branch',
      eventDetails: {
        detail1: 'value1',
        detail2: 'value2',
      },
      namespace: 'test-namespace',
      options: {
        alert_type: 'info',
        aggregation_key: 'test-type',
        source_type_name: 'test-source-type',
      },
      repositoryName: 'test-repo',
      tags: {
        env: 'prd',
        uuid: 'test-uuid',
        repositoryName: 'test-repo',
        branchName: 'test-branch',
        tag1: 'value1',
        tag2: 'value2',
        sha: 'sha',
      },
      type: 'test-type',
      uuid: 'test-uuid',
      sha: 'sha',
      isEnabled: true,
    };

    const result = internals(metrics).constructConfig(type, options);
    expect(result).toEqual(expectedConfig);
  });
});
