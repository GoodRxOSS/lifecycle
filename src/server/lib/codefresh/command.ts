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

export function codefreshRunArgs(pipeline: string, args: string[]): string[] {
  // Codefresh 0.81.5 does not bind its pipeline positional after an option terminator.
  if (pipeline.startsWith('-')) {
    throw new Error('Codefresh pipeline must not start with a hyphen.');
  }
  return ['run', pipeline, ...args, '-d'];
}
