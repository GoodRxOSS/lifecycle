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

export function buildGitHubPermalink(
  repository: { owner: string; name: string; branch: string; sha?: string },
  filePath: string,
  lineStart?: number,
  lineEnd?: number
): string {
  const ref = repository.sha || repository.branch;
  const base = `https://github.com/${repository.owner}/${repository.name}/blob/${ref}/${filePath}`;
  if (!lineStart) return base;
  const lineFragment = lineEnd && lineEnd !== lineStart ? `#L${lineStart}-L${lineEnd}` : `#L${lineStart}`;
  return base + lineFragment;
}

export function buildGitHubCommitUrl(owner: string, name: string, sha: string): string {
  return `https://github.com/${owner}/${name}/commit/${sha}`;
}

export function buildGitHubPrUrl(owner: string, name: string, prNumber: number): string {
  return `https://github.com/${owner}/${name}/pull/${prNumber}`;
}

interface Segment {
  text: string;
  isCode: boolean;
}

function splitByCodeFences(markdown: string): Segment[] {
  const segments: Segment[] = [];
  const fencePattern = /```[\s\S]*?```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(markdown)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: markdown.slice(lastIndex, match.index), isCode: false });
    }
    segments.push({ text: match[0], isCode: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < markdown.length) {
    segments.push({ text: markdown.slice(lastIndex), isCode: false });
  }

  return segments;
}

function splitByInlineCode(text: string): Segment[] {
  const segments: Segment[] = [];
  const inlinePattern = /`[^`]+`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlinePattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), isCode: false });
    }
    segments.push({ text: match[0], isCode: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isCode: false });
  }

  return segments;
}

function applyLinkPatterns(text: string, ctx: { owner: string; repo: string; sha: string }): string {
  let result = text;

  const filePathPattern =
    /(?<!\[.*?)(?<!\()(?<![/\w.-])(([\w.-]+\/)+[\w.-]+\.(ts|tsx|js|jsx|yaml|yml|json|md|py|go|rs|rb|java|sh|dockerfile|xml|toml|cfg|ini|env|css|scss|html))(?::(\d+)(?:-(\d+))?)?\b(?!\))/gi;
  result = result.replace(filePathPattern, (_match, filePath, _dir, _ext, lineStart, lineEnd) => {
    let url = `https://github.com/${ctx.owner}/${ctx.repo}/blob/${ctx.sha}/${filePath}`;
    if (lineStart) {
      url += lineEnd && lineEnd !== lineStart ? `#L${lineStart}-L${lineEnd}` : `#L${lineStart}`;
    }
    const display = lineStart
      ? lineEnd && lineEnd !== lineStart
        ? `${filePath}:${lineStart}-${lineEnd}`
        : `${filePath}:${lineStart}`
      : filePath;
    return `[${display}](${url})`;
  });

  const prPattern = /(?<!\[)(?<!\w)#(\d{1,6})(?!\w)(?!\])/g;
  result = result.replace(prPattern, (_match, prNum) => {
    return `[#${prNum}](https://github.com/${ctx.owner}/${ctx.repo}/pull/${prNum})`;
  });

  const shaPattern = /(?<!\[)(?<![/\w])([0-9a-f]{7,40})(?!\w)(?!\])/g;
  result = result.replace(shaPattern, (_match, sha) => {
    if (!/^[0-9a-f]+$/.test(sha) || sha.length < 7) return sha;
    return `[${sha.substring(0, 7)}](https://github.com/${ctx.owner}/${ctx.repo}/commit/${sha})`;
  });

  return result;
}

export function autoLinkGitHubReferences(markdown: string, ctx: { owner: string; repo: string; sha: string }): string {
  const fenceSegments = splitByCodeFences(markdown);

  const processed = fenceSegments.map((segment) => {
    if (segment.isCode) return segment.text;

    const inlineSegments = splitByInlineCode(segment.text);
    return inlineSegments
      .map((sub) => {
        if (sub.isCode) return sub.text;
        return applyLinkPatterns(sub.text, ctx);
      })
      .join('');
  });

  return processed.join('');
}
