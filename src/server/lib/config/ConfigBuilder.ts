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

import { merge, cloneDeep } from 'lodash';
import { mergeKeyValueArrays } from 'shared/utils';

export interface HelmConfig {
  releaseName?: string;
  chartPath?: string;
  chartName?: string;
  chartVersion?: string;
  chartRepoUrl?: string;
  helmVersion?: string;
  args?: string;
  values?: Array<{ key: string; value: string }>;
  valueFiles?: string[];
  deploymentMethod?: 'native' | 'ci';
  nativeHelm?: {
    enabled?: boolean;
    defaultArgs?: string;
  };
}

export interface BuildConfig {
  engine?: 'buildkit' | 'kaniko';
  serviceAccount?: string;
  jobTimeout?: number;
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
  buildkit?: {
    endpoint?: string;
  };
}

export interface GlobalConfig {
  helmDefaults?: HelmConfig;
  buildDefaults?: BuildConfig;
  serviceAccount?: {
    name?: string;
    role?: string;
  };
  nativeHelm?: {
    enabled?: boolean;
    defaultArgs?: string;
  };
}

export class ConfigBuilder<T> {
  private config: T;

  constructor(initialConfig?: T) {
    this.config = cloneDeep(initialConfig || ({} as T));
  }

  set<K extends keyof T>(key: K, value: T[K]): ConfigBuilder<T> {
    this.config[key] = value;
    return this;
  }

  merge(config: Partial<T>): ConfigBuilder<T> {
    this.config = merge({}, this.config, config);
    return this;
  }

  build(): T {
    return cloneDeep(this.config);
  }
}

export class HelmConfigBuilder extends ConfigBuilder<HelmConfig> {
  setChartInfo(chartPath: string, chartName?: string, chartVersion?: string): HelmConfigBuilder {
    this.set('chartPath', chartPath);
    if (chartName) this.set('chartName', chartName);
    if (chartVersion) this.set('chartVersion', chartVersion);
    return this;
  }

  setHelmVersion(version: string): HelmConfigBuilder {
    this.set('helmVersion', version);
    return this;
  }

  addValue(key: string, value: string): HelmConfigBuilder {
    const values = this.build().values || [];
    values.push({ key, value });
    this.set('values', values);
    return this;
  }

  addValueFile(file: string): HelmConfigBuilder {
    const valueFiles = this.build().valueFiles || [];
    valueFiles.push(file);
    this.set('valueFiles', valueFiles);
    return this;
  }

  enableNativeHelm(defaultArgs?: string): HelmConfigBuilder {
    this.set('nativeHelm', {
      enabled: true,
      ...(defaultArgs && { defaultArgs }),
    });
    return this;
  }

  mergeWithDefaults(defaults: HelmConfig): HelmConfigBuilder {
    const current = this.build();

    // Convert values to string array format for mergeKeyValueArrays
    const defaultValueStrings = (defaults.values || []).map((v) => `${v.key}=${v.value}`);
    const currentValueStrings = (current.values || []).map((v) => `${v.key}=${v.value}`);

    // Merge and convert back to object format
    const mergedValueStrings = current.values?.length
      ? mergeKeyValueArrays(defaultValueStrings, currentValueStrings, '=')
      : defaultValueStrings;

    const mergedValues = mergedValueStrings.map((str) => {
      const [key, ...valueParts] = str.split('=');
      return { key, value: valueParts.join('=') };
    });

    const merged: HelmConfig = {
      ...defaults,
      ...current,
      values: mergedValues,
      valueFiles: current.valueFiles?.length ? current.valueFiles : defaults.valueFiles || current.valueFiles || [],
      nativeHelm: merge({}, defaults.nativeHelm, current.nativeHelm),
    };
    return new HelmConfigBuilder(merged);
  }
}

export class BuildConfigBuilder extends ConfigBuilder<BuildConfig> {
  setEngine(engine: 'buildkit' | 'kaniko'): BuildConfigBuilder {
    this.set('engine', engine);
    return this;
  }

  setServiceAccount(name: string): BuildConfigBuilder {
    this.set('serviceAccount', name);
    return this;
  }

  setJobTimeout(seconds: number): BuildConfigBuilder {
    this.set('jobTimeout', seconds);
    return this;
  }

  setResources(requests: Record<string, string>, limits: Record<string, string>): BuildConfigBuilder {
    this.set('resources', { requests, limits });
    return this;
  }

  setBuildkitEndpoint(endpoint: string): BuildConfigBuilder {
    this.set('buildkit', { endpoint });
    return this;
  }

  mergeWithDefaults(defaults: BuildConfig): BuildConfigBuilder {
    const current = this.build();
    const merged = merge({}, defaults, current);
    return new BuildConfigBuilder(merged);
  }
}

export class GlobalConfigBuilder extends ConfigBuilder<GlobalConfig> {
  setHelmDefaults(config: HelmConfig): GlobalConfigBuilder {
    this.set('helmDefaults', config);
    return this;
  }

  setBuildDefaults(config: BuildConfig): GlobalConfigBuilder {
    this.set('buildDefaults', config);
    return this;
  }

  setServiceAccount(name: string, role?: string): GlobalConfigBuilder {
    this.set('serviceAccount', { name, ...(role && { role }) });
    return this;
  }

  enableNativeHelm(defaultArgs?: string): GlobalConfigBuilder {
    this.set('nativeHelm', {
      enabled: true,
      ...(defaultArgs && { defaultArgs }),
    });
    return this;
  }
}
