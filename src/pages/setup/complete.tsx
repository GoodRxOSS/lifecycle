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

import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Link from 'next/link';

export default function SetupComplete() {
  const router = useRouter();
  const [appSetup, setAppSetup] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState({ status: '', message: '' });
  useEffect(() => {
    if (!router.isReady) return;
    const { app_setup } = router.query;
    if (app_setup) {
      try {
        setAppSetup(JSON.parse(String(app_setup)));
        setLoading(false);
      } catch {
        setAppSetup(null);
        setLoading(false);
      }
    } else {
      fetch('/api/v1/setup/status')
        .then((res) => res.json())
        .then((data) => {
          setAppSetup(data);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }
  }, [router.isReady, router.query]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        Loading...
      </div>
    );
  }

  const handleApply = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/setup/configure');
      const data = await res.json();
      if (res.ok) {
        setStatus({ status: 'success', message: data.message });
      } else {
        setStatus({ status: 'error', message: data.error });
      }
    } catch (error) {
      setStatus({ status: 'error', message: 'An unexpected error occurred.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily: "'Inter', 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif",
      }}
    >
      <Head>
        <title>GitHub App Setup Complete</title>
      </Head>
      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          width: '100%',
        }}
      >
        <div
          style={{
            background: '#fff',
            borderRadius: 16,
            boxShadow: '0 2px 16px rgba(0,0,0,0.06)',
            padding: '2.5em 2em 2em 2em',
            maxWidth: 520,
            width: '100%',
            margin: '2em 0',
          }}
        >
          <h3
            style={{
              fontSize: '2.2rem',
              fontWeight: 700,
              letterSpacing: '-0.04em',
              marginBottom: '0.5em',
              textAlign: 'center',
            }}
          >
            GitHub app installed.
          </h3>
          <div style={{ color: '#333', fontSize: 16, marginBottom: 18, textAlign: 'center' }}>
            {appSetup?.url ? (
              <>
                <span>View your GitHub app: </span>
                <a
                  href={`${appSetup.url}/installations/new`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#0366d6', textDecoration: 'underline', wordBreak: 'break-all' }}
                >
                  {appSetup.url}
                </a>
              </>
            ) : (
              <span>
                GitHub app setup is complete and secrets are applied to <code>lifecycle-app-secrets</code>.
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '1em', justifyContent: 'center', marginTop: '1.5em' }}>
            <button
              onClick={handleApply}
              style={{
                padding: '0.75em 2em',
                background: '#111',
                color: '#fff',
                borderRadius: '999px',
                fontWeight: 600,
                textDecoration: 'none',
                fontSize: '1.1rem',
                boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                opacity: status?.status || appSetup?.restarted ? 0.5 : 1,
                cursor: status?.status || appSetup?.restarted ? 'not-allowed' : 'pointer',
              }}
              disabled={Boolean(status?.status || appSetup?.restarted)}
            >
              Configure and Restart
            </button>
            <Link
              href="/"
              style={{
                padding: '0.75em 2em',
                background: '#fff',
                color: '#111',
                border: '2px solid #eee',
                borderRadius: '999px',
                fontWeight: 600,
                textDecoration: 'none',
                fontSize: '1.1rem',
                boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
              }}
            >
              Home
            </Link>
          </div>
          <div style={{ color: '#666', fontSize: 14, marginTop: 18, textAlign: 'center', padding: '1em 2em 0 2em' }}>
            {!(status?.status === 'success') && (
              <span>
                You can also manually restart the <code>lifecycle-web</code> and <code>lifecycle-worker</code> 
                deployments for the changes to take effect.
              </span>
            )}
            {status.status === 'error' && <div style={{ color: '#f00', marginTop: 18 }}>{status.message}</div>}
            {status.status === 'success' && (
              <div style={{ color: 'green', marginTop: 18 }}>
                Deployment restarted successfully. Changes will take effect shortly.
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
