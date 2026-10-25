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
import Head from 'next/head';
import Link from 'next/link';
import router from 'next/router';
import React, { useEffect, useState } from 'react';
import { SetupTokenField } from 'src/components/SetupTokenField';

type SetupStatus = {
  locked: boolean;
  installed: boolean;
  created: boolean;
  restarted: boolean;
  url: string;
};

type Feedback = { tone: 'error' | 'info'; message: string } | null;

const CARD_STYLE: React.CSSProperties = {
  background: '#fff',
  borderRadius: 16,
  boxShadow: '0 2px 16px rgba(0,0,0,0.06)',
  padding: '2.5em 2em 2em 2em',
  maxWidth: 420,
  width: '100%',
  margin: '2em 0',
};

const TITLE_STYLE: React.CSSProperties = {
  fontSize: '2.2rem',
  fontWeight: 700,
  letterSpacing: '-0.04em',
  marginBottom: '0.5em',
  textAlign: 'center',
};

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  marginTop: 4,
  padding: '0.7em',
  borderRadius: 8,
  border: '1px solid #ddd',
  fontSize: '1rem',
  marginBottom: 2,
};

const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '0.75em 0',
  fontWeight: 600,
  background: '#111',
  color: '#fff',
  border: 'none',
  borderRadius: '999px',
  fontSize: '1.1rem',
  boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
  marginTop: 8,
};

const SECONDARY_LINK_STYLE: React.CSSProperties = {
  display: 'block',
  textAlign: 'center',
  padding: '0.75em 2em',
  background: '#fff',
  color: '#111',
  border: '2px solid #eee',
  borderRadius: '999px',
  fontWeight: 600,
  textDecoration: 'none',
  fontSize: '1.1rem',
  boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
  marginTop: 12,
};

function feedbackStyle(feedback: Feedback): React.CSSProperties {
  const isError = feedback?.tone === 'error';
  return {
    marginTop: 24,
    minHeight: 76,
    padding: 16,
    borderRadius: 8,
    textAlign: 'center',
    visibility: feedback ? 'visible' : 'hidden',
    color: isError ? '#842029' : '#155724',
    background: isError ? '#f8d7da' : '#d4edda',
  };
}

async function postSetup(path: string, token: string, body?: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Setup-Token': token.trim() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { ok: response.ok, payload };
}

function submitManifestToGithub(actionUrl: string, manifest: unknown) {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = actionUrl;
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = JSON.stringify(manifest);
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}

export default function SetupPage() {
  const [type, setType] = useState<'personal' | 'org'>('personal');
  const [org, setOrg] = useState('');
  const [appName, setAppName] = useState('');
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SetupStatus | null>(null);

  const appNamePlaceholder = org ? `${org}-lfc-dev` : 'lfc-dev';

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await fetch('/api/setup/status');
        const payload = await response.json();
        const data: SetupStatus | null = payload?.data ?? null;
        if (data?.installed && !data.locked) {
          router.push('/setup/complete');
          return;
        }
        setStatus(data);
      } catch {
        setStatus(null);
      } finally {
        setLoading(false);
      }
    };
    fetchStatus();
  }, []);

  const fail = (message?: string) => {
    setFeedback({ tone: 'error', message: message || 'Something went wrong. Try again.' });
    setSubmitting(false);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      const { ok, payload } = await postSetup('/api/setup/manifest', token, {
        appName: appName.trim(),
        org: type === 'org' ? org.trim() : '',
      });
      if (!ok) return fail(payload?.error?.message);
      setFeedback({ tone: 'info', message: 'Taking you to GitHub to create the App.' });
      submitManifestToGithub(payload.data.actionUrl, payload.data.manifest);
    } catch {
      fail('Lifecycle could not be reached. Try again.');
    }
  };

  const handleInstall = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      const { ok, payload } = await postSetup('/api/setup/manifest', token);
      if (!ok) return fail(payload?.error?.message);
      setFeedback({ tone: 'info', message: 'Taking you to GitHub to install the App.' });
      window.location.assign(payload.data.installUrl);
    } catch {
      fail('Lifecycle could not be reached. Try again.');
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

  const created = Boolean(status?.created && !status?.installed);
  const tokenField = <SetupTokenField value={token} onChange={setToken} />;

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
        <title>Set up the GitHub App</title>
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
        <div style={CARD_STYLE}>
          <h1 style={TITLE_STYLE}>{created ? 'Install GitHub App' : 'Create GitHub App'}</h1>
          {created ? (
            <form onSubmit={handleInstall}>
              <p style={{ textAlign: 'center', color: '#333', marginBottom: 18 }}>
                The GitHub App exists. Install it on your repositories to finish.
              </p>
              {tokenField}
              <button
                type="submit"
                disabled={submitting}
                style={{ ...PRIMARY_BUTTON_STYLE, opacity: submitting ? 0.5 : 1 }}
              >
                Install GitHub App
              </button>
              <Link href="/" style={SECONDARY_LINK_STYLE}>
                Back
              </Link>
            </form>
          ) : (
            <form onSubmit={handleCreate}>
              <div style={{ marginBottom: 18, display: 'flex', justifyContent: 'center', gap: '1.5em' }}>
                <label style={{ fontWeight: 500 }}>
                  <input
                    type="radio"
                    name="type"
                    value="personal"
                    checked={type === 'personal'}
                    onChange={() => setType('personal')}
                    style={{ marginRight: 6 }}
                  />
                  Personal
                </label>
                <label style={{ fontWeight: 500 }}>
                  <input
                    type="radio"
                    name="type"
                    value="org"
                    checked={type === 'org'}
                    onChange={() => setType('org')}
                    style={{ marginRight: 6 }}
                  />
                  Organization
                </label>
              </div>
              {type === 'org' && (
                <div style={{ marginBottom: 18 }}>
                  <label style={{ fontWeight: 500 }}>
                    Organization Name <span style={{ color: 'red' }}>*</span>
                    <input
                      type="text"
                      value={org}
                      pattern="[a-zA-Z0-9-]{1,39}"
                      onChange={(e) => setOrg(e.target.value)}
                      required
                      maxLength={39}
                      style={INPUT_STYLE}
                      placeholder="e.g. my-org"
                      title="Max 39 chars, only letters, numbers, hyphens."
                    />
                  </label>
                </div>
              )}
              <div style={{ marginBottom: 18 }}>
                <label style={{ fontWeight: 500 }}>
                  GitHub App Name <span style={{ color: 'red' }}>*</span>
                  <input
                    type="text"
                    value={appName}
                    onChange={(e) => setAppName(e.target.value)}
                    required
                    maxLength={34}
                    style={INPUT_STYLE}
                    placeholder={appNamePlaceholder}
                    pattern="[a-zA-Z0-9-]{1,34}"
                    title="Max 34 chars, only letters, numbers, hyphens."
                  />
                </label>
              </div>
              {tokenField}
              <button
                type="submit"
                disabled={submitting}
                style={{ ...PRIMARY_BUTTON_STYLE, opacity: submitting ? 0.5 : 1 }}
              >
                Create App
              </button>
            </form>
          )}
          <div style={feedbackStyle(feedback)} role="status">
            {feedback?.message ?? ''}
          </div>
        </div>
      </main>
    </div>
  );
}
