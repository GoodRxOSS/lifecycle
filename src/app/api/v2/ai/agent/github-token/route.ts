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
import { fetchGitHubAuthenticatedUser, resolveRequestGitHubUserToken } from 'server/lib/agentSession/githubToken';
import { createApiHandler } from 'server/lib/createApiHandler';
import { getRequestUserIdentity } from 'server/lib/get-user';
import { errorResponse, successResponse } from 'server/lib/response';

export const dynamic = 'force-dynamic';

interface GitHubTokenCheck {
  keycloakGithubUsername: string | null;
  tokenFetched: boolean;
  tokenUsable: boolean;
  githubUserId: number | null;
  githubLogin: string | null;
  matchesKeycloakUsername: boolean | null;
  githubStatus: number | null;
  scopes: string[];
  rateLimitRemaining: string | null;
}

/**
 * @openapi
 * /api/v2/ai/agent/github-token:
 *   get:
 *     summary: Check the current user's Keycloak-backed GitHub token
 *     tags:
 *       - Agent Sessions
 *     responses:
 *       '200':
 *         description: GitHub token check result
 *       '401':
 *         description: Unauthorized
 *       '403':
 *         description: Forbidden
 */
const getHandler = async (req: NextRequest) => {
  const userIdentity = getRequestUserIdentity(req);
  if (!userIdentity) {
    return errorResponse(new Error('Unauthorized'), { status: 401 }, req);
  }

  const { githubUsername, githubToken } = await resolveRequestGitHubUserToken(req);

  const baseResult: GitHubTokenCheck = {
    keycloakGithubUsername: githubUsername,
    tokenFetched: Boolean(githubToken),
    tokenUsable: false,
    githubUserId: null,
    githubLogin: null,
    matchesKeycloakUsername: null,
    githubStatus: null,
    scopes: [],
    rateLimitRemaining: null,
  };

  if (!githubToken) {
    return successResponse(baseResult, { status: 200 }, req);
  }

  const probe = await fetchGitHubAuthenticatedUser(githubToken);
  const githubLogin = probe.login;
  const matchesKeycloakUsername =
    githubUsername && githubLogin ? githubUsername.toLowerCase() === githubLogin.toLowerCase() : null;

  return successResponse(
    {
      ...baseResult,
      tokenUsable: probe.ok,
      githubUserId: probe.id,
      githubLogin,
      matchesKeycloakUsername,
      githubStatus: probe.status,
      scopes: probe.scopes,
      rateLimitRemaining: probe.rateLimitRemaining,
    },
    { status: 200 },
    req
  );
};

export const GET = createApiHandler(getHandler, { roles: ['admin'] });
