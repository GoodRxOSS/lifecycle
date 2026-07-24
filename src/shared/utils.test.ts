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

import {
  constructUrl,
  determineFeatureFlagValue,
  determineFeatureFlagStatus,
  determineIfFastlyIsUsed,
  enableService,
  constructLinkDictionary,
  constructLinkRow,
  constructLinkTable,
  constructFastlyBuildLink,
  insertBuildLink,
  mergeKeyValueArrays,
  extractEnvVarsWithBuildDependencies,
} from 'shared/utils';

jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({
    error: jest.fn(),
  })),
}));

import { FEATURE_FLAG, MALFORMED_FEATURE_FLAG_BOOLEAN_STRING } from 'shared/__fixtures__/utils';

describe('utils', () => {
  describe('#determineIfFastlyIsUsed', () => {
    test('returns true if fastly is used in deploy', () => {
      const deploy = [{ active: true, uuid: 'fastly-abc123' }];
      expect(determineIfFastlyIsUsed(deploy)).toEqual(true);
    });

    test('returns false if fastly is not used in deploy', () => {
      const deploy = [{ active: true, uuid: 'not-abc123' }];
      expect(determineIfFastlyIsUsed(deploy)).toEqual(false);
    });

    test('returns false if fastly is not used in deploy', () => {
      const deploy = [{ active: false, uuid: 'not-fastly-abc123' }];
      expect(determineIfFastlyIsUsed(deploy)).toEqual(false);
    });
  });

  describe('#constructUrl', () => {
    test('constructs a url with params', () => {
      const url = 'https://example.com';
      const params = [{ name: 'query', value: 'test' }];
      expect(constructUrl(url, params)).toEqual('https://example.com/?query=test');
    });
  });

  describe('#constructLinkDictionary', () => {
    test('returns empty object if no links provided', () => {
      expect(constructLinkDictionary()).toEqual({});
    });

    test('returns object with link name and url', () => {
      const links = [{ name: 'Link 1', url: 'https://example.com/1' }];
      expect(constructLinkDictionary(links)).toEqual({
        'Link 1': 'https://example.com/1',
      });
    });

    test('returns object with multiple links', () => {
      const links = [
        { name: 'Link 1', url: 'https://example.com/1' },
        { name: 'Link 2', url: 'https://example.com/2' },
      ];
      expect(constructLinkDictionary(links)).toEqual({
        'Link 1': 'https://example.com/1',
        'Link 2': 'https://example.com/2',
      });
    });
  });

  describe('#constructLinkRow', () => {
    test('returns empty string if no links provided', () => {
      expect(constructLinkRow()).toEqual('');
    });

    test('returns row with single link', () => {
      const links = [{ name: 'Link 1', url: 'https://example.com/1' }];
      expect(constructLinkRow(links)).toEqual('| Link 1 | https://example.com/1 |\n');
    });

    test('returns row with multiple links', () => {
      const links = [
        { name: 'Link 1', url: 'https://example.com/1' },
        { name: 'Link 2', url: 'https://example.com/2' },
      ];
      expect(constructLinkRow(links)).toEqual(
        '| Link 1 | https://example.com/1 |\n| Link 2 | https://example.com/2 |\n'
      );
    });
  });

  describe('#constructLinkTable', () => {
    test('returns markdown table with single link', () => {
      const links = [{ name: 'Link 1', url: 'https://example.com/1' }];
      expect(constructLinkTable(links)).toEqual(
        `<details>
<summary>Dashboards</summary>

| | Links |
| --- | --- |
| Link 1 | https://example.com/1 |
</details>
`
      );
    });

    test('returns markdown table with multiple links', () => {
      const links = [
        { name: 'Link 1', url: 'https://example.com/1' },
        { name: 'Link 2', url: 'https://example.com/2' },
      ];
      expect(constructLinkTable(links)).toEqual(
        `<details>
<summary>Dashboards</summary>

| | Links |
| --- | --- |
| Link 1 | https://example.com/1 |
| Link 2 | https://example.com/2 |
</details>
`
      );
    });
  });

  describe('#constructFastlyBuildLink', () => {
    test('returns empty array if fastlyBuildId is empty', async () => {
      const fastlyFn = jest.fn();
      expect(await constructFastlyBuildLink('', '', fastlyFn)).toEqual({});
    });

    test('returns link object if fastlyServiceId is returned', async () => {
      const fastlyFn = jest.fn().mockReturnValue({ href: 'https://example.com/1' });
      expect(await constructFastlyBuildLink('abc123', 'name', fastlyFn)).toEqual({
        name: 'Fastly Dashboard',
        url: 'https://example.com/1',
      });
    });

    test('returns empty array if fastlyServiceId is null', async () => {
      const fastlyFn = jest.fn().mockReturnValue(null);
      expect(await constructFastlyBuildLink('abc123', 'name', fastlyFn)).toEqual({});
    });

    test('returns empty array if error is thrown', async () => {
      const fastlyFn = jest.fn().mockImplementation(() => {
        throw new Error('Error!');
      });
      expect(await constructFastlyBuildLink('abc123', 'name', fastlyFn)).toEqual({});
    });
  });

  describe('#insertBuildLink', () => {
    test('inserts link into empty object', () => {
      const buildLinks = {};
      const name = 'Link 1';
      const href = 'https://example.com/1';
      expect(insertBuildLink(buildLinks, name, href)).toEqual({
        'Link 1': 'https://example.com/1',
      });
    });

    test('inserts link into object with existing links', () => {
      const buildLinks = {
        'Link 1': 'https://example.com/1',
      };
      const name = 'Link 2';
      const href = 'https://example.com/2';
      expect(insertBuildLink(buildLinks, name, href)).toEqual({
        'Link 1': 'https://example.com/1',
        'Link 2': 'https://example.com/2',
      });
    });

    test('overwrites link with same name', () => {
      const buildLinks = {
        'Link 1': 'https://example.com/1',
      };
      const name = 'Link 1';
      const href = 'https://example.com/2';
      expect(insertBuildLink(buildLinks, name, href)).toEqual({
        'Link 1': 'https://example.com/2',
      });
    });
  });
});

