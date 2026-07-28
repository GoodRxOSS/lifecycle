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

import { canonicalJson } from '../canonicalJson';

it('orders keys by UTF-16 code units, not locale collation', () => {
  expect(canonicalJson({ a: 1, _x: 2, Z: 3, B: 4 })).toBe('{"B":4,"Z":3,"_x":2,"a":1}');
});

it('serializes nested structures deterministically regardless of insertion order', () => {
  const first = { outer: { b: [1, { d: 2, c: 3 }], a: 'x' }, list: [null, true] };
  const second = { list: [null, true], outer: { a: 'x', b: [1, { c: 3, d: 2 }] } };

  expect(canonicalJson(first)).toBe(canonicalJson(second));
  expect(canonicalJson(first)).toBe('{"list":[null,true],"outer":{"a":"x","b":[1,{"c":3,"d":2}]}}');
});

it('escapes keys and string values as JSON', () => {
  expect(canonicalJson({ 'quo"te': 'va\nlue' })).toBe('{"quo\\"te":"va\\nlue"}');
});

it('distinguishes empty containers and primitives', () => {
  expect(canonicalJson({})).toBe('{}');
  expect(canonicalJson([])).toBe('[]');
  expect(canonicalJson(null)).toBe('null');
  expect(canonicalJson('')).toBe('""');
  expect(canonicalJson(0)).toBe('0');
  expect(canonicalJson(false)).toBe('false');
});
