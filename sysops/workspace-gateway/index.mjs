import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, sep, posix, basename, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { normalizeToolInputSchema } from './schema.mjs';
import { loadSkillsIndex, normalizeRelativeSkillPath, SESSION_HOME_ROOT, isWithinRoot } from './skills-lib.mjs';

const execFile = promisify(execFileCallback);
const WORKSPACE_ROOT = resolve(
  process.env.LIFECYCLE_SESSION_WORKSPACE || '/workspace'
);
const PRIMARY_GIT_ROOT = resolve(
  process.env.LIFECYCLE_SESSION_PRIMARY_REPO_PATH || WORKSPACE_ROOT
);
const HOST = process.env.MCP_HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.MCP_PORT || process.env.PORT || '3000', 10);
const MAX_READ_CHARS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_READ_CHARS, 24_000);
const MAX_LIST_RESULTS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_LIST_RESULTS, 200);
const MAX_GREP_RESULTS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_GREP_RESULTS, 100);
const MAX_COMMAND_OUTPUT_CHARS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_COMMAND_OUTPUT_CHARS, 24_000);
const MAX_FILE_CHANGE_PREVIEW_CHARS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_FILE_CHANGE_PREVIEW_CHARS, 4000);
const MAX_FILE_CHANGE_DIFF_CHARS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_FILE_CHANGE_DIFF_CHARS, 16_000);
const STATE_FILE = process.env.LIFECYCLE_SANDBOX_STATE_FILE || '';
const PORTS_FILE = process.env.LIFECYCLE_SANDBOX_PORTS_FILE || '';
const PROCESSES_FILE = process.env.LIFECYCLE_SANDBOX_PROCESSES_FILE || '';
const SERVICES_FILE = process.env.LIFECYCLE_SANDBOX_SERVICES_FILE || '';
const EXTERNAL_MCP_CONFIG_JSON = process.env.LIFECYCLE_SESSION_MCP_CONFIG_JSON || '[]';

const STARTED_AT = new Date().toISOString();
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'coverage']);
const RESERVED_WORKSPACE_PREFIXES = ['.lifecycle/skills', '.lifecycle/skill-sources'];
const SHELL_SINGLE_QUOTE_ESCAPE = `'"'"'`;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeExternalServerConfigs(rawValue) {
  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((candidate) => {
    if (!isRecord(candidate)) {
      return [];
    }

    const slug = typeof candidate.slug === 'string' ? candidate.slug.trim() : '';
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const timeout = Number.isFinite(candidate.timeout) ? Number(candidate.timeout) : 30000;
    const transport = candidate.transport;

    if (!slug || !name || !isRecord(transport) || transport.type !== 'stdio' || typeof transport.command !== 'string') {
      return [];
    }

    return [
      {
        slug,
        name,
        timeout,
        transport: {
          type: 'stdio',
          command: transport.command,
          args: Array.isArray(transport.args) ? transport.args.filter((value) => typeof value === 'string') : [],
          env: isRecord(transport.env)
            ? Object.fromEntries(
                Object.entries(transport.env).map(([key, value]) => [key, String(value)])
              )
            : undefined,
        },
      },
    ];
  });
}

const EXTERNAL_MCP_SERVERS = normalizeExternalServerConfigs(EXTERNAL_MCP_CONFIG_JSON);

function textErrorResult(message, details = null) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            ok: false,
            error: message,
            ...(details ? { details } : {}),
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function textResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function truncateText(value, maxChars = MAX_COMMAND_OUTPUT_CHARS) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.length > maxChars ? `${value.slice(0, maxChars)}\n\n[truncated to ${maxChars} chars]` : value;
}

function errorText(message, details = null) {
  return textResult({
    ok: false,
    error: message,
    ...(details ? { details } : {}),
  });
}

function trimPreview(value, maxChars = MAX_FILE_CHANGE_PREVIEW_CHARS) {
  if (typeof value !== 'string') {
    return null;
  }

  return value.length > maxChars ? `${value.slice(0, maxChars)}\n\n[truncated]` : value;
}

function countPatchStats(unifiedDiff) {
  if (typeof unifiedDiff !== 'string' || !unifiedDiff) {
    return { additions: 0, deletions: 0 };
  }

  let additions = 0;
  let deletions = 0;
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue;
    }

    if (line.startsWith('+')) {
      additions += 1;
    } else if (line.startsWith('-')) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

