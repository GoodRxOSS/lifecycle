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

import PullRequest from './PullRequest';
import Build from './Build';
import Service from './Service';
import ServiceDisk from './ServiceDisk';
import Environment from './Environment';
import Deploy from './Deploy';
import Repository from './Repository';
import BuildServiceOverride from './BuildServiceOverride';
import Configuration from './Configuration';
import Deployable from './Deployable';
import BotUser from './BotUser';
import GlobalConfig from './GlobalConfig';
import WebhookInvocations from './WebhookInvocations';
import AIAgentRepoConfig from './AIAgentRepoConfig';

export interface IModels {
  Build: typeof Build;
  BuildServiceOverride: typeof BuildServiceOverride;
  Configuration: typeof Configuration;
  Deploy: typeof Deploy;
  Environment: typeof Environment;
  PullRequest: typeof PullRequest;
  Repository: typeof Repository;
  Service: typeof Service;
  ServiceDisk: typeof ServiceDisk;
  Deployable: typeof Deployable;
  BotUser: typeof BotUser;
  GlobalConfig: typeof GlobalConfig;
  WebhookInvocations: typeof WebhookInvocations;
  AIAgentRepoConfig: typeof AIAgentRepoConfig;
}

export {
  Build,
  BuildServiceOverride,
  Configuration,
  Deploy,
  Environment,
  PullRequest,
  Repository,
  Service,
  ServiceDisk,
  Deployable,
  BotUser,
  GlobalConfig,
  WebhookInvocations,
  AIAgentRepoConfig,
};
