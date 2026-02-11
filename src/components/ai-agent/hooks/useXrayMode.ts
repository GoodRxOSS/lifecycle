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

import { useState, useRef, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'ai-agent-xray-mode';
const REQUIRED_CLICKS = 6;
const CLICK_WINDOW_MS = 2000;

export function useXrayMode() {
  const [xrayMode, setXrayMode] = useState(false);
  const clickTimestampsRef = useRef<number[]>([]);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored === 'true') {
        setXrayMode(true);
      }
    } catch {
      // sessionStorage not available
    }
  }, []);

  const handleLabelClick = useCallback(() => {
    const now = Date.now();
    const timestamps = clickTimestampsRef.current;
    timestamps.push(now);

    const cutoff = now - CLICK_WINDOW_MS;
    clickTimestampsRef.current = timestamps.filter((t) => t > cutoff);

    if (clickTimestampsRef.current.length >= REQUIRED_CLICKS) {
      clickTimestampsRef.current = [];
      setXrayMode((prev) => {
        const next = !prev;
        try {
          sessionStorage.setItem(STORAGE_KEY, String(next));
        } catch {
          // sessionStorage not available
        }
        return next;
      });
    }
  }, []);

  return { xrayMode, handleLabelClick };
}
