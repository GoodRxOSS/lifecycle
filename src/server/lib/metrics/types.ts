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

export interface MetricsConfig extends Record<string, unknown> {
  namespace: string;
  options: {
    alert_type: string;
    aggregation_key: string;
    source_type_name: string;
  };
  tags: {
    env: string;
    uuid?: string;
    repositoryName?: string;
    branchName?: string;
    sha?: string;
  };
  eventDetails?: MetricsEvent;
  type: string;
  isEnabled?: boolean;
}

export interface MetricsOptions extends Record<string, unknown> {
  alert_type?: string;
  branchName?: string;
  namespace?: string;
  uuid?: string;
  sha?: string;
  repositoryName?: string;
  source_type_name?: string;
  tags?: {
    [key: string]: string;
  };
  eventDetails?: MetricsEvent;
  disable?: boolean;
  client?: any;
}

export interface MetricsClient {
  increment: Function;
  timing: Function;
  event: Function;
}

export interface MetricsEvent {
  title: string;
  description: string;
}

export interface MetricsPublicOptions {
  forceExactTags?: boolean;
}

export interface MetricsItem {
  name: string;
  timing?: number;
  tags?: Record<string, string>;
}
