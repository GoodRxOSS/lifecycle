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
import { Textarea, Button, Spinner } from '@heroui/react';

interface ChatInputProps {
  buildUuid: string;
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  loading: boolean;
  streaming: boolean;
  onStop: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  autoResizeTextarea: () => void;
}

export function ChatInput({ buildUuid, input, onInputChange, onSubmit, loading, streaming, onStop, inputRef, autoResizeTextarea }: ChatInputProps) {
  return (
    <form onSubmit={onSubmit} className="w-full">
      <div className="relative">
        <Textarea
          ref={inputRef}
          value={input}
          onValueChange={(value) => {
            onInputChange(value);
            autoResizeTextarea();
          }}
          placeholder={`Ask anything about ${buildUuid}`}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit(e);
            }
          }}
          minRows={2}
          maxRows={8}
          variant="bordered"
          size="lg"
          classNames={{
            inputWrapper:
              'bg-gray-50 border border-gray-200 hover:border-gray-300 focus-within:border-gray-300 data-[hover=true]:bg-gray-50 pr-16 rounded-3xl shadow-none outline-none min-h-[72px]',
            input: 'text-lg pr-2 placeholder:text-gray-400 outline-none focus:outline-none py-4',
          }}
        />
        {streaming ? (
          <Button
            type="button"
            onClick={onStop}
            isIconOnly
            className="absolute right-3 bottom-3 bg-red-500 text-white hover:bg-red-600"
            size="lg"
            radius="full"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </Button>
        ) : (
          <Button
            type="submit"
            isDisabled={!input.trim() || loading}
            isIconOnly
            className={`absolute right-3 bottom-3 transition-all ${
              !input.trim() || loading
                ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                : 'bg-gray-800 text-white hover:bg-gray-700'
            }`}
            size="lg"
            radius="full"
          >
            {loading ? (
              <Spinner size="sm" color="current" />
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
              </svg>
            )}
          </Button>
        )}
      </div>
    </form>
  );
}
