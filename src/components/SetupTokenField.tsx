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
import React from 'react';

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  marginTop: 4,
  padding: '0.7em',
  borderRadius: 8,
  border: '1px solid #ddd',
  fontSize: '1rem',
  marginBottom: 2,
};

type SetupTokenFieldProps = {
  value: string;
  onChange: (value: string) => void;
};

export function SetupTokenField({ value, onChange }: SetupTokenFieldProps) {
  return (
    <div style={{ marginBottom: 18 }}>
      <label style={{ fontWeight: 500 }}>
        Setup token <span style={{ color: 'red' }}>*</span>
        <input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          autoComplete="off"
          style={INPUT_STYLE}
        />
      </label>
      <div style={{ fontSize: 13, lineHeight: '18px', minHeight: 18, color: '#666', marginTop: 4 }}>
        Use the operator token from <code>LIFECYCLE_SETUP_TOKEN</code> or the setup instructions.
      </div>
    </div>
  );
}
