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
import { ChatContainer } from '../../../components/ai-agent/ChatContainer';
import { Spinner } from '@heroui/react';
import { getApiPaths, fetchApi } from '../../../components/ai-agent/config';

export default function AIAgentPage() {
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
      const data = await fetchApi<{ enabled: boolean }>(getApiPaths().config as string);
      setFeatureEnabled(data.enabled);
    } catch (error) {
      setFeatureEnabled(false);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Spinner size="lg" label="Loading..." color="primary" />
      </div>
    );
  }

  if (!featureEnabled) {
    return (
      <div className="flex justify-center items-center h-screen">
        <div className="text-center">
          <div className="text-red-600 font-semibold mb-2">AI Agent Not Enabled</div>
          <div className="text-gray-600">Please contact your administrator.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen">
      <ChatContainer buildUuid={uuid as string} />
    </div>
  );
}
