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

import { CommentHelper } from 'server/lib/comment';
import { CommentParser } from 'shared/constants';

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn().mockReturnValue({
    debug: jest.fn(),
  }),
}));

describe('CommentHelper.parseEnvironmentOverrides', () => {
  test('ignores commented examples and parses real env overrides', () => {
    const comment = [
      'Status comment',
      CommentParser.HEADER,
      '// **Override Environment Variables (add one override per line below)**',
      '// Example ENV:FEATURE_ENABLED:true',
      '// Example ENV:LIFECYCLE_API_URL:https://app.lifecycle.com/api',
      'ENV:LIFECYCLE_API_URL:https://app.lifecycle.com/api/v1',
      'ENV:FEATURE_FLAGS.checkout:true',
      CommentParser.FOOTER,
    ].join('\n');

    expect(CommentHelper.parseEnvironmentOverrides(comment)).toEqual({
      LIFECYCLE_API_URL: 'https://app.lifecycle.com/api/v1',
      FEATURE_FLAGS: {
        checkout: 'true',
      },
    });
  });

  test('preserves spaces in values while trimming leading whitespace', () => {
    const comment = [
      'Status comment',
      CommentParser.HEADER,
      '  ENV:BANNER_TEXT:sample lifecycle banner',
      CommentParser.FOOTER,
    ].join('\n');

    expect(CommentHelper.parseEnvironmentOverrides(comment)).toEqual({
      BANNER_TEXT: 'sample lifecycle banner',
    });
  });
});
