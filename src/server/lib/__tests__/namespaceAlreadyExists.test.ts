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

import { isNamespaceAlreadyExistsError } from 'server/lib/kubernetes';

describe('isNamespaceAlreadyExistsError', () => {
  it('detects a 409 on the error itself', () => {
    expect(isNamespaceAlreadyExistsError({ statusCode: 409 })).toBe(true);
    expect(isNamespaceAlreadyExistsError({ code: 409 })).toBe(true);
  });

  it('detects a 409 on a nested response', () => {
    expect(isNamespaceAlreadyExistsError({ response: { statusCode: 409 } })).toBe(true);
  });

  it('detects the AlreadyExists reason regardless of status code', () => {
    expect(isNamespaceAlreadyExistsError({ body: { reason: 'AlreadyExists' } })).toBe(true);
    expect(isNamespaceAlreadyExistsError({ response: { body: { reason: 'AlreadyExists' } } })).toBe(true);
  });

  it('does not treat other errors as already-exists', () => {
    expect(isNamespaceAlreadyExistsError({ statusCode: 500 })).toBe(false);
    expect(isNamespaceAlreadyExistsError({ body: { reason: 'Forbidden' } })).toBe(false);
    expect(isNamespaceAlreadyExistsError(new Error('boom'))).toBe(false);
    expect(isNamespaceAlreadyExistsError(null)).toBe(false);
    expect(isNamespaceAlreadyExistsError(undefined)).toBe(false);
  });
});
