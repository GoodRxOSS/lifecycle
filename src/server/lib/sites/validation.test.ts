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
import { normalizeGatewayPath, SiteUploadValidationError, validateSiteUpload } from './validation';

const DEFAULT_OPTIONS = {
  maxUploadBytes: 10 * 1024 * 1024,
  maxExtractedBytes: 10 * 1024 * 1024,
  maxFiles: 500,
  allowedExtensions: ['html', 'zip', 'json', 'md', 'markdown', 'txt', 'js'],
};

function zip(
  entries: Record<string, string>,
  declaredSizeByPath: Record<string, number> = {},
  compressionMethod: 0 | 8 = 8
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [entryPath, value] of Object.entries(entries)) {
    const name = Buffer.from(entryPath);
    const content = Buffer.from(value);
    const compressed = compressionMethod === 0 ? content : zlib.deflateRawSync(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(compressionMethod, 8);
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
    central.writeUInt16LE(compressionMethod, 10);
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

function mutateFirstCentralEntry(archive: Buffer, mutate: (buffer: Buffer, offset: number) => void): Buffer {
  const result = Buffer.from(archive);
  const eocdOffset = result.length - 22;
  const centralDirectoryOffset = result.readUInt32LE(eocdOffset + 16);
  mutate(result, centralDirectoryOffset);
  return result;
}

function validateZip(content: Buffer, overrides: Partial<typeof DEFAULT_OPTIONS> = {}) {
  return validateSiteUpload({
    ...DEFAULT_OPTIONS,
    ...overrides,
    fileName: 'demo.zip',
    content,
  });
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

  it('normalizes configured extensions and preserves the markdown entrypoint convention', () => {
    const result = validateSiteUpload({
      ...DEFAULT_OPTIONS,
      fileName: 'README.MARKDOWN',
      content: Buffer.from('# Hello'),
      allowedExtensions: ['.HTML', '.MARKDOWN'],
    });

    expect(result).toMatchObject({
      entrypoint: 'index.markdown',
      fileCount: 1,
      sizeBytes: 7,
    });
    expect(result.files[0]).toMatchObject({
      path: 'index.markdown',
      sizeBytes: 7,
      contentType: 'text/markdown; charset=utf-8',
    });
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

  it('accepts stored zip entries and ignores directory records', () => {
    const result = validateZip(
      zip(
        {
          'dist/': '',
          'dist/index.html': '<html>stored</html>',
        },
        {},
        0
      )
    );

    expect(result.files).toHaveLength(1);
    expect(result.files[0].content.toString()).toBe('<html>stored</html>');
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

  it.each([
    ['', 'invalid path'],
    ['bad\0name.html', 'invalid path'],
    ['/index.html', 'absolute path'],
    ['C:\\index.html', 'absolute path'],
  ])('rejects unsafe archive path %p', (entryPath, message) => {
    expect(() => validateZip(zip({ [entryPath]: 'unsafe' }))).toThrow(message);
  });

  it('returns a typed 400 validation error', () => {
    let error: unknown;
    try {
      validateSiteUpload({ ...DEFAULT_OPTIONS, fileName: 'empty.html', content: Buffer.alloc(0) });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SiteUploadValidationError);
    expect(error).toMatchObject({ statusCode: 400, message: 'Upload file is empty.' });
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

  it('enforces final file-count and extracted-size limits for single-file uploads', () => {
    expect(() =>
      validateSiteUpload({
        ...DEFAULT_OPTIONS,
        fileName: 'demo.html',
        maxFiles: 0,
        content: Buffer.from('x'),
      })
    ).toThrow('Site cannot contain more than 0 files.');

    expect(() =>
      validateSiteUpload({
        ...DEFAULT_OPTIONS,
        fileName: 'demo.html',
        maxExtractedBytes: 1,
        content: Buffer.from('xx'),
      })
    ).toThrow('Extracted site size must be 1 bytes or less.');
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

  it('caps actual stored content when zip metadata understates its size', () => {
    expect(() => validateZip(zip({ 'index.html': '12345' }, { 'index.html': 1 }, 0), { maxExtractedBytes: 4 })).toThrow(
      'Extracted site size must be 4 bytes or less.'
    );
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

  it('rejects archives without a root or single-folder index', () => {
    expect(() => validateZip(zip({ 'about.html': 'about' }))).toThrow(
      'Zip upload must contain index.html at the root or inside one top-level folder.'
    );
    expect(() => validateZip(zip({ 'one/about.html': 'about', 'two/contact.html': 'contact' }))).toThrow(
      'Zip upload must contain index.html at the root or inside one top-level folder.'
    );
  });

  it('rejects duplicate normalized paths', () => {
    expect(() => validateZip(zip({ 'index.html': 'first', './index.html': 'second' }))).toThrow(
      'Upload contains a duplicate file path: index.html'
    );
  });

  it('rejects a non-zip payload and an empty zip', () => {
    expect(() => validateZip(Buffer.from('not a zip'))).toThrow('central directory was not found');
    expect(() => validateZip(zip({}))).toThrow('Zip upload is empty.');
  });

  it('rejects central directory bounds and record corruption', () => {
    const archive = zip({ 'index.html': 'ok' });
    const outOfBounds = Buffer.from(archive);
    const eocdOffset = outOfBounds.length - 22;
    outOfBounds.writeUInt32LE(outOfBounds.length, eocdOffset + 16);
    outOfBounds.writeUInt32LE(1, eocdOffset + 12);
    expect(() => validateZip(outOfBounds)).toThrow('central directory is out of bounds');

    const truncatedRecord = Buffer.from(archive);
    const truncatedEocdOffset = truncatedRecord.length - 22;
    truncatedRecord.writeUInt32LE(truncatedRecord.length - 1, truncatedEocdOffset + 16);
    truncatedRecord.writeUInt32LE(0, truncatedEocdOffset + 12);
    expect(() => validateZip(truncatedRecord)).toThrow('central directory entry is malformed');

    const badSignature = mutateFirstCentralEntry(archive, (buffer, offset) => buffer.writeUInt32LE(0, offset));
    expect(() => validateZip(badSignature)).toThrow('central directory entry is malformed');
  });

  it('rejects invalid central directory entry metadata', () => {
    const archive = zip({ 'index.html': 'ok' });

    const longName = mutateFirstCentralEntry(archive, (buffer, offset) => buffer.writeUInt16LE(0xffff, offset + 28));
    expect(() => validateZip(longName)).toThrow('filename is out of bounds');

    for (const fieldOffset of [20, 24]) {
      const zip64 = mutateFirstCentralEntry(archive, (buffer, offset) =>
        buffer.writeUInt32LE(0xffffffff, offset + fieldOffset)
      );
      expect(() => validateZip(zip64)).toThrow('Zip64 uploads are not supported');
    }

    const encrypted = mutateFirstCentralEntry(archive, (buffer, offset) => buffer.writeUInt16LE(0x801, offset + 8));
    expect(() => validateZip(encrypted)).toThrow('Encrypted zip uploads are not supported');

    const symlink = mutateFirstCentralEntry(archive, (buffer, offset) =>
      buffer.writeUInt32LE(0o120777 * 0x10000, offset + 38)
    );
    expect(() => validateZip(symlink)).toThrow('Zip uploads cannot contain symlinks');
  });

  it('rejects archives that exceed the file limit', () => {
    expect(() => validateZip(zip({ 'index.html': 'ok', 'app.js': 'code' }), { maxFiles: 1 })).toThrow(
      'Zip upload cannot contain more than 1 files.'
    );
  });

  it('rejects corrupt local file records and compressed payloads', () => {
    const archive = zip({ 'index.html': 'ok' });

    const badLocalSignature = Buffer.from(archive);
    badLocalSignature.writeUInt32LE(0, 0);
    expect(() => validateZip(badLocalSignature)).toThrow('local file header is malformed');

    const localOutOfBounds = mutateFirstCentralEntry(archive, (buffer, offset) =>
      buffer.writeUInt32LE(buffer.length, offset + 42)
    );
    expect(() => validateZip(localOutOfBounds)).toThrow('local file header is malformed');

    const dataOutOfBounds = mutateFirstCentralEntry(archive, (buffer, offset) =>
      buffer.writeUInt32LE(buffer.length, offset + 20)
    );
    expect(() => validateZip(dataOutOfBounds)).toThrow('compressed file data is out of bounds');

    const unsupportedMethod = mutateFirstCentralEntry(archive, (buffer, offset) =>
      buffer.writeUInt16LE(99, offset + 10)
    );
    expect(() => validateZip(unsupportedMethod)).toThrow('unsupported compression method');
  });

  it('rejects extracted content whose size disagrees with metadata', () => {
    expect(() => validateZip(zip({ 'index.html': 'abc' }, { 'index.html': 4 }, 0))).toThrow(
      'extracted file size does not match metadata'
    );
  });

  it('distinguishes extraction limit failures from corrupt compressed data', () => {
    const archive = zip({ 'index.html': 'ok' });
    const inflate = jest.spyOn(zlib, 'inflateRawSync');

    inflate.mockImplementationOnce(() => {
      throw new Error('maxOutputLength exceeded');
    });
    expect(() => validateZip(archive)).toThrow('Extracted site size');

    inflate.mockImplementationOnce(() => {
      throw new Error('invalid compressed stream');
    });
    expect(() => validateZip(archive)).toThrow('compressed file data could not be extracted');

    inflate.mockRestore();
  });
});

describe('normalizeGatewayPath', () => {
  it('normalizes root and rejects traversal paths', () => {
    expect(normalizeGatewayPath('/')).toBe('index.html');
    expect(normalizeGatewayPath('/docs/')).toBe('docs/index.html');
    expect(() => normalizeGatewayPath('/../secret.txt')).toThrow('path traversal');
  });

  it('decodes paths, strips query strings, and normalizes repeated leading slashes', () => {
    expect(normalizeGatewayPath('///docs/My%20Page.html?preview=true')).toBe('docs/My Page.html');
  });
});
