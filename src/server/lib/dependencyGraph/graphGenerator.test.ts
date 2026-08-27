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

const mockGetAllConfigs = jest.fn();

jest.mock('server/services/globalConfig', () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => ({
      getAllConfigs: (...args: unknown[]) => mockGetAllConfigs(...args),
    })),
  },
}));

import { generateGraph } from './graphGenerator';

describe('generateGraph', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllConfigs.mockResolvedValue({ lifecycleDefaults: { defaultUUID: 'default"uuid' } });
  });

  it('labels active and default services, discovers both env dependency forms, and de-duplicates edges', async () => {
    const build = {
      uuid: 'build"1',
      deployables: [
        {
          name: 'api',
          env: {
            DATABASES: '{{db_internalHostname}} and {{db_publicUrl}}',
            CACHES: '{{cache_publicUrl}} then {{cache_publicUrl}}',
            NON_STRING: 42,
          },
          initEnv: { SEARCH: '{{search-service_internalHostname}}' },
        },
        { name: 'db', env: {} },
        { name: 'inactive', env: [] },
        { name: 'missing-env', env: null },
        { name: 'invalid-env', env: 'not-an-object' },
      ],
      deploys: [
        { uuid: 'api-build"1', active: true },
        { uuid: 'db-build"1', active: true },
        { uuid: 'inactive-build"1', active: false },
      ],
    };

    const result = await generateGraph(build as any, 'LR');
    const nodes = new Map(result.nodes.map((node) => [node.id, node]));

    expect([...nodes.keys()]).toEqual([
      'api',
      'db',
      'inactive',
      'missing-env',
      'invalid-env',
      'cache',
      'search-service',
    ]);
    expect(nodes.get('api')).toMatchObject({
      data: { label: 'api-build"1' },
      style: { minWidth: '200px' },
    });
    expect(nodes.get('db')).toMatchObject({
      data: { label: 'db-build"1' },
      style: { minWidth: '200px' },
    });
    expect(nodes.get('inactive')).toMatchObject({
      data: { label: 'inactive-default"uuid' },
      style: { background: '#f2f2f2', minWidth: '200px' },
    });
    expect(nodes.get('cache')).toMatchObject({
      data: { label: 'cache-default"uuid' },
      style: { background: '#f2f2f2', minWidth: '200px' },
    });
    expect(result.edges).toEqual([
      { id: 'api-db', source: 'api', target: 'db' },
      { id: 'api-cache', source: 'api', target: 'cache' },
      { id: 'api-search-service', source: 'api', target: 'search-service' },
    ]);
    expect(nodes.get('api')!.position.x).toBeLessThan(nodes.get('db')!.position.x);
    expect(result.graphviz).toContain('"api" [label="api-build\\"1"]');
    expect(result.graphviz).toContain('"inactive" [label="inactive-default\\"uuid"]');
    expect(result.graphviz.match(/"api" -> "db"/g)).toHaveLength(1);
  });

  it('uses top-to-bottom layout by default', async () => {
    const result = await generateGraph({
      uuid: 'build-1',
      deployables: [
        { name: 'api', env: { DATABASE: '{{db_publicUrl}}' } },
        { name: 'db', env: {} },
      ],
      deploys: [
        { uuid: 'api-build-1', active: true },
        { uuid: 'db-build-1', active: true },
      ],
    } as any);
    const nodes = new Map(result.nodes.map((node) => [node.id, node]));

    expect(nodes.get('api')!.position.y).toBeLessThan(nodes.get('db')!.position.y);
    expect(result.graphviz).toContain('"api" -> "db";');
  });

  it('returns a valid empty graph when a build has no services', async () => {
    await expect(generateGraph({ uuid: 'build-1', deployables: [], deploys: [] } as any)).resolves.toEqual({
      nodes: [],
      edges: [],
      graphviz: 'digraph G {\n}',
    });
  });
});
