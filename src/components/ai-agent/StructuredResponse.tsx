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
import { Card, CardBody, Skeleton, Divider } from '@heroui/react';
import { ServiceCard } from './ServiceCard';
import { matchEvidenceToServices } from './utils';
import type { StructuredDebugResponse, ServiceInvestigationResult, EvidenceItem } from './types';

interface StructuredResponseProps {
  structured: StructuredDebugResponse;
  onAutoFix: (service: ServiceInvestigationResult) => void;
  loading: boolean;
  partial?: boolean;
  evidence?: EvidenceItem[];
  onHighlightActivity?: (toolCallId: string) => void;
}

export function StructuredResponse({
  structured,
  onAutoFix,
  loading,
  partial,
  evidence,
  onHighlightActivity,
}: StructuredResponseProps) {
  const evidenceMap =
    evidence && evidence.length > 0 ? matchEvidenceToServices(evidence, structured.services) : null;

  return (
    <div className="space-y-4">
      {structured.summary ? (
        <p className="text-sm text-gray-700 leading-relaxed">{structured.summary}</p>
      ) : partial ? (
        <div className="space-y-2">
          <Skeleton className="h-3 w-full rounded-lg" />
          <Skeleton className="h-3 w-2/3 rounded-lg" />
        </div>
      ) : null}
      {(structured.summary || partial) && structured.services.length > 0 && (
        <Divider className="my-2 opacity-50" />
      )}
      <div className="space-y-4">
        {structured.services.map((service) => (
          <ServiceCard
            key={service.serviceName}
            service={service}
            fixesApplied={structured.fixesApplied}
            repository={structured.repository}
            onAutoFix={onAutoFix}
            loading={loading}
            evidence={evidenceMap?.get(service.serviceName)}
            onHighlightActivity={onHighlightActivity}
          />
        ))}
      </div>
      {partial && (
        <Card className="border border-dashed border-gray-300 bg-gray-50/50">
          <CardBody className="p-4 space-y-2">
            <Skeleton className="h-4 w-3/4 rounded-lg" />
            <Skeleton className="h-3 w-1/2 rounded-lg" />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
