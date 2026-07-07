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

import Deploy from '../Deploy';

describe('Deploy', () => {
  it('never writes the runtime-only publicHref to the database', () => {
    const deploy = new Deploy();
    deploy.publicUrl = 'env-abc-web.example.com';
    deploy.publicHref = 'https://env-abc-web.example.com';

    const dbJson = deploy.$toDatabaseJson();

    expect(dbJson).not.toHaveProperty('publicHref');
    expect(dbJson).toHaveProperty('publicUrl', 'env-abc-web.example.com');
  });

  it('keeps publicHref on the instance and in external JSON', () => {
    const deploy = new Deploy();
    deploy.publicHref = 'https://env-abc-web.example.com';

    expect(deploy.$toJson()).toHaveProperty('publicHref', 'https://env-abc-web.example.com');
  });
});
