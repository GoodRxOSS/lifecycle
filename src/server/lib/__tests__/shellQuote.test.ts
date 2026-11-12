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

import { spawnSync } from 'child_process';
import { escapeK8sDollar, quoteForJobScript, quoteIfNeeded, shellQuote } from '../shellQuote';

const HOSTILE = [
  'a&x=<y>',
  'a;touch PWNED;b',
  'a$(touch PWNED)b',
  'a`touch PWNED`b',
  'it\'s "both"',
  'line1\nline2;touch PWNED',
  '$HOME ${PATH} $USER',
  'a|b||c&&d',
  '*',
  'two  spaces',
  'a\\,b\\\\c',
  '',
];

describe('shellQuote', () => {
  it.each(HOSTILE)('round-trips %j through sh', (value) => {
    const result = spawnSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' });
    expect(result.stdout).toBe(value);
  });
});

describe('quoteIfNeeded', () => {
  it.each(['my-release', './values/prod.yaml', 'oci://registry.example.com/chart', '1.2.3', 'ns_1:a=b,c@d%e+f~'])(
    'leaves safe word %s unquoted',
    (value) => {
      expect(quoteIfNeeded(value)).toBe(value);
    }
  );

  it.each(HOSTILE)('quotes %j when it is not a safe word', (value) => {
    const result = spawnSync('/bin/sh', ['-c', `printf %s ${quoteIfNeeded(value)}`], { encoding: 'utf8' });
    expect(result.stdout).toBe(value);
  });

  it('quotes the empty string so it stays an argument', () => {
    expect(quoteIfNeeded('')).toBe("''");
  });
});

describe('escapeK8sDollar', () => {
  it('doubles every dollar sign', () => {
    expect(escapeK8sDollar('a$b')).toBe('a$$b');
    expect(escapeK8sDollar('$$$')).toBe('$$$$$$');
    expect(escapeK8sDollar('$(NODE_ENV) ${X}')).toBe('$$(NODE_ENV) $${X}');
    expect(escapeK8sDollar('no dollars')).toBe('no dollars');
  });

  it('composes with shell quoting for job scripts', () => {
    expect(quoteForJobScript('a$$b')).toBe("'a$$$$b'");
    expect(quoteForJobScript('plain')).toBe('plain');
  });
});
