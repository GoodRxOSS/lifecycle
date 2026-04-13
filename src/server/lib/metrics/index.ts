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
import {
  MetricsConfig,
  MetricsOptions,
  MetricsClient,
  MetricsEvent,
  MetricsPublicOptions,
} from 'server/lib/metrics/types';

import { METRIC_DEFAULTS } from 'server/lib/metrics/constants';
import { isIP } from 'net';
import dns from 'dns';

const statsd = new StatsD({
  udpSocketOptions: {
    // workaround for https://github.com/brightcove/hot-shots/issues/198
    type: 'udp4',
    lookup: (host, opts, callback) => {
      if (isIP(host)) {
        callback(null, host, 4);
        return;
      }
      dns.lookup(host, opts, callback);
    },
  },
});

// TODO: make this singleton pattern similar to other clients
export class Metrics {
  config: MetricsConfig;
  defaults = METRIC_DEFAULTS;
  client: MetricsClient;

  constructor(type, { client = statsd, ...options }: MetricsOptions) {
    this.config = this.constructConfig(type, options);
    const { isEnabled } = this.config;
    if (!isEnabled) {
      return this;
    }
    this.client = client as MetricsClient;
    return this;
  }

  public event = (title: string, description: string, tags = {}, options: MetricsPublicOptions = {}) => {
    if (!this.config.isEnabled) return this;
    const eventTags = options?.forceExactTags ? tags : this.constructTags(tags);
    const { aggregation_key, alert_type, source_type_name } = this.config.options;
    this.client.event(title, description, { aggregation_key, alert_type, source_type_name }, eventTags);
    return this;
  };

  public increment = (metric, tags = {}, options: MetricsPublicOptions = {}) => {
    if (!this.config.isEnabled) return this;
    const incrementTags = options?.forceExactTags ? tags : this.constructTags(tags);
    const scopedMetric = this.constructScopedMetric(metric);
    this.client.increment(scopedMetric, incrementTags);
    return this;
  };

  public updateEventDetails = (eventDetails: MetricsEvent) => {
    this.config.eventDetails = Object.assign({}, this.config.eventDetails, eventDetails);
    return this;
  };

  public updateConfigTags = (tags) => {
    this.config.tags = Object.assign({}, this.config.tags, tags);
    return this;
  };

  private constructTags = (tags = {}) => Object.assign({}, this.config.tags, tags);

  private constructScopedMetric = (metric) => {
    const { namespace, type } = this.config;
    return `${namespace}.${type}.${metric}`;
  };

  private constructConfig = (type, options) => {
    const {
      alert_type,
      branchName,
      namespace,
      uuid = '',
      repositoryName,
      source_type_name,
      tags = {},
      eventDetails = {} as MetricsEvent,
      disable = false,
      sha = '',
    } = options;
    const initializedTags = Object.assign(this.defaults.tags, tags, { uuid, repositoryName, branchName, sha });
    return {
      branchName,
      eventDetails,
      namespace: namespace || this.defaults?.namespace,
      options: {
        alert_type: alert_type || this.defaults?.alert_type,
        aggregation_key: type,
        source_type_name: source_type_name || this.defaults?.source_type_name,
      },
      repositoryName,
      sha,
      tags: initializedTags,
      type,
      uuid,
      isEnabled: !disable,
    };
  };
}

export default Metrics;
