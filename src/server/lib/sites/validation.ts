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

import path from 'path';
import zlib from 'zlib';
import { getContentType } from './contentType';

export type SiteUploadFile = {
  path: string;
  content: Buffer;
  sizeBytes: number;
  contentType: string;
};

export type ValidatedSiteUpload = {
  files: SiteUploadFile[];
  fileCount: number;
  sizeBytes: number;
  entrypoint: string;
};

export type SiteUploadValidationOptions = {
  fileName: string;
  content: Buffer;
  maxUploadBytes: number;
  maxExtractedBytes: number;
  maxFiles: number;
  allowedExtensions: string[];
};

export class SiteUploadValidationError extends Error {
  statusCode = 400 as const;
}

function reject(message: string): never {
  throw new SiteUploadValidationError(message);
}

function getFileExtension(fileName: string): string {
  return fileName.split('/').pop()?.split('.').pop()?.toLowerCase() || '';
}

function getAllowedExtension(fileName: string, allowedExtensions: string[]): string {
  const ext = getFileExtension(fileName);
  const allowed = new Set(allowedExtensions.map((extension) => extension.toLowerCase().replace(/^\./, '')));

  if (ext && allowed.has(ext)) {
    return ext;
  }

  reject(`Only these file extensions are supported: ${Array.from(allowed).sort().join(', ')}.`);
}

function normalizeArchivePath(input: string): string {
  const candidate = input.replace(/\\/g, '/');
  if (!candidate || candidate.includes('\0')) {
    reject('Archive contains an invalid path.');
  }

  if (candidate.startsWith('/') || /^[A-Za-z]:\//.test(candidate)) {
    reject('Archive contains an absolute path.');
  }

  const normalized = path.posix.normalize(candidate);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    reject('Archive contains a path traversal entry.');
  }

  return normalized;
}

type ZipEntry = {
  path: string;
  content: Buffer;
  sizeBytes: number;
};

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  reject('Invalid zip: central directory was not found.');
}

function isSymlink(externalAttributes: number): boolean {
  return (((externalAttributes >>> 16) & 0o170000) as number) === 0o120000;
}

function parseZipEntries(buffer: Buffer, maxExtractedBytes: number, maxFiles: number): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (entryCount === 0) {
    reject('Zip upload is empty.');
  }

  if (centralDirectoryOffset + centralDirectorySize > buffer.length) {
    reject('Invalid zip: central directory is out of bounds.');
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  let extractedSize = 0;

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      reject('Invalid zip: central directory entry is malformed.');
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;

    if (nameEnd > buffer.length) {
      reject('Invalid zip: filename is out of bounds.');
    }

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      reject('Zip64 uploads are not supported in v1.');
    }

    if ((flags & 0x1) === 0x1) {
      reject('Encrypted zip uploads are not supported.');
    }

    const rawName = buffer.slice(nameStart, nameEnd);
    const entryName = rawName.toString((flags & 0x800) === 0x800 ? 'utf8' : 'utf8');
    const normalizedPath = normalizeArchivePath(entryName);
    const isDirectory = normalizedPath.endsWith('/') || entryName.endsWith('/');

    if (isSymlink(externalAttributes)) {
      reject('Zip uploads cannot contain symlinks.');
    }

    if (!isDirectory) {
      if (entries.length + 1 > maxFiles) {
        reject(`Zip upload cannot contain more than ${maxFiles} files.`);
      }

      extractedSize += uncompressedSize;
      if (extractedSize > maxExtractedBytes) {
        reject(`Extracted site size must be ${maxExtractedBytes} bytes or less.`);
      }

      if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        reject('Invalid zip: local file header is malformed.');
      }

      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;

      if (dataEnd > buffer.length) {
        reject('Invalid zip: compressed file data is out of bounds.');
      }

      const compressed = buffer.slice(dataStart, dataEnd);
      const content =
        method === 0 ? Buffer.from(compressed) : method === 8 ? zlib.inflateRawSync(compressed) : undefined;

      if (!content) {
        reject('Zip upload contains an unsupported compression method.');
      }

      if (content.length !== uncompressedSize) {
        reject('Invalid zip: extracted file size does not match metadata.');
      }

      entries.push({
        path: normalizedPath,
        content,
        sizeBytes: content.length,
      });
    }

    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

