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

/* eslint-disable @typescript-eslint/no-explicit-any */
import NextAuth from 'next-auth';
import Keycloak from 'next-auth/providers/keycloak';

const handler = NextAuth({
  providers: [
    Keycloak({
      issuer: process.env.KEYCLOAK_ISSUER,
      clientId: process.env.KEYCLOAK_CLIENT_ID!,
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET!,
      authorization: {
        params: { scope: 'openid profile email' },
      },
    }),
  ],
  session: { strategy: 'jwt' },
  secret: process.env.NEXTAUTH_SECRET,
  callbacks: {
    async jwt({ token, account }) {
      // On initial sign-in, persist access/refresh tokens
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.accessTokenExpires = account.expires_at ? account.expires_at * 1000 : undefined;
      }

      // If near expiry, refresh with Keycloak
      const needsRefresh =
        typeof token.accessTokenExpires === 'number' &&
        Date.now() > token.accessTokenExpires - 60_000 &&
        token.refreshToken;

      if (needsRefresh) {
        try {
          const res = await fetch(`${process.env.KEYCLOAK_ISSUER}/protocol/openid-connect/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              client_id: process.env.KEYCLOAK_CLIENT_ID!,
              client_secret: process.env.KEYCLOAK_CLIENT_SECRET!,
              refresh_token: String(token.refreshToken),
            }),
          });
          const data = await res.json();
          if (!res.ok) throw data;

          token.accessToken = data.access_token;
          token.refreshToken = data.refresh_token ?? token.refreshToken;
          token.accessTokenExpires = Date.now() + data.expires_in * 1000;
        } catch {
          token.error = 'RefreshAccessTokenError';
        }
      }
      return token;
    },
    async session({ session, token }) {
      // Expose the access token so the UI can call your core API
      (session as any).accessToken = token.accessToken;
      (session as any).error = token.error;
      return session;
    },
  },
});

export default handler;
