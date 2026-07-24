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

import Head from 'next/head';
import Link from 'next/link';
import router from 'next/router';
import React, { useEffect, useState } from 'react';
import { AppSetup } from 'server/services/types/globalConfig';

export default function SetupPage() {
  const [type, setType] = useState<'personal' | 'org'>('personal');
  const [org, setOrg] = useState('');
  const [appName, setAppName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<AppSetup | null>(null);

  const appNamePlaceholder = org ? `${org}-lfc-dev` : 'lfc-dev';

  useEffect(() => {
    const fetchStatus = async () => {
      const response = await fetch('/api/v1/setup/status');
      const data: AppSetup = await response.json();
      setStatus(data);
      setLoading(false);
    };
    fetchStatus();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const params = new URLSearchParams();
    params.append('app_name', appName.trim());
    if (type === 'org') {
      params.append('org', org.trim());
    }
    const url = `/api/v1/setup?${params.toString()}`;
    window.open(url, '_blank', 'noopener');
    setSubmitted(true);
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        Loading...
      </div>
    );
  }

  if (status?.installed) {
    router.push(`/setup/complete?app_setup=${JSON.stringify(status)}`);
  }

  // App is created but not installed yet
  if (status?.created && !status?.installed) {
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
          <title>Setup GitHub App</title>
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
              maxWidth: 420,
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
              GitHub App already created.
            </h3>
            <div style={{ display: 'flex', gap: '1em', justifyContent: 'center', marginTop: '1.5em' }}>
              <a
                href={`${status.url}/installations/new`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: '0.75em 2em',
                  background: '#111',
                  color: '#fff',
                  borderRadius: '999px',
                  fontWeight: 600,
                  textDecoration: 'none',
                  fontSize: '1.1rem',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                }}
              >
                Install GitHub App
              </a>
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
                Back
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

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
        <title>Setup GitHub App</title>
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
            maxWidth: 420,
            width: '100%',
            margin: '2em 0',
          }}
        >
          <h1
            style={{
              fontSize: '2.2rem',
              fontWeight: 700,
              letterSpacing: '-0.04em',
              marginBottom: '0.5em',
              textAlign: 'center',
            }}
          >
            Create GitHub App
          </h1>
          <form onSubmit={handleSubmit}>
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
                    onChange={(e) => {
                      setOrg(e.target.value);
                    }}
                    required={type === 'org'}
                    maxLength={39}
                    style={{
                      width: '100%',
                      marginTop: 4,
                      padding: '0.7em',
                      borderRadius: 8,
                      border: '1px solid #ddd',
                      fontSize: '1rem',
                      marginBottom: 2,
                    }}
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
                  onChange={(e) => {
                    setAppName(e.target.value);
                  }}
                  required
                  maxLength={34}
                  style={{
                    width: '100%',
                    marginTop: 4,
                    padding: '0.7em',
                    borderRadius: 8,
                    border: '1px solid #ddd',
                    fontSize: '1rem',
                    marginBottom: 2,
                  }}
                  placeholder={appNamePlaceholder}
                  pattern="[a-zA-Z0-9-]{1,34}"
                  title="Max 34 chars, only letters, numbers, hyphens."
                />
              </label>
            </div>
            <button
              type="submit"
              disabled={submitted}
              style={{
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
                opacity: submitted ? 0.5 : 1,
              }}
            >
              Create App
            </button>
          </form>
          {submitted && (
            <div
              style={{
                marginTop: 24,
                color: '#155724',
                background: '#d4edda',
                padding: 16,
                borderRadius: 8,
                textAlign: 'center',
              }}
            >
              Please complete the GitHub App creation in the newly opened tab.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
