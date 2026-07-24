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

import { Logger } from 'pino';
export type GenerateDeployTagOptions = {
  prefix?: string;
  sha: string;
  envVarsHash: string;
};

export type WaitUntilOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  setTimeoutFn?: typeof setTimeout;
  start?: DateConstructor;
  time?: DateConstructor;
};

export type LifecycleIgnores = {
  github?: {
    branches?: string[];
    events?: string[];
    organizations?: string[];
  };
};

export type EnableKillswitchOptions = {
  action?: string;
  branch?: string;
  fullName?: string;
  logger?: Logger;
  isBotUser?: boolean;
  labels?: string[];
  status?: string;
};
