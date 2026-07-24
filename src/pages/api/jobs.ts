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

import { LIFECYCLE_MODE } from 'shared/config';

import BootstrapJobs from '../../server/jobs/index';
import createAndBindServices from 'server/services';
import { NextApiRequest, NextApiResponse } from 'next/types';

let bootStrapped = false;

const services = createAndBindServices();

/**
 * Nextjs doesn't have an easy way to bootstrap a bull processing queue, so we just hook into an
 * API endpoint to bootstrap up one time
 */
// eslint-disable-next-line import/no-anonymous-default-export
export default (_req: NextApiRequest, res: NextApiResponse) => {
  if (!bootStrapped) {
    if (LIFECYCLE_MODE === 'job' || LIFECYCLE_MODE === 'all') {
      BootstrapJobs(services);
    }
    bootStrapped = true;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end();
};
