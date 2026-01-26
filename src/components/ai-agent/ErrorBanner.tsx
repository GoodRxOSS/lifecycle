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
import { Card, CardBody, Button } from '@heroui/react';

interface ErrorBannerProps {
  error: string | null;
  onRetry?: () => void;
}

export function ErrorBanner({ error, onRetry }: ErrorBannerProps) {
  if (!error) return null;

  return (
    <Card className="mx-6 my-3 border-2 border-danger">
      <CardBody className="py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-danger font-medium flex-1">{error}</p>
          {onRetry && (
            <Button size="sm" color="danger" variant="flat" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
