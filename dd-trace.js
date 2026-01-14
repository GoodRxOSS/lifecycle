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

'use strict';

const tracer = require('dd-trace').init({
  serviceMapping: {
    redis: 'lifecycle-redis',
    ioredis: 'lifecycle-redis',
    pg: 'lifecycle-postgres',
  },
});

const blocklist = [/^\/api\/health/, /^\/api\/jobs/, /^\/_next\/static/, /^\/_next\/webpack-hmr/];

tracer.use('http', {
  server: {
    blocklist,
  },
  client: {
    blocklist,
  },
});

tracer.use('next', {
  blocklist,
});

tracer.use('net', false);
tracer.use('dns', false);
