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

import mockRedisClient from 'server/lib/__mocks__/redisClientMock';
mockRedisClient();

import Deployable from 'server/models/Deployable';
import { generateReadinessProbeForDeployable } from '../kubernetes';

const deployable = {
  readinessInitialDelaySeconds: 10,
  readinessPeriodSeconds: 5,
  readinessTimeoutSeconds: 1,
  readinessSuccessThreshold: 1,
  readinessFailureThreshold: 3,
} as Deployable;

describe('generateReadinessProbeForDeployable', () => {
  test('should return an empty object if neither httpGet nor tcpSocket info is provided', () => {
    const input = {} as Deployable;
    const output = generateReadinessProbeForDeployable(input);
    expect(output).toEqual({});
  });

  test('should return readiness probe with httpGet when httpGetPath and httpGetPort are provided', () => {
    const input = {
      ...deployable,
      readinessHttpGetPath: '/health',
      readinessHttpGetPort: 8080,
    } as Deployable;
    const output = generateReadinessProbeForDeployable(input);
    expect(output).toEqual({
      initialDelaySeconds: 10,
      periodSeconds: 5,
      timeoutSeconds: 1,
      successThreshold: 1,
      failureThreshold: 3,
      httpGet: {
        path: '/health',
        port: 8080,
      },
    });
  });

  test('should return readiness probe with TCP Socket when tcpSocketPort is provided', () => {
    const input = {
      ...deployable,
      readinessTcpSocketPort: 3306,
    } as Deployable;
    const output = generateReadinessProbeForDeployable(input);
    expect(output).toEqual({
      initialDelaySeconds: 10,
      periodSeconds: 5,
      timeoutSeconds: 1,
      successThreshold: 1,
      failureThreshold: 3,
      tcpSocket: {
        port: 3306,
      },
    });
  });

  test('return only tcpSocketPort if both httpGet and tcpSocketPort are specified', () => {
    const input = {
      ...deployable,
      readinessHttpGetPath: '/health',
      readinessHttpGetPort: 8080,
      readinessTcpSocketPort: 3306,
    } as Deployable;
    const output = generateReadinessProbeForDeployable(input);
    expect(output).toEqual({
      initialDelaySeconds: 10,
      periodSeconds: 5,
      timeoutSeconds: 1,
      successThreshold: 1,
      failureThreshold: 3,
      tcpSocket: {
        port: 3306,
      },
    });
  });
});
