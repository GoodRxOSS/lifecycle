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
import AgentFeedbackService from 'server/services/agent/FeedbackService';
import { requireRequestUserIdentity } from './get-user';
import { BadRequestError } from './appError';
import { successResponse } from './response';

type FeedbackRouteContext = { params: Promise<{ threadId: string; messageId?: string }> };

export async function setAgentFeedbackHandler(req: NextRequest, { params }: FeedbackRouteContext) {
  const { userId } = requireRequestUserIdentity(req);
  const body = await req.json().catch(() => {
    throw new BadRequestError('Feedback must be valid JSON.', 'invalid_feedback');
  });
  return successResponse(
    await AgentFeedbackService.setFeedback({ ...(await params), userId }, body),
    { status: 200 },
    req
  );
}

export async function deleteAgentFeedbackHandler(req: NextRequest, { params }: FeedbackRouteContext) {
  const { userId } = requireRequestUserIdentity(req);
  return successResponse(
    await AgentFeedbackService.deleteFeedback({ ...(await params), userId }),
    { status: 200 },
    req
  );
}
