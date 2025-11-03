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

import moment, { Moment } from 'moment';

export function getTimestamp(time: Moment | string, format = 'YYYY-MM-DD HH:mm:ss.SSSS') {
  const instance = moment.isMoment(time) ? time : moment(time);
  return instance.format(format);
}

export function getUtcTimestamp(time: string | Moment = moment()) {
  return getTimestamp(moment.utc(time));
}

export function isTimestampExpired(date: string | Moment, now: string | Moment = moment()) {
  return moment.utc(now).isAfter(moment.utc(date));
}
