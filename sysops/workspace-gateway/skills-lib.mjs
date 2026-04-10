import { readFile } from 'node:fs/promises';
import { resolve, relative, sep, basename, dirname } from 'node:path';

export const WORKSPACE_ROOT = resolve(process.env.LIFECYCLE_SESSION_WORKSPACE || '/workspace');
export const SESSION_HOME_ROOT = resolve(
  process.env.LIFECYCLE_SESSION_HOME || process.env.HOME || '/home/agent/.lifecycle-session'
);
export const SKILL_SOURCES_ROOT = resolve(SESSION_HOME_ROOT, 'skill-sources');
export const SKILLS_ROOT = resolve(SESSION_HOME_ROOT, 'skills');
export const SKILLS_INDEX_PATH = resolve(SKILLS_ROOT, 'index.json');
export const SKILLS_LOCK_PATH = resolve(SKILLS_ROOT, 'lock.json');

export function toSessionRelativePath(absolutePath) {
  return relative(SESSION_HOME_ROOT, absolutePath).split(sep).join('/');
}

export function normalizeRelativeSkillPath(inputPath) {
  return inputPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

export function buildSkillSourceRepoKey(repo) {
  return repo.trim().replace(/[^a-zA-Z0-9._-]+/g, '__');
}

export function isWithinRoot(candidatePath, rootPath) {
  const normalizedCandidate = resolve(candidatePath);
  const normalizedRoot = resolve(rootPath);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function cleanYamlValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function parseFrontmatterBlock(fileContent) {
  const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return {
      body: fileContent,
      data: {},
    };
  }

  const raw = match[1] || '';
  const body = fileContent.slice(match[0].length);
  const lines = raw.split(/\r?\n/);
  const data = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] || '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith('name:')) {
      data.name = cleanYamlValue(line.slice('name:'.length));
      index += 1;
      continue;
    }

    if (line.startsWith('description:')) {
      const descriptionValue = cleanYamlValue(line.slice('description:'.length));
      const isFoldedBlock = descriptionValue === '>' || descriptionValue === '>-';
      const isLiteralBlock = descriptionValue === '|' || descriptionValue === '|-';
      let description = descriptionValue;
      index += 1;

      if (isFoldedBlock || isLiteralBlock) {
        const blockLines = [];
        while (index < lines.length) {
          const continuation = lines[index] || '';
          if (!continuation.trim()) {
            blockLines.push('');
            index += 1;
            continue;
          }

          if (!/^\s+/.test(continuation)) {
            break;
          }

          blockLines.push(continuation.trim());
          index += 1;
        }

        description = isFoldedBlock
          ? blockLines.filter((linePart) => linePart.length > 0).join(' ')
          : blockLines.join('\n').trim();
      }

      data.description = description.trim();
      continue;
    }

    index += 1;
  }

  return { body, data };
}

function extractTitle(markdownBody, fallbackTitle) {
  const heading = markdownBody.match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() || fallbackTitle;
}

function extractDescription(markdownBody) {
  const paragraphs = markdownBody
    .split(/\r?\n\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return (
    paragraphs.find((paragraph) => !paragraph.startsWith('#') && !paragraph.startsWith('>') && !paragraph.startsWith('- ')) ||
    ''
  );
}

export async function readSkillMetadata(skillFilePath, fallbackName) {
  const fileContent = await readFile(skillFilePath, 'utf8');
  const parsed = parseFrontmatterBlock(fileContent);
  const title = typeof parsed.data.name === 'string' && parsed.data.name.trim()
    ? parsed.data.name.trim()
    : extractTitle(parsed.body, fallbackName);
  const description = typeof parsed.data.description === 'string' && parsed.data.description.trim()
    ? parsed.data.description.trim()
    : extractDescription(parsed.body);

  return {
    title,
    description,
    shortName: basename(dirname(skillFilePath)),
  };
}

export async function loadSkillsIndex() {
  try {
    return JSON.parse(await readFile(SKILLS_INDEX_PATH, 'utf8'));
  } catch {
    return {
      version: 1,
      skills: [],
    };
  }
}
