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
import { Button } from '@heroui/react';

interface SuggestedPromptsProps {
  onSelectPrompt: (prompt: string) => void;
  loading: boolean;
}

const suggestedQuestions = ["Why is my build failing?", "What's wrong with deployments?", 'Why are my pods not starting?'];

export function SuggestedPrompts({ onSelectPrompt, loading }: SuggestedPromptsProps) {
  return (
    <div className="flex flex-col gap-2 w-full max-w-2xl">
      <p className="text-xs text-gray-400 mb-1">Others are asking:</p>
      {suggestedQuestions.map((q, idx) => (
        <Button
          key={idx}
          onClick={() => onSelectPrompt(q)}
          isDisabled={loading}
          size="sm"
          variant="light"
          color="default"
          className="justify-center text-center h-auto py-2 px-3 text-gray-500"
          style={{
            backgroundColor: 'transparent',
          }}
          onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) =>
            (e.currentTarget.style.backgroundColor = 'rgb(243 244 246)')
          }
          onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) =>
            (e.currentTarget.style.backgroundColor = 'transparent')
          }
        >
          <span className="text-sm">{q}</span>
        </Button>
      ))}
    </div>
  );
}
