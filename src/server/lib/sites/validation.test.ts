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

import zlib from 'zlib';
import { normalizeGatewayPath, validateSiteUpload } from './validation';

const DEFAULT_OPTIONS = {
  maxUploadBytes: 100 * 1024 * 1024,
  maxExtractedBytes: 100 * 1024 * 1024,
  maxFiles: 500,
  allowedExtensions: ['html', 'zip', 'json', 'md', 'markdown', 'txt', 'js'],
};

function zip(entries: Record<string, string>, declaredSizeByPath: Record<string, number> = {}): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [entryPath, value] of Object.entries(entries)) {
    const name = Buffer.from(entryPath);
    const content = Buffer.from(value);
    const compressed = zlib.deflateRawSync(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSizeByPath[entryPath] ?? content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0o100644 * 0x10000, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

describe('validateSiteUpload', () => {
  it('accepts a single html file as index.html', () => {
    const result = validateSiteUpload({
      ...DEFAULT_OPTIONS,
      fileName: 'demo.html',
      content: Buffer.from('<html>ok</html>'),
    });

    expect(result.fileCount).toBe(1);
    expect(result.files[0].path).toBe('index.html');
    expect(result.entrypoint).toBe('index.html');
  });

  it('accepts safe single-file document uploads as the root entrypoint', () => {
    const result = validateSiteUpload({
      ...DEFAULT_OPTIONS,
      fileName: 'data.json',
      content: Buffer.from('{"ok":true}'),
    });

    expect(result.fileCount).toBe(1);
    expect(result.files[0].path).toBe('index.json');
    expect(result.entrypoint).toBe('index.json');
  });

  it('accepts and strips a single top-level zip folder', () => {
    const result = validateSiteUpload({
      ...DEFAULT_OPTIONS,
      fileName: 'demo.zip',
      content: zip({
        'dist/index.html': '<html>ok</html>',
        'dist/assets/app.js': 'console.log("ok")',
      }),
    });

    expect(result.files.map((file) => file.path).sort()).toEqual(['assets/app.js', 'index.html']);
    expect(result.entrypoint).toBe('index.html');
  });

  it('rejects traversal entries', () => {
    expect(() =>
      validateSiteUpload({
        ...DEFAULT_OPTIONS,
        fileName: 'demo.zip',
        content: zip({
          'dist/index.html': '<html>ok</html>',
          '../secret.txt': 'no',
        }),
      })
    ).toThrow('path traversal');
  });

  it('enforces upload and extracted size limits', () => {
    expect(() =>
      validateSiteUpload({
        ...DEFAULT_OPTIONS,
        fileName: 'demo.html',
        maxUploadBytes: 2,
        content: Buffer.from('too large'),
      })
    ).toThrow('Upload size');

    expect(() =>
      validateSiteUpload({
        ...DEFAULT_OPTIONS,
        fileName: 'demo.zip',
        maxExtractedBytes: 4,
        content: zip({ 'index.html': '<html>too large</html>' }),
      })
    ).toThrow('Extracted site size');
  });

  it('caps actual inflated content even when zip metadata understates size', () => {
    expect(() =>
      validateSiteUpload({
        ...DEFAULT_OPTIONS,
        fileName: 'demo.zip',
        maxExtractedBytes: 4,
        content: zip({ 'index.html': '<html>too large</html>' }, { 'index.html': 1 }),
      })
    ).toThrow(/Extracted site size|Invalid zip/);
  });

  it('rejects unsupported single-file and zip entry extensions', () => {
    expect(() =>
      validateSiteUpload({
        ...DEFAULT_OPTIONS,
        fileName: 'demo.sh',
        content: Buffer.from('echo no'),
      })
    ).toThrow('Only these file extensions');

    expect(() =>
      validateSiteUpload({
        ...DEFAULT_OPTIONS,
        fileName: 'demo.zip',
        content: zip({ 'index.html': '<html>ok</html>', 'run.sh': 'echo no' }),
      })
    ).toThrow('File extension is not supported');
  });
});

describe('normalizeGatewayPath', () => {
  it('normalizes root and rejects traversal paths', () => {
    expect(normalizeGatewayPath('/')).toBe('index.html');
    expect(normalizeGatewayPath('/docs/')).toBe('docs/index.html');
    expect(() => normalizeGatewayPath('/../secret.txt')).toThrow('path traversal');
  });
});
