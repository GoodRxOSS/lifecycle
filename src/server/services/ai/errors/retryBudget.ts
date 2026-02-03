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

export class RetryBudget {
  private readonly maxRetries: number;
  private remaining: number;

  constructor(maxRetries: number = 10) {
    this.maxRetries = maxRetries;
    this.remaining = maxRetries;
  }

  canRetry(): boolean {
    return this.remaining > 0;
  }

  consume(): void {
    if (this.remaining > 0) {
      this.remaining--;
    }
  }

  get exhausted(): boolean {
    return this.remaining <= 0;
  }

  get used(): number {
    return this.maxRetries - this.remaining;
  }

  reset(): void {
    this.remaining = this.maxRetries;
  }
}
