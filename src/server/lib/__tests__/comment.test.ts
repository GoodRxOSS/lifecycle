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
      '// ENV:FEATURE_ENABLED:true',
      '// ENV:LIFECYCLE_API_URL:https://app.lifecycle.com/api',
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

  test('trims separator-adjacent whitespace from keys and values', () => {
    const comment = [
      'Status comment',
      CommentParser.HEADER,
      'ENV: FEATURE_ENABLED:true',
      'ENV:BANNER_TEXT: sample lifecycle banner',
      'ENV: LIFECYCLE_API_URL : https://app.lifecycle.com/api/v1 ',
      CommentParser.FOOTER,
    ].join('\n');

    expect(CommentHelper.parseEnvironmentOverrides(comment)).toEqual({
      FEATURE_ENABLED: 'true',
      BANNER_TEXT: 'sample lifecycle banner',
      LIFECYCLE_API_URL: 'https://app.lifecycle.com/api/v1',
    });
  });

  test('parses host and port values after the env key separator', () => {
    const comment = [
      'Status comment',
      CommentParser.HEADER,
      'ENV:URL:app-dev-0.lifecycle-grpc.example.com:443',
      CommentParser.FOOTER,
    ].join('\n');

    expect(CommentHelper.parseEnvironmentOverrides(comment)).toEqual({
      URL: 'app-dev-0.lifecycle-grpc.example.com:443',
    });
  });
});

describe('CommentHelper.parseRedeployOnPushes', () => {
  const line = (box: string) => `- [${box}] Redeploy on pushes to default branches`;

  test('returns undefined when the option line is absent', () => {
    const comment = ['Status comment', CommentParser.HEADER, '- [x] api: main', CommentParser.FOOTER].join('\n');

    expect(CommentHelper.parseRedeployOnPushes(comment)).toBeUndefined();
  });

  test('returns undefined for prose mentioning the option without a checkbox', () => {
    const comment = 'We should enable Redeploy on pushes to default branches for this environment.';

    expect(CommentHelper.parseRedeployOnPushes(comment)).toBeUndefined();
  });

  test('distinguishes unchecked from checked', () => {
    expect(CommentHelper.parseRedeployOnPushes(line(' '))).toBe(false);
    expect(CommentHelper.parseRedeployOnPushes(line('x'))).toBe(true);
  });

  test('tolerates uppercase, quoting, indentation and carriage returns', () => {
    expect(CommentHelper.parseRedeployOnPushes(line('X'))).toBe(true);
    expect(CommentHelper.parseRedeployOnPushes(`> ${line('x')}`)).toBe(true);
    expect(CommentHelper.parseRedeployOnPushes(`  ${line('x')}`)).toBe(true);
    expect(CommentHelper.parseRedeployOnPushes(`${line('x')}\r\nnext line`)).toBe(true);
  });

  test('finds the option when it follows the rest of the comment body', () => {
    const comment = [
      CommentParser.HEADER,
      '- [x] api: main',
      CommentParser.FOOTER,
      '## Actions',
      '- [ ] Redeploy Environment',
      '### Options',
      line(' '),
    ].join('\n');

    expect(CommentHelper.parseRedeployOnPushes(comment)).toBe(false);
  });
});
