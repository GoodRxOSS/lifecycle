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

import { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../server/lib/auth/keycloak';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }

  try {
    const payload = await verifyAccessToken(auth.slice(7));

    const keycloakResponse = await fetch(`${process.env.KEYCLOAK_ISSUER}/broker/github/token`, {
      method: 'GET',
      headers: {
        Authorization: auth,
      },
    });

    if (!keycloakResponse.ok) {
      const errorText = await keycloakResponse.text();

      if (keycloakResponse.status === 404) {
        return res.status(404).json({
          error: 'GitHub account not linked',
          message: 'Please link your GitHub account through Keycloak first',
          details: errorText,
        });
      }

      return res.status(keycloakResponse.status).json({
        error: 'Failed to fetch GitHub token',
        details: errorText,
      });
    }

    const githubToken = await keycloakResponse.text();

    return res.status(200).json({
      ok: true,
      sub: payload.sub,
      username: payload.preferred_username || payload.email,
      token: githubToken,
      message: 'GitHub token retrieved successfully from Keycloak',
    });
  } catch (error) {
    console.error('Error processing request:', error);
    return res.status(500).json({ error: 'Failed to process request', details: error.message });
  }
}
