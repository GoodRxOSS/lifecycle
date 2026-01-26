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

import { StreamCallbacks } from '../types/stream';
import { JSONBuffer } from './jsonBuffer';
import { getLogger } from 'server/lib/logger';

export class ResponseHandler {
  private jsonBuffer: JSONBuffer;
  private isJsonResponse: boolean = false;
  private textBuffer: string = '';
  private buildUuid?: string;

  constructor(private callbacks: StreamCallbacks, buildUuid?: string) {
    this.jsonBuffer = new JSONBuffer();
    this.buildUuid = buildUuid;
  }

  handleChunk(text: string): void {
    if (!this.isJsonResponse && this.isJsonStart(this.textBuffer + text)) {
      this.isJsonResponse = true;
      getLogger().info(`AI: JSON response detected buildUuid=${this.buildUuid || 'none'}`);
      this.callbacks.onThinking('Generating structured report...');
      // Include any buffered text that was part of the JSON start
      if (this.textBuffer) {
        this.jsonBuffer.append(this.textBuffer);
        this.textBuffer = '';
      }
      this.jsonBuffer.append(text);
      this.callbacks.onTextChunk(text);
      return;
    }

    if (this.isJsonResponse) {
      this.jsonBuffer.append(text);
      this.callbacks.onTextChunk(text);

      if (this.jsonBuffer.isComplete()) {
        getLogger().info(`AI: JSON response complete buildUuid=${this.buildUuid || 'none'}`);
        const parsed = this.jsonBuffer.parse();
        if (parsed) {
          getLogger().info(`AI: structured output parsed type=${parsed.type} buildUuid=${this.buildUuid || 'none'}`);
        } else {
          getLogger().warn(`AI: JSON parse failed buildUuid=${this.buildUuid || 'none'}`);
        }
      }
      return;
    }

    this.textBuffer += text;
    this.callbacks.onTextChunk(text);
  }

  private isJsonStart(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.startsWith('{') && trimmed.includes('"type"');
  }

  getResult(): { response: string; isJson: boolean } {
    if (this.isJsonResponse) {
      return {
        response: this.jsonBuffer.getContent(),
        isJson: true,
      };
    }

    return {
      response: this.textBuffer,
      isJson: false,
    };
  }
}
