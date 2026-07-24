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

import { chain } from 'server/middlewares/chain';
import { authMiddleware, corsMiddleware, requestIdMiddleware } from 'server/middlewares';

// The order in this array is the order of execution.
const middlewares = [corsMiddleware, requestIdMiddleware, authMiddleware];

export const middleware = chain(middlewares);

export const config = {
  matcher: ['/api/v1/:path*', '/api/v2/:path*'],
};
