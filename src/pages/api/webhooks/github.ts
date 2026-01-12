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
import tracer from 'dd-trace';
import * as github from 'server/lib/github';
import { LIFECYCLE_MODE } from 'shared/index';
import { stringify } from 'flatted';
import BootstrapJobs from 'server/jobs/index';
import createAndBindServices from 'server/services';
import { withLogContext, getLogger, extractContextForQueue, LogStage } from 'server/lib/logger/index';

const services = createAndBindServices();

/* Only want to listen on web nodes, otherwise no-op for safety */
// eslint-disable-next-line import/no-anonymous-default-export
export default async (req: NextApiRequest, res: NextApiResponse) => {
  const correlationId = (req.headers['x-github-delivery'] as string) || `webhook-${Date.now()}`;
  const sender = req.body?.sender?.login;

  return withLogContext({ correlationId, sender }, async () => {
    const isVerified = github.verifyWebhookSignature(req);
    if (!isVerified) throw new Error('Webhook not verified');

    const event = req.headers['x-github-event'] as string;

    const isBot = sender?.includes('[bot]') === true;
    if (event === 'issue_comment' && isBot) {
      tracer.scope().active()?.setTag('manual.drop', true);
      res.status(200).end();
      return;
    }

    getLogger({ stage: LogStage.WEBHOOK_RECEIVED }).info(`Webhook received: event=${event}`);

    if (!['web', 'all'].includes(LIFECYCLE_MODE)) {
      getLogger({ stage: LogStage.WEBHOOK_SKIPPED }).info('Skipped: wrong LIFECYCLE_MODE');
      return;
    }

    try {
      if (LIFECYCLE_MODE === 'all') BootstrapJobs(services);
      const message = stringify({ ...req, ...{ headers: req.headers } });

      await services.GithubService.webhookQueue.add('webhook', {
        message,
        ...extractContextForQueue(),
      });

      getLogger({ stage: LogStage.WEBHOOK_QUEUED }).info('Webhook queued for processing');
      res.status(200).end();
    } catch (error) {
      getLogger({ stage: LogStage.WEBHOOK_RECEIVED }).error({ error }, 'Webhook failure');
      res.status(500).end();
    }
  });
};
