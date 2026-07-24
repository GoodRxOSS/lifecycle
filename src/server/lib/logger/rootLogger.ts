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

import pino from 'pino';
import pinoCaller from 'pino-caller';
import { LOG_LEVEL } from '../../../shared/config';

export const enabled = process.env.PINO_LOGGER === 'false' ? false : true;
export const level = LOG_LEVEL || 'info';
export const pinoPretty = process.env.PINO_PRETTY === 'true' ? true : false;

const transport = {
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
    },
  },
};

const serializers = {
  error: (value: unknown): Record<string, unknown> | string => {
    if (value instanceof Error) {
      return {
        type: value.name,
        message: value.message,
        stack: value.stack,
        ...((value as any).code && { code: (value as any).code }),
        ...((value as any).statusCode && { statusCode: (value as any).statusCode }),
      };
    }
    if (typeof value === 'object' && value !== null) {
      try {
        return JSON.stringify(value);
      } catch {
        return '[Unserializable Object]';
      }
    }
    return String(value);
  },
};

let rootLogger = pino({
  level,
  enabled,
  serializers,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  ...(pinoPretty ? transport : {}),
});

rootLogger = pinoCaller(rootLogger);

export default rootLogger;
