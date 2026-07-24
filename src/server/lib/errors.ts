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

export class LifecycleError extends Error {
  uuid: string | null;
  service: string | null;

  constructor(uuid: string | null, service: string | null, msg: string) {
    super(msg);

    this.uuid = uuid;
    this.service = service;
  }

  public getMessage(): string {
    let message = '';

    if (this.uuid != null) {
      message += `[${this.uuid}] `;
    } else if (this.service != null) {
      message += `[${this.service}] `;
    }

    message += this.message;

    return message;
  }
}
