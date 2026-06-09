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

// Jest manual mock for the 'modal' gRPC SDK: providers/modal.ts loads it via a dynamic import
// that @swc/jest transpiles to require(), which jest resolves to this mock automatically.

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export const Probe = {
  withTcp: (port: number) => ({ kind: 'tcp', port }),
};

export const modalMocks = {
  clientCtor: jest.fn(),
  clientClose: jest.fn(),
  appsFromName: jest.fn(),
  secretsFromName: jest.fn(),
  secretsFromObject: jest.fn(),
  imagesFromRegistry: jest.fn(),
  imagesFromId: jest.fn(),
  imagesDelete: jest.fn(),
  sandboxesCreate: jest.fn(),
  sandboxesFromId: jest.fn(),
};

export class ModalClient {
  apps = { fromName: modalMocks.appsFromName };
  secrets = { fromName: modalMocks.secretsFromName, fromObject: modalMocks.secretsFromObject };
  images = {
    fromRegistry: modalMocks.imagesFromRegistry,
    fromId: modalMocks.imagesFromId,
    delete: modalMocks.imagesDelete,
  };
  sandboxes = { create: modalMocks.sandboxesCreate, fromId: modalMocks.sandboxesFromId };

  constructor(params?: unknown) {
    modalMocks.clientCtor(params);
  }

  close(): void {
    modalMocks.clientClose();
  }
}
