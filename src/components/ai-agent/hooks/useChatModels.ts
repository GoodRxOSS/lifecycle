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

import { useState, useEffect } from 'react';
import type { ModelOption } from '../types';
import { getApiPaths, fetchApi } from '../config';

const STORAGE_KEY = 'aiAgentSelectedModel';

export function useChatModels() {
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);

  const loadAvailableModels = async () => {
    try {
      const paths = getApiPaths();
      const data = await fetchApi<{ models: ModelOption[] }>(paths.models as string);
      setAvailableModels(data.models || []);

      const storedModelKey = localStorage.getItem(STORAGE_KEY);
      if (storedModelKey && data.models?.length > 0) {
        const storedModel = data.models.find((m: ModelOption) => `${m.provider}:${m.modelId}` === storedModelKey);
        if (storedModel) {
          setSelectedModel(storedModel);
          return;
        }
      }

      const defaultModel = data.models?.find((m: ModelOption) => m.default);
      if (defaultModel) {
        setSelectedModel(defaultModel);
      } else if (data.models?.length > 0) {
        setSelectedModel(data.models[0]);
      }
    } catch (error) {
      console.error('Failed to load available models:', error);
    }
  };

  const handleModelChange = (modelKey: string) => {
    const model = availableModels.find((m) => `${m.provider}:${m.modelId}` === modelKey);
    if (model) {
      setSelectedModel(model);
      localStorage.setItem(STORAGE_KEY, modelKey);
    }
  };

  useEffect(() => {
    loadAvailableModels();
  }, []);

  return { availableModels, selectedModel, handleModelChange };
}