function normalizeUnifiedDiffPath(unifiedDiff, workspacePath) {
  if (typeof unifiedDiff !== 'string' || !unifiedDiff) {
    return null;
  }

  const displayPath = toWorkspaceRelativePath(resolveWorkspacePath(workspacePath));
  const lines = unifiedDiff.split('\n');
  let rewrittenHeader = false;

  return lines
    .map((line) => {
      if (line.startsWith('diff --git ')) {
        rewrittenHeader = true;
        return `diff --git a/${displayPath} b/${displayPath}`;
      }

      if (line.startsWith('--- ')) {
        return `--- a/${displayPath}`;
      }

      if (line.startsWith('+++ ')) {
        return `+++ b/${displayPath}`;
      }

      return line;
    })
    .filter((line, index) => rewrittenHeader || index !== 0 || !line.startsWith('diff --git '))
    .join('\n');
}

function buildFallbackUnifiedDiff({ workspacePath, before, after }) {
  if (before === after) {
    return null;
  }

  const displayPath = toWorkspaceRelativePath(resolveWorkspacePath(workspacePath));
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  return [
    `diff --git a/${displayPath} b/${displayPath}`,
    `--- a/${displayPath}`,
    `+++ b/${displayPath}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join('\n');
}

async function generateUnifiedDiff({ workspacePath, before, after }) {
  if (before === after) {
    return {
      unifiedDiff: null,
      additions: 0,
      deletions: 0,
      truncated: false,
    };
  }

  const tempRoot = await mkdtemp(resolve(tmpdir(), 'lfc-file-change-'));
  const beforePath = resolve(tempRoot, 'before.txt');
  const afterPath = resolve(tempRoot, 'after.txt');

  await writeFile(beforePath, before, 'utf8');
  await writeFile(afterPath, after, 'utf8');

  try {
    let stdout = '';
    try {
      const result = await execFile('/usr/bin/git', [
        'diff',
        '--no-index',
        '--text',
        '--unified=3',
        beforePath,
        afterPath,
      ]);
      stdout = result.stdout;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 1) {
        stdout = typeof error.stdout === 'string' ? error.stdout : '';
      } else {
        stdout = buildFallbackUnifiedDiff({ workspacePath, before, after }) || '';
      }
    }

    const normalized = normalizeUnifiedDiffPath(stdout.trim(), workspacePath);
    const truncated =
      typeof normalized === 'string' && normalized.length > MAX_FILE_CHANGE_DIFF_CHARS;
    const unifiedDiff =
      typeof normalized === 'string' && normalized.length > 0
        ? truncated
          ? `${normalized.slice(0, MAX_FILE_CHANGE_DIFF_CHARS)}\n\n[truncated]`
          : normalized
        : null;
    const stats = countPatchStats(normalized);

    return {
      unifiedDiff,
      additions: stats.additions,
      deletions: stats.deletions,
      truncated,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function buildFileChangeArtifact({
  path,
  kind,
  before,
  after,
}) {
  const diff = await generateUnifiedDiff({
    workspacePath: path,
    before,
    after,
  });

  return {
    path,
    kind,
    additions: diff.additions,
    deletions: diff.deletions,
    truncated: diff.truncated,
    unifiedDiff: diff.unifiedDiff,
    beforeTextPreview: trimPreview(before),
    afterTextPreview: trimPreview(after),
    summary:
      kind === 'created'
        ? `Created ${path}`
        : kind === 'deleted'
          ? `Deleted ${path}`
          : `Updated ${path}`,
    encoding: 'utf-8',
    oldSizeBytes: Buffer.byteLength(before, 'utf8'),
    newSizeBytes: Buffer.byteLength(after, 'utf8'),
    oldSha256: createHash('sha256').update(before).digest('hex'),
    newSha256: createHash('sha256').update(after).digest('hex'),
  };
}

function isWithinWorkspace(candidate) {
  const normalized = resolve(candidate);
  return normalized === WORKSPACE_ROOT || normalized.startsWith(`${WORKSPACE_ROOT}${sep}`);
}

function isWithinPrimaryGitRoot(candidate) {
  const normalized = resolve(candidate);
  return normalized === PRIMARY_GIT_ROOT || normalized.startsWith(`${PRIMARY_GIT_ROOT}${sep}`);
}

function resolveWorkspacePath(inputPath) {
  const resolved = inputPath.startsWith('/') ? resolve(inputPath) : resolve(WORKSPACE_ROOT, inputPath);
  if (!isWithinWorkspace(resolved)) {
    throw new Error(`Path must stay within ${WORKSPACE_ROOT}`);
  }
  return resolved;
}

function toWorkspaceRelativePath(absolutePath) {
  const rel = relative(WORKSPACE_ROOT, absolutePath);
  return rel.split(sep).join('/');
}

function toPosixPath(inputPath) {
  return inputPath.split(sep).join('/');
}

function normalizeGitPathArg(inputPath) {
  if (!inputPath || !inputPath.trim()) {
    return '';
  }

  const resolved = resolveWorkspacePath(inputPath);
  if (!isWithinPrimaryGitRoot(resolved)) {
    throw new Error(`Path must stay within ${toWorkspaceRelativePath(PRIMARY_GIT_ROOT)}`);
  }

  const rel = relative(PRIMARY_GIT_ROOT, resolved);
  return rel ? toPosixPath(rel) : '.';
}

function isReservedWorkspacePath(filePath) {
  const normalized = toWorkspaceRelativePath(resolveWorkspacePath(filePath));
  return RESERVED_WORKSPACE_PREFIXES.some(
    (reservedPath) => normalized === reservedPath || normalized.startsWith(`${reservedPath}/`)
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern) {
  const normalized = toPosixPath(pattern).replace(/^\.\/+/, '');
  let regex = '^';

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const nextChar = normalized[index + 1];

    if (char === '*') {
      if (nextChar === '*') {
        const afterNext = normalized[index + 2];
        regex += '.*';
        index += 1;
        if (afterNext === '/') {
          index += 1;
        }
        continue;
      }

      regex += '[^/]*';
      continue;
    }

    if (char === '?') {
      regex += '[^/]';
      continue;
    }

    regex += escapeRegExp(char);
  }

  regex += '$';
  return new RegExp(regex);
}

function isLikelyTextFile(filePath) {
  const lower = filePath.toLowerCase();
  return !/\.(png|jpg|jpeg|gif|webp|pdf|zip|gz|tgz|br|woff2?|ttf|otf|ico|mp4|mov|webm|mp3|wav)$/i.test(lower);
}

async function readJsonSetting(source) {
  if (!source) {
    return null;
  }

  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  try {
    const raw = await readFile(resolve(trimmed), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readOptionalJsonFile(filePath) {
  if (!filePath) {
    return null;
  }

  try {
    const raw = await readFile(resolve(filePath), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadSnapshot(source, fallback = null) {
  return (await readJsonSetting(source)) ?? (await readOptionalJsonFile(source)) ?? fallback;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function quoteShellSingle(value) {
  return `'${value.replace(/'/g, SHELL_SINGLE_QUOTE_ESCAPE)}'`;
}

