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

import { getLogger } from 'server/lib/logger';

export class JSONBuffer {
  private buffer: string = '';
  private complete: boolean = false;

  append(text: string): void {
    this.buffer += text;

    if (this.buffer.trim().endsWith('}')) {
      const openBraces = (this.buffer.match(/{/g) || []).length;
      const closeBraces = (this.buffer.match(/}/g) || []).length;

      if (openBraces === closeBraces) {
        this.complete = true;
      }
    }
  }

  isComplete(): boolean {
    return this.complete;
  }

  parse(): any | null {
    if (!this.complete) {
      return null;
    }

    try {
      return JSON.parse(this.buffer);
    } catch (error: any) {
      getLogger().error(`JSONBuffer: parse failed bufferLength=${this.buffer.length} error=${error?.message}`);
      return null;
    }
  }

  getContent(): string {
    return this.buffer;
  }
}
