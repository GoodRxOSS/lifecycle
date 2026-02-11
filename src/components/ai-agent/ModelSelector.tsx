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
import { Select, SelectItem, Button } from '@heroui/react';
import type { ModelOption } from './types';

interface ModelSelectorProps {
  availableModels: ModelOption[];
  selectedModel: ModelOption | null;
  onModelChange: (modelKey: string) => void;
  onClearHistory: () => void;
  loading: boolean;
  hasMessages: boolean;
  onLabelClick?: () => void;
  xrayMode?: boolean;
}

export function ModelSelector({
  availableModels,
  selectedModel,
  onModelChange,
  onClearHistory,
  loading,
  hasMessages,
  onLabelClick,
  xrayMode,
}: ModelSelectorProps) {
  return (
    <>
      <div className="flex items-center gap-2">
        {availableModels.length > 0 && (
          <Select
            label={
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onLabelClick?.();
                }}
                className="cursor-default select-none"
              >
                Model{xrayMode && <span className="ml-1 text-amber-500 animate-pulse">[X-RAY]</span>}
              </span>
            }
            labelPlacement="outside-left"
            size="sm"
            className="w-60"
            variant="bordered"
            selectedKeys={selectedModel ? [`${selectedModel.provider}:${selectedModel.modelId}`] : []}
            onSelectionChange={(keys) => {
              const key = Array.from(keys)[0] as string;
              if (key) onModelChange(key);
            }}
            isDisabled={loading}
            classNames={{
              label: 'text-xs text-gray-600 font-semibold',
              trigger: 'border-gray-200 hover:border-gray-300',
            }}
          >
            {availableModels.map((model) => (
              <SelectItem key={`${model.provider}:${model.modelId}`}>{model.displayName}</SelectItem>
            ))}
          </Select>
        )}
      </div>
      <div className="flex items-center gap-2">
        {hasMessages && (
          <Button
            onClick={onClearHistory}
            isDisabled={loading}
            size="sm"
            variant="flat"
            color="danger"
            className="font-semibold"
          >
            Clear
          </Button>
        )}
      </div>
    </>
  );
}
