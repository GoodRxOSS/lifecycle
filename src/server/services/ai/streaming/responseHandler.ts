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
import rootLogger from 'server/lib/logger';

const logger = rootLogger.child({ component: 'AIAgentResponseHandler' });

export class ResponseHandler {
  private jsonBuffer: JSONBuffer;
  private isJsonResponse: boolean = false;
  private textBuffer: string = '';
  private logger: typeof logger;

  constructor(private callbacks: StreamCallbacks, buildUuid?: string) {
    this.jsonBuffer = new JSONBuffer();
    this.logger = buildUuid
      ? rootLogger.child({ component: 'AIAgentResponseHandler', buildUuid })
      : rootLogger.child({ component: 'AIAgentResponseHandler' });
  }

  handleChunk(text: string): void {
    if (!this.isJsonResponse && this.isJsonStart(text)) {
      this.isJsonResponse = true;
      this.logger.info('Detected JSON response start, switching to JSON buffering mode');
      this.callbacks.onThinking('Generating structured report...');
      this.jsonBuffer.append(text);
      return;
    }

    if (this.isJsonResponse) {
      this.jsonBuffer.append(text);

      if (this.jsonBuffer.isComplete()) {
        this.logger.info('JSON response complete, parsing structured output');
        const parsed = this.jsonBuffer.parse();
        if (parsed) {
          this.logger.info(`Parsed structured output of type: ${parsed.type}`);
          this.callbacks.onStructuredOutput(parsed);
        } else {
          this.logger.warn('Failed to parse completed JSON buffer');
        }
      }
      return;
    }

    this.textBuffer += text;
    this.callbacks.onTextChunk(text);
  }

  private isJsonStart(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.startsWith('{"type":') || trimmed.startsWith('{\n  "type":');
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
