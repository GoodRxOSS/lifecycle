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

export const deployment = {
  type: 'object',
  additionalProperties: false,
  properties: {
    helm: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        chartName: { type: 'string' },
        chartRepoUrl: { type: 'string' },
        chartVersion: { type: 'string' },
        cmdPs: { type: 'string' },
        action: { type: 'string' },
        customValues: { type: 'array', items: { type: 'string' } },
        customValueFiles: { type: 'array', items: { type: 'string' } },
        helmVersion: { type: 'string' },
        attachPvc: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            mountPath: { type: 'string' },
          },
        },
      },
    },
    public: { type: 'boolean' },
    capacityType: { type: 'string', format: 'capacityType' },
    resource: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cpu: {
          type: 'object',
          additionalProperties: false,
          properties: {
            request: { type: 'string' },
            limit: { type: 'string' },
          },
        },
        memory: {
          type: 'object',
          additionalProperties: false,
          properties: {
            request: { type: 'string' },
            limit: { type: 'string' },
          },
        },
      },
    },
    readiness: {
      type: 'object',
      additionalProperties: false,
      properties: {
        disabled: { type: 'boolean' },
        tcpSocketPort: { type: 'number' },
        httpGet: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            port: { type: 'number' },
          },
        },
        initialDelaySeconds: { type: 'number' },
        periodSeconds: { type: 'number' },
        timeoutSeconds: { type: 'number' },
        successThreshold: { type: 'number' },
        failureThreshold: { type: 'number' },
      },
    },
    hostnames: {
      type: 'object',
      additionalProperties: false,
      properties: {
        host: { type: 'string' },
        acmARN: { type: 'string' },
        defaultInternalHostname: { type: 'string' },
        defaultPublicUrl: { type: 'string' },
      },
    },
    network: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ipWhitelist: { type: 'array' },
        pathPortMapping: { type: 'object' },
        hostPortMapping: { type: 'object' },
        grpc: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enable: { type: 'boolean' },
            host: { type: 'string' },
            defaultHost: { type: 'string' },
          },
        },
      },
    },
    serviceDisks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          mountPath: { type: 'string' },
          accessModes: { type: 'string', format: 'diskAccessMode' },
          storageSize: { type: 'string' },
          medium: { type: 'string' },
        },
        required: ['name', 'mountPath', 'storageSize'],
      },
    },
  },
};
