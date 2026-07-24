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
import 'server/lib/dependencies';
import { NotFoundError } from 'server/lib/appError';
import { resolveChatPreviewHostProtocol } from 'server/lib/agentSession/chatPreviewFactory';
import { createChatPreviewGrant } from 'server/lib/agentSession/chatPreviewGrant';
import { parsePreviewGrantBody } from 'server/lib/agentSession/chatPreviewGrantRequest';
import { createApiHandler } from 'server/lib/createApiHandler';
import { requireRequestUserIdentity } from 'server/lib/get-user';
import { successResponse } from 'server/lib/response';
import AgentSession from 'server/models/AgentSession';
import { AgentSessionKind, AgentWorkspaceStatus } from 'shared/constants';

const postHandler = async (req: NextRequest) => {
  const userIdentity = requireRequestUserIdentity(req);
  const { sessionId, port, previewHost } = parsePreviewGrantBody(await req.json().catch(() => ({})));
  const session = await AgentSession.query().findOne({
    uuid: sessionId,
    userId: userIdentity.userId,
    sessionKind: AgentSessionKind.CHAT,
  });

  if (!session || session.status !== 'active' || session.workspaceStatus !== AgentWorkspaceStatus.READY) {
    throw new NotFoundError('Preview session was not found or is not ready.', 'preview_session_not_found');
  }

  const { grant, maxAgeSeconds } = createChatPreviewGrant({
    sessionId,
    port,
    userId: userIdentity.userId,
    previewHost,
  });

  return successResponse(
    {
      grant,
      maxAgeSeconds,
      previewUrl: `${resolveChatPreviewHostProtocol()}//${previewHost}/`,
      cookie: {
        name: 'lfc_chat_preview_auth',
        path: '/',
        maxAgeSeconds,
      },
    },
    { status: 200 },
    req
  );
};

export const POST = createApiHandler(postHandler, { auth: 'session' });
