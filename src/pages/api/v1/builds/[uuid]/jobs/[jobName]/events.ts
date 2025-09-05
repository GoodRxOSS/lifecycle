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

/**
 * @openapi
 * /api/v1/builds/{uuid}/jobs/{jobName}/events:
 *   get:
 *     summary: Get Kubernetes events for a specific job
 *     description: |
 *       Retrieves all Kubernetes events related to a specific job and its pods.
 *       Events are sorted by timestamp with the most recent events first.
 *     tags:
 *       - Jobs
 *       - Events
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: The UUID of the build environment
 *       - in: path
 *         name: jobName
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the Kubernetes job
 *     responses:
 *       200:
 *         description: Successful response with events list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         description: Event name
 *                       namespace:
 *                         type: string
 *                         description: Kubernetes namespace
 *                       reason:
 *                         type: string
 *                         description: Event reason (e.g., Created, Started, Failed)
 *                       message:
 *                         type: string
 *                         description: Detailed event message
 *                       type:
 *                         type: string
 *                         description: Event type (Normal or Warning)
 *                       count:
 *                         type: number
 *                         description: Number of times this event has occurred
 *                       firstTimestamp:
 *                         type: string
 *                         format: date-time
 *                         description: When this event first occurred
 *                       lastTimestamp:
 *                         type: string
 *                         format: date-time
 *                         description: When this event last occurred
 *                       eventTime:
 *                         type: string
 *                         format: date-time
 *                         description: Event time (newer API field)
 *                       source:
 *                         type: object
 *                         properties:
 *                           component:
 *                             type: string
 *                             description: Component that reported the event
 *                           host:
 *                             type: string
 *                             description: Host where the event was reported
 *       400:
 *         description: Bad request - missing or invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Missing or invalid uuid or jobName parameters
 *       404:
 *         description: Environment or job not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Environment or job not found.
 *       405:
 *         description: Method not allowed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: POST is not allowed
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Internal server error occurred.
 *       502:
 *         description: Bad gateway - failed to communicate with Kubernetes
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to communicate with Kubernetes.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import rootLogger from 'server/lib/logger';
import * as k8s from '@kubernetes/client-node';
import { HttpError } from '@kubernetes/client-node';

const logger = rootLogger.child({
  filename: __filename,
});

interface K8sEvent {
  name: string;
  namespace: string;
  reason: string;
  message: string;
  type: string;
  count: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  eventTime?: string;
  source?: {
    component?: string;
    host?: string;
  };
}

interface EventsResponse {
  events: K8sEvent[];
}

async function getJobEvents(jobName: string, namespace: string): Promise<K8sEvent[]> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

  try {
    const eventsResponse = await coreV1Api.listNamespacedEvent(namespace);
    const allEvents = eventsResponse.body.items || [];

    const jobEvents = allEvents.filter((event) => {
      const involvedObject = event.involvedObject;
      if (!involvedObject) return false;

      if (involvedObject.kind === 'Job' && involvedObject.name === jobName) {
        return true;
      }

      if (involvedObject.kind === 'Pod' && involvedObject.name?.startsWith(jobName)) {
        return true;
      }

      return false;
    });

    const events: K8sEvent[] = jobEvents.map((event) => ({
      name: event.metadata?.name || '',
      namespace: event.metadata?.namespace || '',
      reason: event.reason || '',
      message: event.message || '',
      type: event.type || 'Normal',
      count: event.count || 1,
      firstTimestamp: event.firstTimestamp,
      lastTimestamp: event.lastTimestamp,
      eventTime: event.eventTime,
      source: event.source
        ? {
            component: event.source.component,
            host: event.source.host,
          }
        : undefined,
    }));

    events.sort((a, b) => {
      const aTime = new Date(a.lastTimestamp || a.eventTime || 0).getTime();
      const bTime = new Date(b.lastTimestamp || b.eventTime || 0).getTime();
      return bTime - aTime;
    });

    return events;
  } catch (error) {
    logger.error(`Error fetching events for job ${jobName}:`, error);
    throw error;
  }
}

const eventsHandler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    logger.warn({ method: req.method }, 'Method not allowed');
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `${req.method} is not allowed` });
  }

  const { uuid, jobName } = req.query;

  if (typeof uuid !== 'string' || typeof jobName !== 'string') {
    logger.warn({ uuid, jobName }, 'Missing or invalid query parameters');
    return res.status(400).json({ error: 'Missing or invalid uuid or jobName parameters' });
  }

  try {
    const namespace = `env-${uuid}`;

    const events = await getJobEvents(jobName, namespace);

    const response: EventsResponse = {
      events,
    };

    return res.status(200).json(response);
  } catch (error) {
    logger.error({ err: error }, `Error getting events for job ${jobName} in environment ${uuid}.`);

    if (error instanceof HttpError) {
      if (error.response?.statusCode === 404) {
        return res.status(404).json({ error: 'Environment or job not found.' });
      }
      return res.status(502).json({ error: 'Failed to communicate with Kubernetes.' });
    }

    return res.status(500).json({ error: 'Internal server error occurred.' });
  }
};

export default eventsHandler;