async function writeWorkspaceFile(filePath, content) {
  const resolved = resolveWorkspacePath(filePath);
  if (isReservedWorkspacePath(resolved)) {
    throw new Error('Lifecycle-managed skill files are read-only');
  }
  const existed = await fileExists(resolved);
  const before = existed ? await readFile(resolved, 'utf8') : '';
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf8');
  const stats = await stat(resolved);
  const path = toWorkspaceRelativePath(resolved);
  const fileChange = await buildFileChangeArtifact({
    path,
    kind: existed ? 'edited' : 'created',
    before,
    after: content,
  });

  return {
    path,
    bytes: stats.size,
    fileChanges: [fileChange],
  };
}

async function editWorkspaceFile({ path, oldText, newText, replaceAll = false }) {
  const resolved = resolveWorkspacePath(path);
  if (isReservedWorkspacePath(resolved)) {
    throw new Error('Lifecycle-managed skill files are read-only');
  }
  const raw = await readFile(resolved, 'utf8');

  if (!raw.includes(oldText)) {
    throw new Error(`Expected text was not found in ${path}`);
  }

  const updated = replaceAll ? raw.split(oldText).join(newText) : raw.replace(oldText, newText);
  await writeFile(resolved, updated, 'utf8');
  const workspacePath = toWorkspaceRelativePath(resolved);
  const fileChange = await buildFileChangeArtifact({
    path: workspacePath,
    kind: 'edited',
    before: raw,
    after: updated,
  });

  return {
    path: workspacePath,
    bytes: Buffer.byteLength(updated, 'utf8'),
    replacements: replaceAll ? raw.split(oldText).length - 1 : 1,
    fileChanges: [fileChange],
  };
}

async function runWorkspaceCommand({ command, cwd = '.', timeoutMs = 30000 }) {
  const resolvedCwd = resolveWorkspacePath(cwd);
  const { stdout, stderr } = await execFile('/bin/bash', ['-lc', command], {
    cwd: resolvedCwd,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      HOME: process.env.HOME || WORKSPACE_ROOT,
    },
  });

  return {
    cwd: toWorkspaceRelativePath(resolvedCwd),
    stdout: truncateText(stdout),
    stderr: truncateText(stderr),
    success: true,
  };
}

async function walkFiles(rootDir, relativePrefix = '', results = [], limit = MAX_LIST_RESULTS) {
  if (results.length >= limit) {
    return results;
  }

  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (results.length >= limit) {
      break;
    }

    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    const absolutePath = resolve(rootDir, entry.name);
    const relativePath = posix.join(relativePrefix, entry.name);

    if (entry.isDirectory()) {
      results.push({ path: `${relativePath}/`, kind: 'directory' });
      await walkFiles(absolutePath, relativePath, results, limit);
    } else {
      results.push({ path: relativePath, kind: 'file' });
    }
  }

  return results;
}