describe('determineFeatureFlagStatus', () => {
  const features = {
    'feature-1': false,
    'feature-2': true,
    'feature-3': false,
  };
  test('it returns false if feature is not defined', () => {
    const result = determineFeatureFlagStatus('feature-1', features);
    expect(result).toEqual(false);
  });

  test('it returns true if feature is defined', () => {
    const result = determineFeatureFlagStatus('feature-2', features);
    expect(result).toEqual(true);
  });
});

describe('enableService', () => {
  class Svc {
    test: string;
    constructor() {
      this.test = 'foo bar';
    }
  }
  class DB {}
  class Redis {}
  class Redlock {}
  test('it enables a service based on a feature flag', () => {
    const result = enableService(Svc, new DB() as any, new Redis() as any, new Redlock() as any);
    expect(result).toEqual({ test: 'foo bar' });
  });
});

describe('determineFeatureFlagValue', () => {
  test('returns true if everything is set', () => {
    const result = determineFeatureFlagValue('hasTest', FEATURE_FLAG);
    expect(result).toEqual(true);
  });

  test('returns false if featureFlags is not defined', () => {
    const result = determineFeatureFlagValue('hasTest');
    expect(result).toEqual(false);
  });

  test('returns false if the featureFlags item value is not a boolean', () => {
    const result = determineFeatureFlagValue('hasTest', MALFORMED_FEATURE_FLAG_BOOLEAN_STRING as any);
    expect(result).toEqual(false);
  });
});

