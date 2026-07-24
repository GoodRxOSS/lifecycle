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

process.env.PINO_LOGGER = 'false';
process.env.IS_TESTING = 'true';

const bufferModule = require('buffer') as typeof import('buffer') & {
  SlowBuffer?: typeof Buffer;
};

// Older JWT transitive dependencies still read `require('buffer').SlowBuffer.prototype`.
// Some Jest/Node combinations omit that legacy export, so mirror Buffer for test imports.
if (!bufferModule.SlowBuffer) {
  bufferModule.SlowBuffer = bufferModule.Buffer;
}