async function collectFilesUnderPath(searchPath) {
  const resolved = resolveWorkspacePath(searchPath || '.');
  const stats = await stat(resolved);

  if (stats.isFile()) {
    return [resolved];
  }

  const files = [];
  const queue = [resolved];

  while (queue.length > 0 && files.length < MAX_LIST_RESULTS * 10) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        queue.push(resolve(current, entry.name));
        continue;
      }

      const absolutePath = resolve(current, entry.name);
      if (isLikelyTextFile(absolutePath)) {
        files.push(absolutePath);
      }
      if (files.length >= MAX_LIST_RESULTS * 10) {
        break;
      }
    }
  }

  return files;
}

async function grepWorkspace({ pattern, path = '.', caseSensitive = true, maxResults = MAX_GREP_RESULTS }) {
  const files = await collectFilesUnderPath(path);
  const matcher = caseSensitive ? pattern : pattern.toLowerCase();
  const results = [];

  for (const absolutePath of files) {
    if (results.length >= maxResults) {
      break;
    }

    let raw;
    try {
      raw = await readFile(absolutePath, 'utf8');
    } catch {
      continue;
    }

    const lines = raw.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (results.length >= maxResults) {
        break;
      }

      const originalLine = lines[lineIndex];
      const haystack = caseSensitive ? originalLine : originalLine.toLowerCase();
      if (!haystack.includes(matcher)) {
        continue;
      }

      results.push({
        path: toWorkspaceRelativePath(absolutePath),
        line: lineIndex + 1,
        text: originalLine.slice(0, 500),
      });
    }
  }

  return results;
}

async function summarizeGitState() {
  const gitDir = resolve(PRIMARY_GIT_ROOT, '.git');
  if (!(await fileExists(gitDir))) {
    return { present: false };
  }

  const headPath = resolve(gitDir, 'HEAD');
  try {
    const head = (await readFile(headPath, 'utf8')).trim();
    if (head.startsWith('ref: ')) {
      const refPath = head.slice(5).trim();
      const refFile = resolve(gitDir, refPath);
      const commit = (await readOptionalText(refFile)).trim() || null;
      return {
        present: true,
        branch: basename(refPath),
        ref: refPath,
        commit,
      };
    }

    return {
      present: true,
      branch: null,
      ref: 'HEAD',
      commit: head || null,
    };
  } catch {
    return { present: true };
  }
}

async function runPrimaryGitCommand({ command, timeoutMs = 30000 }) {
  return runWorkspaceCommand({
    command,
    cwd: PRIMARY_GIT_ROOT,
    timeoutMs,
  });
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function summarizeWorkspaceState() {
  const [topLevelEntries, sessionState, portsState, processesState, servicesState, gitState] = await Promise.all([
    walkFiles(WORKSPACE_ROOT),
    loadSnapshot(STATE_FILE, null),
    loadSnapshot(PORTS_FILE, []),
    loadSnapshot(PROCESSES_FILE, []),
    loadSnapshot(SERVICES_FILE, []),
    summarizeGitState(),
  ]);

  let packageJson = null;
  try {
    packageJson = JSON.parse(await readFile(resolve(WORKSPACE_ROOT, 'package.json'), 'utf8'));
  } catch {
    packageJson = null;
  }

  return {
    workspaceRoot: WORKSPACE_ROOT,
    cwd: process.cwd(),
    pid: process.pid,
    startedAt: STARTED_AT,
    nodeVersion: process.version,
    package: packageJson
      ? {
          name: packageJson.name || null,
          version: packageJson.version || null,
          private: Boolean(packageJson.private),
        }
      : null,
    git: gitState,
    topLevelEntries,
    sessionState,
    ports: Array.isArray(portsState) ? portsState : [],
    processes: Array.isArray(processesState) ? processesState : [],
    services: Array.isArray(servicesState) ? servicesState : [],
  };
}

async function listEquippedSkills() {
  const index = await loadSkillsIndex();
  const skills = Array.isArray(index.skills) ? index.skills : [];
  return {
    count: skills.length,
    skills: skills.map((skill) => ({
      path: skill.path,
      shortName: skill.shortName || skill.path.split('/').pop() || skill.path,
      title: skill.title || skill.shortName || skill.path,
      description: skill.description || '',
      repo: skill.repo,
      branch: skill.branch,
      source: skill.source || null,
      serviceName: skill.serviceName || null,
    })),
  };
}

function normalizeSkillFileRequest(inputFile) {
  if (typeof inputFile !== 'string' || !inputFile.trim()) {
    return 'SKILL.md';
  }

  return inputFile.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '') || 'SKILL.md';
}

