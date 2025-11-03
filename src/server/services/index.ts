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

import BuildService from 'server/services/build';
import Environment from 'server/services/environment';
import GithubService from 'server/services/github';
import PullRequest from 'server/services/pullRequest';
import Repository from 'server/services/repository';
import Deploy from 'server/services/deploy';
import ActivityStream from 'server/services/activityStream';
import Codefresh from 'server/services/codefresh';
import Webhook from 'server/services/webhook';
import Ingress from 'server/services/ingress';
import LCService from 'server/services/service';
import Deployable from 'server/services/deployable';
import BotUser from 'server/services/botUser';
import GlobalConfig from 'server/services/globalConfig';
import LabelService from 'server/services/label';
import { IServices } from 'server/services/types';

export default function createAndBindServices(): IServices {
  return {
    BuildService: new BuildService(),
    Environment: new Environment(),
    GithubService: new GithubService(),
    PullRequest: new PullRequest(),
    Repository: new Repository(),
    Deploy: new Deploy(),
    ActivityStream: new ActivityStream(),
    Webhook: new Webhook(),
    Codefresh: new Codefresh(),
    Ingress: new Ingress(),
    LCService: new LCService(),
    Deployable: new Deployable(),
    BotUser: new BotUser(),
    GlobalConfig: GlobalConfig.getInstance(),
    LabelService: new LabelService(),
  };
}
