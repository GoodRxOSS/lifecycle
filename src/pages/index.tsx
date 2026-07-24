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

import React from 'react';
import Head from 'next/head';
import Link from 'next/link';

export default function Home() {
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
        <title>Lifecycle</title>
      </Head>
      <main
        style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}
      >
        <h1
          style={{
            fontSize: '3rem',
            fontWeight: 700,
            letterSpacing: '-0.05em',
            marginBottom: '0.5em',
            cursor: 'default',
          }}
        >
          Lifecycle
        </h1>
        <p
          style={{
            textAlign: 'left',
            margin: '0 0 2em 0',
            padding: 0,
            listStyle: 'decimal inside',
            fontSize: '1.1rem',
            color: '#333',
            cursor: 'default',
          }}
        >
          The application is running. 🎉
        </p>
        <div
          style={{
            display: 'flex',
            gap: '2em',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '2em 0',
            borderTop: '1px solid #eee',
            width: '100%',
          }}
        >
          <a
            href="https://github.com/GoodRxOSS/lifecycle"
            style={{ color: '#666', textDecoration: 'none', fontWeight: 500, fontSize: '1rem' }}
          >
            Read
          </a>
          <span
            style={{ height: '1.2em', width: '1px', background: '#ddd', display: 'inline-block', margin: '0 0.5em' }}
          />
          <Link
            href="/schema/validate"
            style={{ color: '#666', textDecoration: 'none', fontWeight: 500, fontSize: '1rem' }}
          >
            Schema Validation
          </Link>
          <span
            style={{ height: '1.2em', width: '1px', background: '#ddd', display: 'inline-block', margin: '0 0.5em' }}
          />
          <a
            href="https://discord.gg/TEtKgCs8T8"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#666', textDecoration: 'none', fontWeight: 500, fontSize: '1rem' }}
          >
            Discord
          </a>
        </div>
      </main>
    </div>
  );
}
