/**
 * Copyright 2026 GoodRx, Inc.
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

import { NextRequest } from 'next/server';
import { BadRequestError, NotFoundError, ForbiddenError } from 'server/lib/appError';
import { createPrincipalApiHandler } from 'server/lib/createApiHandler';
import { assertLogStreamPodContainer } from 'server/lib/logStreamPodAccess';
import { createLogStreamTicket } from 'server/lib/logStreamTicket';
import type { Principal } from 'server/lib/principal';
import { assertBuildRepositoryAllowed } from 'server/lib/repositoryAuthorization';
import { canServeLogs } from 'server/lib/serverAccess';
import { successResponse, withNoStore } from 'server/lib/response';
import BuildService from 'server/services/build';
import { assertNoUnknownFields } from '../../me/tokens/shared';

const TICKET_FIELDS = ['buildUuid', 'podName', 'containerName'] as const;
const BUILD_UUID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const POD_NAME_PATTERN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const CONTAINER_NAME_PATTERN = /^(\[init\] )?[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

function readField(body: Record<string, unknown>, field: string, pattern: RegExp, message: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new BadRequestError(message, 'invalid_body');
  }
  return value;
}

/**
 * @openapi
 * /api/v2/logs/stream-tickets:
 *   post:
 *     summary: Mint a ticket for the pod log stream
 *     security:
 *       - BearerAuth: []
 *       - LifecycleApiKey: []
 *     description: |
 *       Returns a short-lived ticket for `/api/logs/stream` that pins the environment
 *       namespace, pod and container named in the request. The pod must belong to the
 *       environment and the container must exist on it. Requires the `env:read` scope.
 *     tags:
 *       - Logs
 *     operationId: createLogStreamTicket
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [buildUuid, podName, containerName]
 *             properties:
 *               buildUuid:
 *                 type: string
 *               podName:
 *                 type: string
 *               containerName:
 *                 type: string
 *     responses:
 *       '200':
 *         description: Log stream ticket
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessApiResponse'
 *                 - type: object
 *                   required: [data]
 *                   properties:
 *                     data:
 *                       type: object
 *                       required: [ticket, maxAgeSeconds]
 *                       properties:
 *                         ticket:
 *                           type: string
 *                         maxAgeSeconds:
 *                           type: integer
 *       '400':
 *         description: Invalid request body
 *       '401':
 *         description: Missing or invalid credentials
 *       '403':
 *         description: Missing env:read scope or repository not allowed for this token
 *       '404':
 *         description: Environment, pod or container not found
 */
const postHandler = async (req: NextRequest, principal: Principal) => {
  if (!canServeLogs(process.env.LIFECYCLE_MODE)) {
    throw new ForbiddenError('Log streaming is unavailable on this server.');
  }
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestError('Request body must be a JSON object.', 'invalid_body');
  }
  assertNoUnknownFields(body, TICKET_FIELDS);
  const fields = body as Record<string, unknown>;
  const buildUuid = readField(fields, 'buildUuid', BUILD_UUID_PATTERN, 'buildUuid is required.');
  const podName = readField(fields, 'podName', POD_NAME_PATTERN, 'podName must be a Kubernetes pod name.');
  const containerName = readField(
    fields,
    'containerName',
    CONTAINER_NAME_PATTERN,
    'containerName must be a container name on the pod.'
  );

  const build = await new BuildService().getBuildByUUID(buildUuid);
  if (!build) {
    throw new NotFoundError('Environment not found.', 'environment_not_found');
  }
  await assertBuildRepositoryAllowed(principal, build);

  const target = { namespace: build.namespace || `env-${build.uuid}`, podName, containerName };
  await assertLogStreamPodContainer(target);

  const { ticket, maxAgeSeconds } = createLogStreamTicket({ ...target, buildUuid: build.uuid, actor: principal.actor });
  return withNoStore(successResponse({ ticket, maxAgeSeconds }, { status: 200 }, req));
};

export const POST = createPrincipalApiHandler({ scope: 'env:read' }, postHandler);
