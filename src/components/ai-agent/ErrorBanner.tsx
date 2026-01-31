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
import { Card, CardBody, Button } from '@heroui/react';
import type { ChatError } from './hooks/useChat';

interface ErrorBannerProps {
  error: ChatError | null;
  onRetry?: () => void;
  onDismiss?: () => void;
}

const AMBER_CATEGORIES = new Set<string>(['rate-limited', 'transient']);

export function ErrorBanner({ error, onRetry, onDismiss }: ErrorBannerProps) {
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (!error || error.category !== 'rate-limited' || !error.retryAfter || error.retryAfter <= 0) {
      setRemainingSeconds(null);
      return;
    }

    const endTime = Date.now() + error.retryAfter * 1000;
    setRemainingSeconds(error.retryAfter);

    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
      setRemainingSeconds(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [error]);

  if (!error) return null;

  const isAmber = AMBER_CATEGORIES.has(error.category);
  const borderClass = isAmber ? 'border-warning' : 'border-danger';
  const textClass = isAmber ? 'text-warning-600' : 'text-danger';
  const buttonColor = isAmber ? 'warning' : 'danger';
  const retryDisabled = remainingSeconds !== null && remainingSeconds > 0;

  let suggestedActionText: string | null = null;
  if (error.suggestedAction === 'switch-model') {
    suggestedActionText = 'Try switching to a different model';
  } else if (error.suggestedAction === 'check-config') {
    suggestedActionText = 'Check AI agent configuration in admin settings';
  }

  return (
    <Card className={`mx-6 my-3 border-2 ${borderClass}`}>
      <CardBody className="py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <p className={`text-sm font-medium ${textClass}`}>
              {error.userMessage}
              {retryDisabled && (
                <span className="ml-2 font-normal">Retrying in {remainingSeconds}s...</span>
              )}
            </p>
            {suggestedActionText && (
              <p className="text-xs text-gray-500 mt-1">{suggestedActionText}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onRetry && (
              <Button
                size="sm"
                color={buttonColor as 'warning' | 'danger'}
                variant="flat"
                onClick={onRetry}
                isDisabled={retryDisabled}
              >
                Retry
              </Button>
            )}
            {onDismiss && (
              <Button
                size="sm"
                isIconOnly
                variant="light"
                onClick={onDismiss}
                aria-label="Dismiss error"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                </svg>
              </Button>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