describe('mergeKeyValueArrays', () => {
  test('should correctly merge arrays with no overlapping keys', () => {
    const baseArray = ['a=1', 'b=2'];
    const overwriteArray = ['c=3', 'd=4'];
    const delimiter = '=';
    expect(mergeKeyValueArrays(baseArray, overwriteArray, delimiter)).toEqual(['a=1', 'b=2', 'c=3', 'd=4']);
  });

  test('should overwrite values from the first array with values from the second array for overlapping keys', () => {
    const baseArray = ['a=1', 'b=2', 'c=3'];
    const overwriteArray = ['b=4', 'd=5'];
    const delimiter = '=';
    expect(mergeKeyValueArrays(baseArray, overwriteArray, delimiter)).toEqual(['a=1', 'b=4', 'c=3', 'd=5']);
  });

  test('should handle different delimiters', () => {
    const baseArray = ['a:1', 'b:2', 'c:3'];
    const overwriteArray = ['b:4', 'd:5'];
    const delimiter = ':';
    expect(mergeKeyValueArrays(baseArray, overwriteArray, delimiter)).toEqual(['a:1', 'b:4', 'c:3', 'd:5']);
  });

  test('should handle empty arrays', () => {
    const baseArray: string[] = [];
    const overwriteArray: string[] = [];
    const delimiter = '=';
    expect(mergeKeyValueArrays(baseArray, overwriteArray, delimiter)).toEqual([]);
  });

  test('should handle one array being empty', () => {
    const baseArray = ['a=1', 'b=2'];
    const overwriteArray: string[] = [];
    const delimiter = '=';
    expect(mergeKeyValueArrays(baseArray, overwriteArray, delimiter)).toEqual(['a=1', 'b=2']);
  });
});

describe('extractEnvVarsWithBuildDependencies', () => {
  test('should extract a single dependency', () => {
    const env = { TEST_VAR: '{{serviceA.buildOutput(.*)}}' };
    const expected = {
      serviceA: [{ pattern: '.*', envKey: 'TEST_VAR' }],
    };

    expect(extractEnvVarsWithBuildDependencies(env)).toEqual(expected);
  });

  test('should extract multiple dependencies from different environment keys', () => {
    const env = {
      VAR1: '{{serviceA.buildOutput(abc)}}',
      VAR2: '{{serviceB.buildOutput(def)}}',
    };

    const expected = {
      serviceA: [{ pattern: 'abc', envKey: 'VAR1' }],
      serviceB: [{ pattern: 'def', envKey: 'VAR2' }],
    };

    expect(extractEnvVarsWithBuildDependencies(env)).toEqual(expected);
  });

  test('should extract multiple dependencies from the same environment variable', () => {
    const env = {
      MULTI_VAR: '{{serviceA.buildOutput(abc)}} {{serviceB.buildOutput(def)}}',
    };

    const expected = {
      serviceA: [{ pattern: 'abc', envKey: 'MULTI_VAR' }],
      serviceB: [{ pattern: 'def', envKey: 'MULTI_VAR' }],
    };

    expect(extractEnvVarsWithBuildDependencies(env)).toEqual(expected);
  });

  test('should return an empty object if no matches are found', () => {
    const env = {
      VAR1: 'NO MATCH HERE',
      VAR2: 'ANOTHER_NON_MATCHING_STRING',
    };

    const expected = {};

    expect(extractEnvVarsWithBuildDependencies(env)).toEqual(expected);
  });

  test('should handle empty and undefined environment variables', () => {
    const env = {
      EMPTY_VAR: '',
      UNDEFINED_VAR: undefined,
      NULL_VAR: null,
    };

    const expected = {};

    expect(extractEnvVarsWithBuildDependencies(env as any)).toEqual(expected);
  });

  test('should handle triple curly braces correctly', () => {
    const env = {
      VAR: '{{{serviceC.buildOutput(xyz)}}}',
    };

    const expected = {
      serviceC: [{ pattern: 'xyz', envKey: 'VAR' }],
    };

    expect(extractEnvVarsWithBuildDependencies(env)).toEqual(expected);
  });
});
