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
import React from 'react';
import type { GetServerSideProps } from 'next';
import { LIFECYCLE_UI_URL } from 'shared/config';

export const getServerSideProps: GetServerSideProps = async () => ({
  props: { uiUrl: LIFECYCLE_UI_URL || null },
});

export default function SchemaValidatorPage({ uiUrl }: { uiUrl: string | null }) {
  return (
    <main style={{ maxWidth: 640, margin: '4rem auto', padding: '0 1.5rem', fontFamily: 'sans-serif' }}>
      <Head>
        <title>Validate lifecycle.yaml</title>
      </Head>
      <h1>Validate lifecycle.yaml</h1>
      <p>Use the Lifecycle CLI to validate a local file:</p>
      <pre>
        <code>lfc schema validate lifecycle.yaml</code>
      </pre>
      <p>For a repository branch, sign in with the CLI and run:</p>
      <pre>
        <code>lfc schema validate --repo owner/repository --branch branch-name</code>
      </pre>
      <p>
        The API also supports authenticated validation at <code>/api/v2/schema/validate</code>.
      </p>
      {uiUrl && <a href={uiUrl}>Open Lifecycle</a>}
    </main>
  );
}
