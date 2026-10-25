/**
 * Copyright 2026 GoodRx, Inc.
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

import { codefreshRunArgs } from '../command';

describe('Codefresh run option boundaries', () => {
  it.each(['--local', '-d', '--', '-pipeline'])('rejects option-like pipeline name %s', (pipeline) => {
    expect(() => codefreshRunArgs(pipeline, ['--branch=main'])).toThrow('must not start with a hyphen');
  });

  it.each(['org/pipeline', "org/o'hare;$(id)", '雪', ''])(
    'preserves pipeline name %s and attached values',
    (pipeline) => {
      const args = ['--branch=--local', '--trigger=--local', '--runtime-name=--local', '--variable=--local=value'];
      expect(codefreshRunArgs(pipeline, args)).toEqual(['run', pipeline, ...args, '-d']);
    }
  );
});
