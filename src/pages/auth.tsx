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
import React from 'react';
import { signIn, signOut, useSession } from 'next-auth/react';
import { useState } from 'react';
import AuthProvider from '../components/AuthProvider';

function AuthContent() {
  const { data: session, status } = useSession();
  const [githubToken, setGithubToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getGithubToken = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/github-token', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${(session as any)?.accessToken}`,
        },
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.error('Failed to get GitHub token:', res.status, errorText);
        setError(`Failed to get GitHub token: ${res.status} ${errorText}`);
        return;
      }

      const data = await res.json();
      console.log('GitHub token response:', data);
      setGithubToken(data.token);
    } catch (error) {
      console.error('Error fetching GitHub token:', error);
      setError(`Error fetching GitHub token: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  if (status === 'loading') {
    return <div style={{ padding: '20px' }}>Loading...</div>;
  }

  return (
    <div style={{ padding: '20px', fontFamily: 'monospace' }}>
      <h1>Authentication Test Page</h1>

      <div style={{ marginTop: '20px' }}>
        {!session ? (
          <div>
            <p>You are not logged in</p>
            <button
              onClick={() => signIn('keycloak', { callbackUrl: '/auth' })}
              style={{
                padding: '10px 20px',
                backgroundColor: '#0070f3',
                color: 'white',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer',
              }}
            >
              Sign in with Keycloak SSO
            </button>
          </div>
        ) : (
          <div>
            <h2>Session Information</h2>
            <div style={{
              backgroundColor: '#f4f4f4',
              padding: '10px',
              borderRadius: '5px',
              marginBottom: '20px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all'
            }}>
              {JSON.stringify(session, null, 2)}
            </div>

            <div style={{ marginBottom: '20px' }}>
              <button
                onClick={getGithubToken}
                disabled={loading}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '5px',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  marginRight: '10px',
                }}
              >
                {loading ? 'Loading...' : 'Get GitHub Token'}
              </button>

              <button
                onClick={() => signOut()}
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#dc3545',
                  color: 'white',
                  border: 'none',
                  borderRadius: '5px',
                  cursor: 'pointer',
                }}
              >
                Sign out
              </button>
            </div>

            {error && (
              <div style={{
                backgroundColor: '#f8d7da',
                color: '#721c24',
                padding: '10px',
                borderRadius: '5px',
                marginBottom: '20px'
              }}>
                {error}
              </div>
            )}

            {githubToken && (
              <div>
                <h3>GitHub Token</h3>
                <div style={{
                  backgroundColor: '#d4edda',
                  color: '#155724',
                  padding: '10px',
                  borderRadius: '5px',
                  wordBreak: 'break-all'
                }}>
                  {githubToken}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AuthPage() {
  return (
    <AuthProvider>
      <AuthContent />
    </AuthProvider>
  );
}
