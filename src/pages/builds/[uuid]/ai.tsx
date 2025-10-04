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

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { PageLayout, ErrorAlert } from '../../../components/logs';
import { AIDebugChat } from '../../../components/ai-debug/AIDebugChat';

export default function AIDebugPage() {
  const router = useRouter();
  const { uuid } = router.query;
  const [featureEnabled, setFeatureEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (uuid) {
      checkFeatureEnabled();
    }
  }, [uuid]);

  const checkFeatureEnabled = async () => {
    try {
      const response = await fetch('/api/v2/debug/config');
      const data = await response.json();
      setFeatureEnabled(data.enabled);
    } catch (error) {
      setFeatureEnabled(false);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <PageLayout
        backLink={`/builds/${uuid}`}
        title="AI Debugging"
        environmentId={uuid as string}
      >
        <div style={{ padding: '2rem', textAlign: 'center' }}>
          Loading...
        </div>
      </PageLayout>
    );
  }

  if (!featureEnabled) {
    return (
      <PageLayout
        backLink={`/builds/${uuid}`}
        title="AI Debugging"
        environmentId={uuid as string}
      >
        <ErrorAlert error="AI Debugging is not enabled. Please contact your administrator." />
      </PageLayout>
    );
  }

  return (
    <PageLayout
      backLink={`/builds/${uuid}`}
      title="✨ Lifecycle AI"
      environmentId={uuid as string}
    >
      <div style={{ padding: '1rem' }}>
        <AIDebugChat buildUuid={uuid as string} />
      </div>
    </PageLayout>
  );
}

