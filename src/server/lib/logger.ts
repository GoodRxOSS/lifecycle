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
import { LOG_LEVEL } from '../../shared/config';

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

let rootLogger = pino({
  level,
  enabled,
  ...(pinoPretty ? transport : {}),
});

rootLogger = pinoCaller(rootLogger);

export default rootLogger;