async function learnEquippedSkill(requestedPath, requestedFile) {
  const normalizedPath = normalizeRelativeSkillPath(requestedPath);
  const normalizedFile = normalizeSkillFileRequest(requestedFile);
  const index = await loadSkillsIndex();
  const skills = Array.isArray(index.skills) ? index.skills : [];
  const skill = skills.find((entry) => normalizeRelativeSkillPath(entry.path || '') === normalizedPath);
  if (!skill) {
    throw new Error(`Skill is not equipped: ${normalizedPath}`);
  }

  if (typeof skill.sourceRoot !== 'string' || !skill.sourceRoot.trim()) {
    throw new Error(`Skill source root is missing for ${normalizedPath}`);
  }

  const sourceRoot = resolve(SESSION_HOME_ROOT, skill.sourceRoot);
  const entryRoot = resolve(sourceRoot, normalizedPath);
  if (!isWithinRoot(entryRoot, sourceRoot)) {
    throw new Error(`Skill entry path must stay within source repo: ${normalizedPath}`);
  }

  const filePath = resolve(entryRoot, normalizedFile);
  if (!isWithinRoot(filePath, sourceRoot)) {
    throw new Error(`Skill file must stay within source repo: ${normalizedFile}`);
  }

  const fileInfo = await stat(filePath).catch(() => null);
  if (!fileInfo?.isFile()) {
    throw new Error(`Skill file not found: ${normalizedFile}`);
  }

  if (!isLikelyTextFile(filePath)) {
    throw new Error(`Skill file is not a readable text file: ${normalizedFile}`);
  }

  const raw = await readFile(filePath, 'utf8');
  const text = raw.length > MAX_READ_CHARS ? `${raw.slice(0, MAX_READ_CHARS)}\n\n[truncated to ${MAX_READ_CHARS} chars]` : raw;

  return {
    ok: true,
    path: skill.path,
    shortName: skill.shortName || skill.path.split('/').pop() || skill.path,
    title: skill.title || skill.shortName || skill.path,
    description: skill.description || '',
    file: normalizedFile,
    chars: raw.length,
    truncated: raw.length > MAX_READ_CHARS,
    text,
    repo: skill.repo,
    repoUrl: skill.repoUrl || null,
    branch: skill.branch,
    source: skill.source || null,
    serviceName: skill.serviceName || null,
  };
}

async function readResourceState(kind) {
  const snapshot = await summarizeWorkspaceState();
  switch (kind) {
    case 'ports':
      return snapshot.ports;
    case 'processes':
      return snapshot.processes;
    case 'services':
      return snapshot.services;
    default:
      return snapshot;
  }
}

function getExternalServerConfig(slug) {
  return EXTERNAL_MCP_SERVERS.find((server) => server.slug === slug) || null;
}

async function connectExternalServerClient(serverConfig) {
  const client = new Client({
    name: 'lifecycle-workspace-gateway-proxy',
    version: '0.1.0',
  });
  const transport = new StdioClientTransport({
    command: serverConfig.transport.command,
    args: serverConfig.transport.args || [],
    env: serverConfig.transport.env,
    stderr: 'pipe',
  });

  await client.connect(transport);

  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch {
        // Ignore cleanup errors after request completion.
      }
    },
  };
}