function stripSingleTopLevelFolder(entries: ZipEntry[]): ZipEntry[] {
  const paths = entries.map((entry) => entry.path);
  if (paths.includes('index.html')) {
    return entries;
  }

  const topLevel = new Set(paths.map((entryPath) => entryPath.split('/')[0]));
  if (topLevel.size !== 1) {
    reject('Zip upload must contain index.html at the root or inside one top-level folder.');
  }

  const [folder] = Array.from(topLevel);
  const prefix = `${folder}/`;
  const stripped = entries.map((entry) => ({
    ...entry,
    path: entry.path.startsWith(prefix) ? entry.path.slice(prefix.length) : entry.path,
  }));

  if (!stripped.some((entry) => entry.path === 'index.html')) {
    reject('Zip upload must contain index.html at the root or inside one top-level folder.');
  }

  return stripped;
}

function assertAllowedFilePath(filePath: string, allowedExtensions: string[]) {
  const ext = getFileExtension(filePath);
  const allowed = new Set(allowedExtensions.map((extension) => extension.toLowerCase().replace(/^\./, '')));
  if (!ext || !allowed.has(ext)) {
    reject(`File extension is not supported: ${filePath}`);
  }
}

function singleFileEntrypoint(extension: string): string {
  return extension === 'markdown' ? 'index.markdown' : `index.${extension}`;
}

function finalizeFiles(
  entries: ZipEntry[],
  maxFiles: number,
  maxExtractedBytes: number,
  allowedExtensions: string[],
  entrypoint = 'index.html'
): ValidatedSiteUpload {
  if (entries.length === 0) {
    reject('Upload does not contain any files.');
  }

  if (entries.length > maxFiles) {
    reject(`Site cannot contain more than ${maxFiles} files.`);
  }

  const seen = new Set<string>();
  let sizeBytes = 0;
  const files = entries.map((entry) => {
    const normalizedPath = normalizeArchivePath(entry.path);
    assertAllowedFilePath(normalizedPath, allowedExtensions);
    if (seen.has(normalizedPath)) {
      reject(`Upload contains a duplicate file path: ${normalizedPath}`);
    }
    seen.add(normalizedPath);
    sizeBytes += entry.sizeBytes;
    return {
      path: normalizedPath,
      content: entry.content,
      sizeBytes: entry.sizeBytes,
      contentType: getContentType(normalizedPath),
    };
  });

  if (!seen.has(entrypoint)) {
    reject(`Site must include ${entrypoint}.`);
  }

  if (sizeBytes > maxExtractedBytes) {
    reject(`Extracted site size must be ${maxExtractedBytes} bytes or less.`);
  }

  return {
    files,
    fileCount: files.length,
    sizeBytes,
    entrypoint,
  };
}

export function validateSiteUpload(options: SiteUploadValidationOptions): ValidatedSiteUpload {
  const { fileName, content, maxUploadBytes, maxExtractedBytes, maxFiles, allowedExtensions } = options;
  if (!content.length) {
    reject('Upload file is empty.');
  }

  if (content.length > maxUploadBytes) {
    reject(`Upload size must be ${maxUploadBytes} bytes or less.`);
  }

  const uploadType = getAllowedExtension(fileName, allowedExtensions);

  if (uploadType !== 'zip') {
    const entrypoint = singleFileEntrypoint(uploadType);
    return finalizeFiles(
      [
        {
          path: entrypoint,
          content,
          sizeBytes: content.length,
        },
      ],
      maxFiles,
      maxExtractedBytes,
      allowedExtensions,
      entrypoint
    );
  }

  const entries = stripSingleTopLevelFolder(parseZipEntries(content, maxExtractedBytes, maxFiles));
  return finalizeFiles(entries, maxFiles, maxExtractedBytes, allowedExtensions);
}

export function normalizeGatewayPath(pathname: string): string {
  const rawPath = pathname.split('?')[0] || '/';
  const decoded = decodeURIComponent(rawPath);
  const withoutLeadingSlash = decoded.replace(/^\/+/, '') || 'index.html';
  const normalized = normalizeArchivePath(withoutLeadingSlash);
  return normalized.endsWith('/') ? `${normalized}index.html` : normalized;
}
