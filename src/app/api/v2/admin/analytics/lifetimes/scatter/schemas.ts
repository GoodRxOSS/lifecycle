/**
 * Copyright 2026 GoodRx, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at the following URL:
 * https://www.apache.org/licenses/LICENSE-2.0
 */

import { environmentLifetimeAnalyticsSchemas } from 'shared/environmentLifetimeAnalyticsOpenApi';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const integer = { type: 'integer', minimum: 0 };
const object = (properties: Record<string, object>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const environmentLifetimeScatterSchemas = {
  EnvironmentLifetimeScatterPoint: object({
    ...environmentLifetimeAnalyticsSchemas.EnvironmentLifetimeRecord.properties,
    group: { type: 'string', enum: ['api', 'pr'] },
    method: { type: 'string', enum: ['created_to_deleted', 'created_to_last_update'] },
    quality: { type: 'string', enum: ['recorded', 'estimated'] },
    sampleState: { type: 'string', enum: ['valid'] },
    durationHours: { type: 'number', minimum: 0 },
    measuredUntilAt: { type: 'string', format: 'date-time' },
  }),
  EnvironmentLifetimeScatterCoverage: object({
    method: { type: 'string', enum: ['created_to_deleted', 'created_to_last_update'] },
    quality: { type: 'string', enum: ['recorded', 'estimated'] },
    eligible: integer,
    samples: integer,
    missing: integer,
    invalid: integer,
  }),
  EnvironmentLifetimeScatter: object({
    asOf: { type: 'string', format: 'date-time' },
    scope: ref('EnvironmentAnalyticsScope'),
    range: ref('AnalyticsRange'),
    group: { type: 'string', enum: ['all', 'api', 'pr'] },
    total: { ...integer, description: 'All valid durations in the selected retirement window and scope.' },
    returned: { ...integer, maximum: 5000 },
    pointLimit: { type: 'integer', enum: [5000] },
    truncated: { type: 'boolean', description: 'Above the point limit, no points are returned. This is not a sample.' },
    state: { type: 'string', enum: ['ready', 'empty', 'over_limit'] },
    nextAction: { type: 'string', nullable: true },
    coverage: object({
      api: ref('EnvironmentLifetimeScatterCoverage'),
      pr: ref('EnvironmentLifetimeScatterCoverage'),
    }),
    points: { type: 'array', maxItems: 5000, items: ref('EnvironmentLifetimeScatterPoint') },
    caveats: { type: 'array', items: { type: 'string' } },
  }),
  GetEnvironmentLifetimeScatterSuccessResponse: {
    allOf: [
      ref('SuccessApiResponse'),
      { type: 'object', properties: { data: ref('EnvironmentLifetimeScatter') }, required: ['data'] },
    ],
  },
};
