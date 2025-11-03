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

import React, { useState } from 'react';

const SchemaValidatorPage = () => {
  const [yaml, setYaml] = useState('');
  const [result, setResult] = useState<{ valid: boolean; error: string[] | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState(false);

  const handleChange = async (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setYaml(value);
    setTouched(true);
    if (!value) {
      setResult(null);
      return;
    }
    setLoading(true);
    try {
      const encodeBase64 = (str: string) => {
        return Buffer.from(str, 'utf-8').toString('base64');
      };
      const encodedContent = encodeBase64(value);
      const res = await fetch('/api/v1/schema/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: encodedContent, source: 'content' }),
      });
      const data = await res.json();
      setResult({ valid: data.valid, error: data.error });
    } catch (err) {
      console.error(err);
      setResult({ valid: false, error: ['Could not reach validation API.'] });
    } finally {
      setLoading(false);
    }
  };

  let borderColor = '#D1D5DB';
  if (touched && result) {
    borderColor = result.valid ? '#22C55E' : '#EF4444'; // green-500 or red-500
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        border: '1px solidrgb(0, 85, 255)',
        display: 'flex',
        flexDirection: 'row',
        fontFamily: "'Inter', 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif",
        background: '#f9fafb',
      }}
    >
      <div
        style={{
          flex: 2,
          display: 'flex',
          flexDirection: 'column',
          padding: '2em',
          borderRight: '1px solid #e5e7eb',
          background: '#fff',
        }}
      >
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '1em' }}>Schema Validation</h2>
        <textarea
          value={yaml}
          onChange={handleChange}
          placeholder="Paste or type your YAML schema here..."
          style={{
            width: '90%',
            height: '100%',
            fontFamily: 'monospace',
            fontSize: 16,
            padding: '1em',
            border: `2px solid ${borderColor}`,
            borderRadius: 8,
            background: '#f3f4f6',
            outline: 'none',
            transition: 'border-color 0.2s',
          }}
        />
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          padding: '2em',
          background: '#f9fafb',
        }}
      >
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '1em' }}>Result</h2>
        {loading ? (
          <div style={{ color: '#888', fontSize: 16 }}>Validating...</div>
        ) : result ? (
          result.valid ? (
            <div style={{ color: '#22C55E', fontWeight: 600, fontSize: 18 }}>Schema is valid ✅</div>
          ) : (
            <div>
              <div style={{ color: '#EF4444', fontWeight: 600, fontSize: 18, marginBottom: 8 }}>
                Schema is invalid ❌
              </div>
              {result.error && (
                <ul style={{ color: '#b91c1c', fontSize: 15, paddingLeft: 18 }}>
                  {Array.isArray(result.error) ? (
                    result.error.map((err, idx) => <li key={idx}>{err}</li>)
                  ) : typeof result.error === 'string' ? (
                    <li>{result.error}</li>
                  ) : null}
                </ul>
              )}
            </div>
          )
        ) : (
          <div style={{ color: '#888', fontSize: 16 }}>Paste a YAML schema to validate.</div>
        )}
      </div>
    </div>
  );
};

export default SchemaValidatorPage;