async function buildExternalProxyServer(serverConfig) {
  const upstream = await connectExternalServerClient(serverConfig);
  const definitions = await upstream.client.listTools();
  const server = new McpServer(
    {
      name: `lifecycle-session-mcp-${serverConfig.slug}`,
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  for (const tool of definitions.tools || []) {
    server.registerTool(
      tool.name,
      {
        title: tool.title || tool.name,
        description: tool.description || `MCP tool ${tool.name} from ${serverConfig.name}`,
        inputSchema: normalizeToolInputSchema(tool.inputSchema || {}),
        annotations: tool.annotations || undefined,
      },
      async (args) => {
        try {
          return await upstream.client.callTool({
            name: tool.name,
            arguments: args || {},
          });
        } catch (error) {
          return textErrorResult(
            `Unable to run MCP tool '${tool.name}'`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    );
  }

  return {
    server,
    close: async () => {
      try {
        await server.close();
      } catch {
        // Ignore cleanup errors after request completion.
      }

      await upstream.close();
    },
  };
}

function buildServer() {
  const server = new McpServer(
    {
      name: 'lifecycle-workspace-gateway',
      version: '0.1.0',
    },
    {
      capabilities: {
        logging: {},
        resources: {},
        tools: {},
      },
    }
  );

  server.registerTool(
    'skills.list',
    {
      title: 'List equipped skills',
      description: 'List the skills equipped for this session.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return textResult(await listEquippedSkills());
      } catch (error) {
        return errorText('Unable to list skills', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'skills.learn',
    {
      title: 'Learn equipped skill',
      description: 'Load SKILL.md or another referenced text file for one equipped skill.',
      inputSchema: {
        path: z.string().min(1).describe('Configured skill path, for example skills/engineering/code-review'),
        file: z
          .string()
          .optional()
          .describe('Optional file relative to the skill path, for example SKILL.md, MODULE.md, or ../CONNECTORS.md'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path, file }) => {
      try {
        return textResult(await learnEquippedSkill(path, file));
      } catch (error) {
        return errorText('Unable to learn skill', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'workspace.read_file',
    {
      title: 'Read workspace file',
      description: 'Read a text file from the workspace root with an optional character limit and line window.',
      inputSchema: {
        path: z.string().min(1).describe('Workspace-relative path or absolute path inside the workspace'),
        maxChars: z.number().int().positive().optional().describe('Maximum characters to return'),
        startLine: z.number().int().positive().optional().describe('1-based starting line, inclusive'),
        endLine: z.number().int().positive().optional().describe('1-based ending line, inclusive'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path, maxChars, startLine, endLine }) => {
      try {
        const resolved = resolveWorkspacePath(path);
        const raw = await readFile(resolved, 'utf8');
        const lines = raw.split(/\r?\n/);
        const effectiveStart = Math.max((startLine || 1) - 1, 0);
        const effectiveEnd = Math.min(endLine || lines.length, lines.length);
        const sliced = lines.slice(effectiveStart, effectiveEnd).join('\n');
        const limited = sliced.length > (maxChars || MAX_READ_CHARS) ? sliced.slice(0, maxChars || MAX_READ_CHARS) : sliced;

        return textResult({
          path: toWorkspaceRelativePath(resolved),
          chars: raw.length,
          lines: lines.length,
          startLine: startLine || 1,
          endLine: endLine || lines.length,
          truncated: limited.length < sliced.length || raw.length > (maxChars || MAX_READ_CHARS),
          text: limited,
        });
      } catch (error) {
        return errorText('Unable to read file', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'workspace.write_file',
    {
      title: 'Write workspace file',
      description: 'Write or overwrite a text file within the workspace.',
      inputSchema: {
        path: z.string().min(1).describe('Workspace-relative path or absolute path inside the workspace'),
        content: z.string().describe('Full file contents to write'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path, content }) => {
      try {
        return textResult({
          ok: true,
          ...await writeWorkspaceFile(path, content),
        });
      } catch (error) {
        return errorText('Unable to write file', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'workspace.edit_file',
    {
      title: 'Edit workspace file',
      description: 'Replace text inside a workspace file using an exact-match edit.',
      inputSchema: {
        path: z.string().min(1).describe('Workspace-relative path or absolute path inside the workspace'),
        oldText: z.string().min(1).describe('Exact text to replace'),
        newText: z.string().describe('Replacement text'),
        replaceAll: z.boolean().optional().describe('Replace every occurrence instead of only the first'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path, oldText, newText, replaceAll }) => {
      try {
        return textResult({
          ok: true,
          ...await editWorkspaceFile({ path, oldText, newText, replaceAll: replaceAll === true }),
        });
      } catch (error) {
        return errorText('Unable to edit file', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'workspace.glob',
    {
      title: 'Search workspace paths',
      description: 'Return workspace files and directories matching a glob pattern.',
      inputSchema: {
        pattern: z.string().min(1).describe('Glob pattern relative to the workspace root'),
        limit: z.number().int().positive().max(1000).optional().describe('Maximum number of matches to return'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pattern, limit }) => {
      try {
        const matcher = globToRegExp(pattern);
        const entries = await walkFiles(WORKSPACE_ROOT, '', [], limit || MAX_LIST_RESULTS);
        const matches = entries
          .map((entry) => entry.path)
          .filter((entryPath) => matcher.test(entryPath.replace(/\/$/, '')))
          .slice(0, limit || MAX_LIST_RESULTS);

        return textResult({
          pattern,
          workspaceRoot: WORKSPACE_ROOT,
          count: matches.length,
          matches,
        });
      } catch (error) {
        return errorText('Unable to evaluate glob', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'workspace.exec',
    {
      title: 'Run workspace command',
      description: 'Run a shell command from the workspace using bash.',
      inputSchema: {
        command: z.string().min(1).describe('Command to run with bash -lc'),
        cwd: z.string().optional().describe('Working directory relative to the workspace'),
        timeoutMs: z.number().int().positive().max(120000).optional().describe('Command timeout in milliseconds'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ command, cwd, timeoutMs }) => {
      try {
        return textResult({
          ok: true,
          command,
          ...await runWorkspaceCommand({
            command,
            cwd: cwd || '.',
            timeoutMs: timeoutMs || 30000,
          }),
        });
      } catch (error) {
        return errorText('Unable to run workspace command', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'workspace.grep',
    {
      title: 'Search workspace text',
      description: 'Search text across workspace files using a literal substring match.',
      inputSchema: {
        pattern: z.string().min(1).describe('Literal text to search for'),
        path: z.string().optional().describe('Directory or file to search from'),
        caseSensitive: z.boolean().optional().describe('Whether the match should be case-sensitive'),
        maxResults: z.number().int().positive().max(1000).optional().describe('Maximum matches to return'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pattern, path, caseSensitive, maxResults }) => {
      try {
        const matches = await grepWorkspace({
          pattern,
          path: path || '.',
          caseSensitive: caseSensitive !== false,
          maxResults: maxResults || MAX_GREP_RESULTS,
        });

        return textResult({
          pattern,
          path: path || '.',
          count: matches.length,
          matches,
        });
      } catch (error) {
        return errorText('Unable to grep workspace', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'session.get_workspace_state',
    {
      title: 'Get workspace state',
      description: 'Return a normalized snapshot of the current sandbox workspace and optional state files.',
      annotations: { readOnlyHint: true },
    },
    async () => textResult(await summarizeWorkspaceState())
  );

  server.registerTool(
    'git.status',
    {
      title: 'Git status',
      description: 'Return a short git status for the workspace repository.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return textResult({
          ok: true,
          ...(await runPrimaryGitCommand({ command: 'git status --short --branch' })),
        });
      } catch (error) {
        return errorText('Unable to read git status', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'git.diff',
    {
      title: 'Git diff',
      description: 'Return a git diff for the workspace repository.',
      inputSchema: {
        staged: z.boolean().optional().describe('Return the staged diff instead of the working tree diff'),
        path: z.string().optional().describe('Optional path filter'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ staged, path }) => {
      try {
        const normalizedPath = normalizeGitPathArg(path || '');
        const command = staged
          ? `git diff --cached -- ${normalizedPath}`.trim()
          : `git diff -- ${normalizedPath}`.trim();
        return textResult({
          ok: true,
          ...(await runPrimaryGitCommand({ command })),
        });
      } catch (error) {
        return errorText('Unable to read git diff', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'git.add',
    {
      title: 'Git add',
      description: 'Stage one or more paths in the workspace repository.',
      inputSchema: {
        paths: z.array(z.string().min(1)).min(1).describe('Paths to stage'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ paths }) => {
      try {
        const command = `git add -- ${paths.map((path) => quoteShellSingle(normalizeGitPathArg(path))).join(' ')}`;
        return textResult({
          ok: true,
          ...(await runPrimaryGitCommand({ command })),
        });
      } catch (error) {
        return errorText('Unable to stage paths', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'git.commit',
    {
      title: 'Git commit',
      description: 'Create a commit from the current staged changes.',
      inputSchema: {
        message: z.string().min(1).describe('Commit message'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ message }) => {
      try {
        return textResult({
          ok: true,
          ...(await runPrimaryGitCommand({ command: `git commit -m ${quoteShellSingle(message)}` })),
        });
      } catch (error) {
        return errorText('Unable to create commit', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'git.branch',
    {
      title: 'Git branch',
      description: 'Inspect branches or create/switch a branch in the workspace repository.',
      inputSchema: {
        name: z.string().optional().describe('Branch name to create or switch to'),
        startPoint: z.string().optional().describe('Optional start point when creating a branch'),
        checkout: z.boolean().optional().describe('Switch to the branch after creation or lookup'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ name, startPoint, checkout }) => {
      try {
        if (!name) {
          return textResult({
            ok: true,
            ...(await runPrimaryGitCommand({ command: 'git branch --list' })),
          });
        }

        const command = checkout
          ? `git checkout ${
              startPoint
                ? `-b ${quoteShellSingle(name)} ${quoteShellSingle(startPoint)}`
                : quoteShellSingle(name)
            }`
          : `git branch ${quoteShellSingle(name)}${startPoint ? ` ${quoteShellSingle(startPoint)}` : ''}`;

        return textResult({
          ok: true,
          ...(await runPrimaryGitCommand({ command })),
        });
      } catch (error) {
        return errorText('Unable to manage git branch', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'session.list_ports',
    {
      title: 'List ports',
      description: 'Return the current ports snapshot for the sandbox, if available.',
      annotations: { readOnlyHint: true },
    },
    async () => textResult(await readResourceState('ports'))
  );

  server.registerTool(
    'session.list_processes',
    {
      title: 'List processes',
      description: 'Return the current process snapshot for the sandbox, if available.',
      annotations: { readOnlyHint: true },
    },
    async () => textResult(await readResourceState('processes'))
  );

  server.registerTool(
    'session.get_service_status',
    {
      title: 'Get service status',
      description: 'Return a service snapshot or the status for one named service.',
      inputSchema: {
        serviceName: z.string().optional().describe('Optional service name to filter by'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ serviceName }) => {
      const services = await readResourceState('services');
      if (!serviceName) {
        return textResult(services);
      }

      if (Array.isArray(services)) {
        const match = services.find((service) => {
          if (!service || typeof service !== 'object') {
            return false;
          }
          return service.name === serviceName || service.serviceName === serviceName;
        });

        return textResult(match || { serviceName, status: 'unknown' });
      }

      return textResult({ serviceName, status: 'unknown' });
    }
  );

  server.registerResource(
    'workspace-state',
    'workspace://state',
    {
      title: 'Workspace state',
      description: 'Snapshot of the current sandbox workspace state.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const state = await summarizeWorkspaceState();
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(state, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    'workspace-ports',
    'workspace://ports',
    {
      title: 'Workspace ports',
      description: 'Current workspace port snapshot.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const ports = await readResourceState('ports');
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(ports, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    'workspace-processes',
    'workspace://processes',
    {
      title: 'Workspace processes',
      description: 'Current workspace process snapshot.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const processes = await readResourceState('processes');
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(processes, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    'workspace-services',
    'workspace://services',
    {
      title: 'Workspace services',
      description: 'Current workspace service snapshot.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const services = await readResourceState('services');
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(services, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, mcp-protocol-version, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version, content-type');
}

async function handleStreamableMcpRequest(req, res, createServerInstance, label) {
  const instance = await createServerInstance();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: false,
  });

  const cleanup = async () => {
    try {
      await transport.close();
    } catch {
      // Ignore transport cleanup errors after request completion.
    }

    try {
      await instance.server.close();
    } catch {
      // Ignore protocol cleanup errors after request completion.
    }

    try {
      await instance.close();
    } catch {
      // Ignore protocol cleanup errors after request completion.
    }
  };

  const onClose = () => {
    void cleanup();
  };

  res.on('close', onClose);
  try {
    await instance.server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(`${label} request failed`, error);
    res.off('close', onClose);
    await cleanup();

    if (!res.headersSent) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const app = createMcpExpressApp({ host: HOST });

app.use((_req, res, next) => {
  setCorsHeaders(res);
  next();
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'lifecycle-workspace-gateway',
    workspaceRoot: WORKSPACE_ROOT,
    startedAt: STARTED_AT,
    externalServerCount: EXTERNAL_MCP_SERVERS.length,
    externalServers: EXTERNAL_MCP_SERVERS.map((server) => ({
      slug: server.slug,
      name: server.name,
      transportType: server.transport.type,
    })),
  });
});

app.options('/mcp', (_req, res) => {
  res.sendStatus(204);
});

app.post('/mcp', async (req, res) => {
  await handleStreamableMcpRequest(
    req,
    res,
    async () => ({
      server: buildServer(),
      close: async () => {},
    }),
    'Sandbox MCP'
  );
});

app.get('/mcp', (_req, res) => {
  res.set('Allow', 'POST');
  res.status(405).send('Method Not Allowed');
});

app.delete('/mcp', (_req, res) => {
  res.set('Allow', 'POST');
  res.status(405).send('Method Not Allowed');
});

app.options('/servers/:slug/mcp', (_req, res) => {
  res.sendStatus(204);
});

app.post('/servers/:slug/mcp', async (req, res) => {
  const serverConfig = getExternalServerConfig(req.params.slug);
  if (!serverConfig) {
    res.status(404).json({ error: 'External MCP server not found' });
    return;
  }

  await handleStreamableMcpRequest(
    req,
    res,
    async () => buildExternalProxyServer(serverConfig),
    `Sandbox external MCP '${serverConfig.slug}'`
  );
});

app.get('/servers/:slug/mcp', (_req, res) => {
  res.set('Allow', 'POST');
  res.status(405).send('Method Not Allowed');
});

app.delete('/servers/:slug/mcp', (_req, res) => {
  res.set('Allow', 'POST');
  res.status(405).send('Method Not Allowed');
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`Sandbox MCP server listening on http://${HOST}:${PORT}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
  console.log(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
});

httpServer.on('error', (error) => {
  console.error('Sandbox MCP server failed', error);
  process.exit(1);
});

async function shutdown(signal) {
  try {
    console.log(`Sandbox MCP shutting down signal=${signal}`);
    await new Promise((resolveShutdown) => {
      httpServer.close(() => resolveShutdown());
    });
  } catch {
    // Ignore shutdown errors during process exit.
  }
}

process.on('SIGINT', async () => {
  await shutdown('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdown('SIGTERM');
  process.exit(0);
});
