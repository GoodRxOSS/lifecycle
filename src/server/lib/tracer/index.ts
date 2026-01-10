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

import { Span, tracer, TracerOptions } from 'dd-trace';
import rootLogger from 'server/lib/logger';

export const logger = rootLogger.child({
  filename: 'lib/tracer/index.ts',
});

// Refer to the readme for insights

export class Tracer {
  private static instance: Tracer;
  private isInitialized = false;
  private tags: TracerTags = {};

  private constructor() {
    if (Tracer.instance) {
      const errorMsg = 'This class is a singleton!';
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
    Tracer.instance = this;
  }

  public static getInstance(): Tracer {
    if (!Tracer.instance) {
      Tracer.instance = new Tracer();
    }
    return Tracer.instance;
  }

  public initialize(name: string, tags: TracerTags = {}): Tracer {
    try {
      if (!name) throw new Error('Tracer name is required');
      if (this.isInitialized) {
        this.updateTags(tags);
      } else {
        this.tags = { name, ...tags };
        if (typeof tracer?.startSpan === 'function') {
          const span = tracer.startSpan(name, { tags: this.tags });
          if (typeof tracer?.scope === 'function') {
            tracer.scope().activate(span, () => {
              span.finish();
            });
          } else {
            span.finish();
          }
        }
        this.isInitialized = true;
      }
      return this;
    } catch (error) {
      logger.error(`[Tracer][initialize] error: ${error}`);
      return this;
    }
  }

  public wrap(name, fn, tags: TracerTags = {}): Function {
    if (typeof tracer?.wrap !== 'function') return fn;
    const updatedTags = { ...this.tags, ...tags };
    return tracer.wrap(name, updatedTags, fn);
  }

  public trace(name: string, fn, tags: TracerTags = {}): Function {
    if (typeof tracer?.trace !== 'function') return fn;
    const updatedTags = { ...this.tags, ...tags };
    return tracer.trace(name, updatedTags, fn);
  }

  public startSpan(name: string, tags: TracerTags = {}): Span | undefined {
    if (typeof tracer?.startSpan !== 'function') return undefined;
    const updatedTags = { ...this.tags, ...tags };
    return tracer.startSpan(name, { tags: updatedTags });
  }

  public updateTags(tags: TracerTags): void {
    this.tags = { ...this.tags, ...tags };
  }

  public static Trace(): Function {
    return function (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor): any {
      const originalMethod = descriptor?.value;
      const profiler = Tracer.getInstance();
      descriptor.value = function (...args: any[]) {
        if (!profiler.isInitialized || typeof tracer?.trace !== 'function') {
          return originalMethod.apply(this, args);
        }
        const spanOptions = { tags: { ...profiler.tags, decorator: 'Trace' } };
        return tracer.trace(propertyKey.toString(), spanOptions, () => {
          try {
            return originalMethod.apply(this, args);
          } catch (error) {
            if (typeof tracer?.scope === 'function') {
              tracer.scope().active()?.setTag('error', true);
            }
            logger
              .child({ target, descriptor, error })
              .error(`[Tracer][Trace] error decorating ${propertyKey.toString()}`);
            throw error;
          }
        });
      };
      return descriptor;
    };
  }
}

export type TracerTags = TracerOptions['tags'];

export default Tracer;
