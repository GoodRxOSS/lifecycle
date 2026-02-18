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

function cleanPreamble(text: string): string {
  return stripCodeFence(text).trim();
}

export class ResponseHandler {
  private jsonBuffer: JSONBuffer;
  private isJsonResponse: boolean = false;
  private textBuffer: string = '';
  private plainTextResponse: string = '';
  private preambleText: string = '';
  private buildUuid?: string;

  constructor(private callbacks: StreamCallbacks, buildUuid?: string) {
    this.jsonBuffer = new JSONBuffer();
    this.buildUuid = buildUuid;
  }

  private appendPreamble(text: string): void {
    const cleaned = cleanPreamble(text);
    if (!cleaned) return;
    this.preambleText = this.preambleText ? `${this.preambleText}\n${cleaned}` : cleaned;
  }

  private emitTextChunk(text: string): void {
    if (!text) return;
    this.plainTextResponse += text;
    this.callbacks.onTextChunk(text);
  }

  private isPotentialJsonPrefix(text: string): boolean {
    const trimmed = text.trimStart();
    if (!trimmed) return true;

    if (trimmed.startsWith('```')) {
      if (/```(?:json)?\s*\n?\s*\{/.test(trimmed)) return true;
      return !trimmed.includes('```', 3);
    }

    if (!trimmed.startsWith('{')) return false;
    if (trimmed.includes('"type"')) return false;
    if (trimmed.includes('}') && !trimmed.includes('"type"')) return false;

    const afterBrace = trimmed.slice(1);
    if (afterBrace.length === 0) return true;
    if (/^\s*$/.test(afterBrace)) return true;
    if (/^\s*[\r\n]/.test(afterBrace)) return true;
    if (/^\s*"/.test(afterBrace)) return true;
    return false;
  }

  private findJsonBoundary(text: string): number {
    const fenceMatch = text.match(/```(?:json)?\s*\n?\s*\{/);
    if (fenceMatch && fenceMatch.index !== undefined) {
      return fenceMatch.index;
    }
    const braceIdx = text.indexOf('{');
    if (braceIdx >= 0) {
      const tail = text.substring(braceIdx);
      if (text.includes('"type"') || this.isPotentialJsonPrefix(tail)) {
        return braceIdx;
      }
    }
    return -1;
  }

  handleChunk(text: string): void {
    if (this.isJsonResponse) {
      this.jsonBuffer.append(text);

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
    const combined = this.textBuffer;

    if (this.isJsonStart(combined)) {
      this.isJsonResponse = true;
      getLogger().info(`AI: JSON response detected buildUuid=${this.buildUuid || 'none'}`);
      this.callbacks.onThinking('Generating structured report...');

      const boundary = this.findJsonBoundary(combined);
      const preamble = boundary > 0 ? combined.substring(0, boundary) : '';
      if (preamble.trim()) {
        this.appendPreamble(preamble);
        this.emitTextChunk(preamble);
      }

      const stripped = stripCodeFence(combined);
      const jsonIdx = stripped.indexOf('{');
      const jsonContent = jsonIdx >= 0 ? stripped.substring(jsonIdx) : stripped;
      this.jsonBuffer.append(jsonContent);
      this.textBuffer = '';
      return;
    }

    const boundary = this.findJsonBoundary(combined);
    if (boundary > 0) {
      const preamble = combined.substring(0, boundary);
      if (preamble.trim()) {
        this.appendPreamble(preamble);
        this.emitTextChunk(preamble);
      }
      this.textBuffer = combined.substring(boundary);
      return;
    }

    if (this.isPotentialJsonPrefix(combined)) {
      return;
    }

    this.emitTextChunk(combined);
    this.textBuffer = '';
  }

  private isJsonStart(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.includes('"type"')) return true;
    if (/```(?:json)?\s*\n?\s*\{/.test(trimmed) && trimmed.includes('"type"')) return true;
    const stripped = stripCodeFence(trimmed);
    const braceIdx = stripped.indexOf('{');
    if (braceIdx >= 0 && stripped.includes('"type"')) return true;
    return false;
  }

  getResult(): { response: string; isJson: boolean; preamble?: string } {
    if (this.isJsonResponse) {
      const content = stripCodeFence(this.jsonBuffer.getContent()).trim();
      return {
        response: content,
        isJson: true,
        ...(this.preambleText ? { preamble: this.preambleText } : {}),
      };
    }

    return {
      response: this.plainTextResponse + this.textBuffer,
      isJson: false,
    };
  }
}
