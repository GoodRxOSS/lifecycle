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

function stripCodeFence(text: string): string {
  return text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '');
}

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
      // Strip fences and preamble, then buffer only the JSON portion
      const combined = this.textBuffer + text;
      const stripped = stripCodeFence(combined);
      const jsonIdx = stripped.indexOf('{');
      const jsonContent = jsonIdx >= 0 ? stripped.substring(jsonIdx) : stripped;
      this.textBuffer = '';
      this.jsonBuffer.append(jsonContent);
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
    // Direct JSON start
    if (trimmed.startsWith('{') && trimmed.includes('"type"')) return true;
    // Markdown-fenced JSON: ```json\n{ or ```\n{
    if (/```(?:json)?\s*\n?\s*\{/.test(trimmed) && trimmed.includes('"type"')) return true;
    // Preamble text followed by fenced JSON containing "type"
    const stripped = stripCodeFence(trimmed);
    const braceIdx = stripped.indexOf('{');
    if (braceIdx >= 0 && stripped.includes('"type"')) return true;
    return false;
  }

  getResult(): { response: string; isJson: boolean } {
    if (this.isJsonResponse) {
      const content = stripCodeFence(this.jsonBuffer.getContent()).trim();
      return {
        response: content,
        isJson: true,
      };
    }

    return {
      response: this.textBuffer,
      isJson: false,
    };
  }
}
