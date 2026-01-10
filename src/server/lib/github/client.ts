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

import PQueue from 'p-queue';
import { constructOctokitClient, constructClientRequestData } from 'server/lib/github/utils';
import { CreateOctokitClientOptions } from 'server/lib/github/types';
import GlobalConfigService from 'server/services/globalConfig';
import { Metrics } from 'server/lib/metrics';

const queue = new PQueue({
  concurrency: 100,
  intervalCap: 40,
  interval: 10000,
  carryoverConcurrencyCount: true,
});

export const createOctokitClient = async ({ accessToken, caller = '' }: CreateOctokitClientOptions = {}) => {
  let token: string | undefined = await GlobalConfigService.getInstance().getGithubClientToken();
  if (!token) token = accessToken;
  const octokit = constructOctokitClient({ token });
  const metrics = new Metrics('github.api.rate_limit', { caller });
  const eventDetails = {
    title: 'Github api request made',
    description: `Github api request made by ${caller}`,
  };
  return {
    ...octokit,
    accessToken: token,
    request: async (req, options = {}) => {
      const resp = await queue.add(() => octokit.request(req, options));
      const insights = constructClientRequestData(resp, req, caller);
      const used = insights?.rateLimit?.used;
      const limit = insights?.rateLimit?.limit;
      metrics.increment('request', { used, limit }).event(eventDetails.title, eventDetails.description);
      return resp;
    },
  };
};
