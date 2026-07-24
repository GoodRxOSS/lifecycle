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

import moment from 'moment';
import * as timeUtils from '../time';

describe('Time utils', () => {
  describe('#getTimestamp', () => {
    const testDate = '2019-07-04';
    test('returns formatted date', () => {
      expect(timeUtils.getTimestamp(testDate)).toMatchSnapshot();
    });

    test('takes custom formatting string', () => {
      expect(timeUtils.getTimestamp(testDate, 'MM/DD/YYYY')).toMatchSnapshot();
    });
  });

  describe('#isTimestampExpired', () => {
    test('falsy if provided date is in the future', () => {
      const futureDate = moment().add(30, 'seconds');
      expect(timeUtils.isTimestampExpired(futureDate)).toBeFalsy();
    });

    test('truthy if provided date is in the past', () => {
      const futureDate = moment().subtract(30, 'seconds');
      expect(timeUtils.isTimestampExpired(futureDate)).toBeTruthy();
    });
  });
});
