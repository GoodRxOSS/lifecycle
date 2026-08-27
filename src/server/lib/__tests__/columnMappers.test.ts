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

import { createColumnMapper } from '../columnMappers';

describe('createColumnMapper', () => {
  const mapper = createColumnMapper({
    nodeSelector: 'node_selector',
    nodeAffinity: 'node_affinity',
  });

  it('parses configured database columns in place while preserving unrelated values', () => {
    const databaseRow = {
      id: 7,
      node_selector: { workload: 'api' },
      node_affinity: null,
    };

    expect(mapper.parse(databaseRow)).toBe(databaseRow);
    expect(databaseRow).toEqual({
      id: 7,
      nodeSelector: { workload: 'api' },
      nodeAffinity: null,
    });
  });

  it('formats configured model properties in place while preserving unrelated values', () => {
    const modelJson = {
      id: 7,
      nodeSelector: { workload: 'worker' },
      nodeAffinity: null,
    };

    expect(mapper.format(modelJson)).toBe(modelJson);
    expect(modelJson).toEqual({
      id: 7,
      node_selector: { workload: 'worker' },
      node_affinity: null,
    });
  });

  it('does not replace configured fields whose source value is undefined', () => {
    const databaseRow = { node_selector: undefined, nodeSelector: 'existing' };
    const modelJson = { nodeSelector: undefined, node_selector: 'existing' };

    expect(mapper.parse(databaseRow)).toEqual(databaseRow);
    expect(mapper.format(modelJson)).toEqual(modelJson);
  });

  it.each([null, undefined])('passes through a %s input', (value) => {
    expect(mapper.parse(value)).toBe(value);
    expect(mapper.format(value)).toBe(value);
  });
});
