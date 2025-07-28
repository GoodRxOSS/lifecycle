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

import { NextApiRequest, NextApiResponse } from 'next/types';
import rootLogger from 'server/lib/logger';
import * as github from 'server/lib/github';
import { LIFECYCLE_MODE } from 'shared/index';
import { stringify } from 'flatted';
import BootstrapJobs from 'server/jobs/index';
import createAndBindServices from 'server/services';

const logger = rootLogger.child({
  filename: 'webhooks/github.ts',
});

const services = createAndBindServices();

/* Only want to listen on web nodes, otherwise no-op for safety */
// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: NextApiRequest, res: NextApiResponse) => {
  const isVerified = github.verifyWebhookSignature(req);
  if (!isVerified) throw new Error('Webhook not verified');
  if (!['web', 'all'].includes(LIFECYCLE_MODE)) return;
  try {
    if (LIFECYCLE_MODE === 'all') BootstrapJobs(services);
    const message = stringify({ ...req, ...{ headers: req.headers } });
    await services.GithubService.webhookQueue.add('webhook', { message });
    res.status(200).end();
  } catch (error) {
    logger.child({ error }).error(`Github Webhook failure: Error: ${error}`);
    res.status(500).end();
  }
};
