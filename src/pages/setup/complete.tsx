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
import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { SetupTokenField } from 'src/components/SetupTokenField';

type SetupStatus = {
  locked: boolean;
  installed: boolean;
  created: boolean;
  restarted: boolean;
  url: string;
};

type Result = { tone: 'success' | 'error'; message: string } | null;

export default function SetupComplete() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result>(null);

  useEffect(() => {
    fetch('/api/setup/status')
      .then((res) => res.json())
      .then((payload) => setStatus(payload?.data ?? null))
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, []);

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setResult(null);
    try {
      const response = await fetch('/api/setup/configure', {
        method: 'POST',
        headers: { 'X-Setup-Token': token.trim() },
      });
      const payload = await response.json();
      if (response.ok) {
        setResult({
          tone: 'success',
          message: 'Deployment restart requested. Wait for the deployments to become ready.',
        });
      } else {
        setResult({ tone: 'error', message: payload?.error?.message || 'Something went wrong. Try again.' });
      }
    } catch {
      setResult({ tone: 'error', message: 'Lifecycle could not be reached. Try again.' });
    } finally {
      setPending(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        Loading...
      </div>
    );
  }

  if (status?.locked) {
    return (
      <main style={{ maxWidth: 560, margin: '4rem auto', padding: '0 1.5rem', fontFamily: 'sans-serif' }}>
        <h1>GitHub App setup is locked</h1>
        <p>Manage the configured GitHub App through your installation settings.</p>
        <Link href="/">Home</Link>
      </main>
    );
  }

  const done = result?.tone === 'success' || Boolean(status?.restarted);
  const disabled = pending || done;

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
        <title>Complete GitHub App setup</title>
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
            GitHub App installed
          </h3>
          <div style={{ color: '#333', fontSize: 16, marginBottom: 18, textAlign: 'center' }}>
            {status?.url ? (
              <>
                <span>View your GitHub App: </span>
                <a
                  href={`${status.url}/installations/new`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#0366d6', textDecoration: 'underline', wordBreak: 'break-all' }}
                >
                  {status.url}
                </a>
              </>
            ) : (
              <span>
                GitHub App settings are saved in <code>lifecycle-app-secrets</code>.
              </span>
            )}
          </div>
          <form onSubmit={handleApply}>
            <SetupTokenField value={token} onChange={setToken} />
            <div style={{ display: 'flex', gap: '1em', justifyContent: 'center', marginTop: '1.5em' }}>
              <button
                type="submit"
                style={{
                  padding: '0.75em 2em',
                  background: '#111',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '999px',
                  fontWeight: 600,
                  textDecoration: 'none',
                  fontSize: '1.1rem',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                  opacity: disabled ? 0.5 : 1,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
                disabled={disabled}
              >
                Configure and restart
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
          </form>
          <div style={{ color: '#666', fontSize: 14, marginTop: 18, textAlign: 'center', padding: '1em 2em 0 2em' }}>
            <div style={{ minHeight: 40 }}>
              {!done && (
                <span>
                  You can also manually restart the <code>lifecycle-web</code> and <code>lifecycle-worker</code>{' '}
                  deployments for the changes to take effect.
                </span>
              )}
            </div>
            <div
              role="status"
              style={{
                minHeight: 40,
                marginTop: 18,
                color: result?.tone === 'error' ? '#b00020' : 'green',
                visibility: result ? 'visible' : 'hidden',
              }}
            >
              {result?.message ?? ''}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
