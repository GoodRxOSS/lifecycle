/**
 * Copyright 2026 Lifecycle contributors
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

jest.mock('.', () => ({
  Environment: class Environment {},
  Repository: class Repository {},
  ServiceDisk: class ServiceDisk {},
}));

import Service from './Service';

describe('Service database column mapping', () => {
  it('parses the exceptional snake-case database columns into model properties', () => {
    const service = new Service();

    expect(
      service.$parseDatabaseJson({
        id: 12,
        node_selector: { lifecycle: 'enabled' },
        node_affinity: { required: true },
      })
    ).toEqual({
      id: 12,
      nodeSelector: { lifecycle: 'enabled' },
      nodeAffinity: { required: true },
    });
  });

  it('formats the exceptional model properties as their database columns', () => {
    const service = new Service();

    expect(
      service.$formatDatabaseJson({
        id: 12,
        nodeSelector: { lifecycle: 'enabled' },
        nodeAffinity: { required: true },
      })
    ).toEqual({
      id: 12,
      node_selector: { lifecycle: 'enabled' },
      node_affinity: { required: true },
    });
  });
});
