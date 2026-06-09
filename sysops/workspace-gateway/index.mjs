import { promisify } from 'node:util';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { request as httpRequest, STATUS_CODES } from 'node:http';
import { tmpdir } from 'node:os';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, sep, posix, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { normalizeToolInputSchema } from './schema.mjs';
import {
  loadSkillsIndex,
  normalizeRelativeSkillPath,
  SESSION_HOME_ROOT,
  isWithinRoot as isWithinSkillRoot,
} from './skills-lib.mjs';
import { LIFECYCLE_GATEWAY_TOKEN_HEADER, createGatewayAuthMiddleware, isAuthorizedGatewayRequest } from './auth.mjs';
import { buildAgentCommandEnv } from './agentEnv.mjs';

const execFile = promisify(execFileCallback);
const WORKSPACE_ROOT = resolve(process.env.LIFECYCLE_SESSION_WORKSPACE || '/workspace');
const PRIMARY_GIT_ROOT = resolve(process.env.LIFECYCLE_SESSION_PRIMARY_REPO_PATH || WORKSPACE_ROOT);
const WORKSPACE_ROOT_REALPATH = safeRealpathSync(WORKSPACE_ROOT);
const PRIMARY_GIT_ROOT_REALPATH = safeRealpathSync(PRIMARY_GIT_ROOT);
const HOST = process.env.MCP_HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.MCP_PORT || process.env.PORT || '3000', 10);
const MAX_READ_CHARS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_READ_CHARS, 24_000);
const MAX_LIST_RESULTS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_LIST_RESULTS, 200);
const MAX_LIST_DEPTH = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_LIST_DEPTH, 5);
const MAX_GREP_RESULTS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_GREP_RESULTS, 100);
const MAX_COMMAND_OUTPUT_CHARS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_COMMAND_OUTPUT_CHARS, 24_000);
const MAX_FILE_CHANGE_PREVIEW_CHARS = parsePositiveInt(
  process.env.LIFECYCLE_SANDBOX_MAX_FILE_CHANGE_PREVIEW_CHARS,
  4000
);
const MAX_FILE_CHANGE_DIFF_CHARS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_FILE_CHANGE_DIFF_CHARS, 16_000);
const MAX_EXEC_FILE_CHANGES = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_EXEC_FILE_CHANGES, 50);
const DEFAULT_OPERATION_MAX_DURATION_MS = parsePositiveInt(
  process.env.LIFECYCLE_SANDBOX_DEFAULT_OPERATION_MAX_DURATION_MS,
  30_000
);
const MAX_OPERATION_DURATION_MS = parsePositiveInt(
  process.env.LIFECYCLE_SANDBOX_MAX_OPERATION_DURATION_MS,
  30 * 60 * 1000
);
const DEFAULT_OPERATION_WAIT_MS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_DEFAULT_OPERATION_WAIT_MS, 10_000);
const MAX_OPERATION_WAIT_MS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_OPERATION_WAIT_MS, 120_000);
const MAX_OPERATION_LOG_CHARS = parsePositiveInt(
  process.env.LIFECYCLE_SANDBOX_MAX_OPERATION_LOG_CHARS,
  MAX_COMMAND_OUTPUT_CHARS
);
const MAX_OPERATION_COUNT = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_OPERATION_COUNT, 100);
const OPERATION_RETENTION_MS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_OPERATION_RETENTION_MS, 60 * 60 * 1000);
const OPERATION_KILL_GRACE_MS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_OPERATION_KILL_GRACE_MS, 5000);
const MAX_SERVICE_COUNT = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_MAX_SERVICE_COUNT, 8);
const MAX_SERVICE_LOG_CHARS = parsePositiveInt(
  process.env.LIFECYCLE_SANDBOX_MAX_SERVICE_LOG_CHARS,
  MAX_OPERATION_LOG_CHARS
);
const SERVICE_RETENTION_MS = parsePositiveInt(
  process.env.LIFECYCLE_SANDBOX_SERVICE_RETENTION_MS,
  OPERATION_RETENTION_MS
);
const SERVICE_STOP_GRACE_MS = parsePositiveInt(
  process.env.LIFECYCLE_SANDBOX_SERVICE_STOP_GRACE_MS,
  OPERATION_KILL_GRACE_MS
);
const LIVE_STATE_COMMAND_TIMEOUT_MS = parsePositiveInt(process.env.LIFECYCLE_SANDBOX_LIVE_STATE_TIMEOUT_MS, 2000);
const PREVIEW_PROXY_TIMEOUT_MS = parsePositiveInt(process.env.LIFECYCLE_GATEWAY_PREVIEW_PROXY_TIMEOUT_MS, 30_000);
const STATE_FILE = process.env.LIFECYCLE_SANDBOX_STATE_FILE || '';
const PORTS_FILE = process.env.LIFECYCLE_SANDBOX_PORTS_FILE || '';
const PROCESSES_FILE = process.env.LIFECYCLE_SANDBOX_PROCESSES_FILE || '';
const SERVICES_FILE = process.env.LIFECYCLE_SANDBOX_SERVICES_FILE || '';
const EXTERNAL_MCP_CONFIG_JSON = process.env.LIFECYCLE_SESSION_MCP_CONFIG_JSON || '[]';

const STARTED_AT = new Date().toISOString();
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'coverage']);
const RESERVED_WORKSPACE_PREFIXES = ['.lifecycle/skills', '.lifecycle/skill-sources'];
const PROTECTED_WORKSPACE_PATHS = new Set([
  '.aws/config',
  '.aws/credentials',
  '.azure/azureProfile.json',
  '.azure/msal_token_cache.json',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.config/gh/hosts.yml',
  '.config/gcloud/application_default_credentials.json',
  '.docker/config.json',
  '.env',
  '.gem/credentials',
  '.git-credentials',
  '.git/config',
  '.git/config.lock',
  '.git/credentials',
  '.gitconfig',
  '.kube/config',
  '.netrc',
  '.npmrc',
  '.pypirc',
]);
const PROTECTED_WORKSPACE_PREFIXES = [
  '.config/gcloud/',
  '.gnupg/',
  '.gradle/',
  '.lifecycle/gateway/',
  '.lifecycle/runtime/',
  '.lifecycle/secrets/',
  '.lifecycle/tokens/',
  '.ssh/',
];
const PROTECTED_WORKSPACE_GLOBS = [/^\.env\..+$/i, /^\.git\/hooks(?:\/|$)/i, /^\.git\/credential/i];
const PROTECTED_WORKSPACE_BASENAMES = new Set([
  '.env',
  '.git-credentials',
  '.gitconfig',
  '.netrc',
  '.npmrc',
  '.pypirc',
]);
const SHELL_SINGLE_QUOTE_ESCAPE = `'"'"'`;
const PREVIEW_PROXY_ROUTE_PATTERN = '/preview/:port/*';
const PREVIEW_PROXY_MOUNT_PATH = '/preview/:port';
const PREVIEW_PROXY_PATH_PREFIX = '/preview';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const PREVIEW_PROXY_BLOCKED_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'forwarded',
  'host',
  'origin',
  'proxy-authorization',
  'referer',
  'referrer',
  'set-cookie',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-prefix',
  'x-forwarded-proto',
  'x-lifecycle-chat-preview-grant',
  'x-lifecycle-gateway-token',
  'x-lifecycle-preview-auth',
  'x-lifecycle-preview-grant',
  'x-lifecycle-preview-token',
  'x-real-ip',
]);

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
            ? Object.fromEntries(Object.entries(transport.env).map(([key, value]) => [key, String(value)]))
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
    const truncated = typeof normalized === 'string' && normalized.length > MAX_FILE_CHANGE_DIFF_CHARS;
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

async function buildFileChangeArtifact({ path, kind, before, after }) {
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
    summary: kind === 'created' ? `Created ${path}` : kind === 'deleted' ? `Deleted ${path}` : `Updated ${path}`,
    encoding: 'utf-8',
    oldSizeBytes: Buffer.byteLength(before, 'utf8'),
    newSizeBytes: Buffer.byteLength(after, 'utf8'),
    oldSha256: createHash('sha256').update(before).digest('hex'),
    newSha256: createHash('sha256').update(after).digest('hex'),
  };
}

async function findNearestGitRoot(startPath) {
  let current = resolve(startPath);

  while (isWithinWorkspace(current)) {
    if (await fileExists(resolve(current, '.git'))) {
      return current;
    }

    if (current === WORKSPACE_ROOT) {
      break;
    }

    current = dirname(current);
  }

  return null;
}

function snapshotHasPathUnderRoot(snapshot, workspaceRootPath) {
  return [...snapshot.keys()].some((path) => path === workspaceRootPath || path.startsWith(`${workspaceRootPath}/`));
}

function normalizeGitStatusPath(value) {
  return value
    .split(sep)
    .join('/')
    .replace(/^\.\/+/, '');
}

function gitStatusPathCoversFile(statusPath, repoRelativePath) {
  const normalizedStatusPath = normalizeGitStatusPath(statusPath);
  const normalizedRepoRelativePath = normalizeGitStatusPath(repoRelativePath);

  return (
    normalizedStatusPath === normalizedRepoRelativePath ||
    (normalizedStatusPath.endsWith('/') && normalizedRepoRelativePath.startsWith(normalizedStatusPath))
  );
}

function parseGitStatusPaths(stdout) {
  const entries = stdout.split('\0').filter(Boolean);
  const paths = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const path = entry.slice(3);

    if (path) {
      paths.push(path);
    }

    if (status.includes('R') || status.includes('C')) {
      index += 1;
    }
  }

  return paths;
}

async function readGitStatusPaths(repoRoot) {
  try {
    const result = await execFile('/usr/bin/git', [
      '-C',
      repoRoot,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
    ]);

    return parseGitStatusPaths(result.stdout);
  } catch {
    return null;
  }
}

async function readGitHeadText(repoRoot, repoRelativePath) {
  try {
    const result = await execFile('/usr/bin/git', ['-C', repoRoot, 'show', `HEAD:${repoRelativePath}`], {
      maxBuffer: 10 * 1024 * 1024,
    });

    return result.stdout;
  } catch {
    return null;
  }
}

async function getNewGitRepoInfoForPath(path, beforeSnapshot, cache) {
  const absolutePath = resolveWorkspacePath(path);
  const repoRoot = await findNearestGitRoot(dirname(absolutePath));

  if (!repoRoot) {
    return null;
  }

  const workspaceRootPath = toWorkspaceRelativePath(repoRoot);
  const existedBefore = workspaceRootPath
    ? snapshotHasPathUnderRoot(beforeSnapshot, workspaceRootPath)
    : beforeSnapshot.size > 0;
  if (existedBefore) {
    return null;
  }

  if (!cache.has(repoRoot)) {
    cache.set(
      repoRoot,
      readGitStatusPaths(repoRoot).then((statusPaths) => ({
        repoRoot,
        statusPaths,
      }))
    );
  }

  return cache.get(repoRoot);
}

async function normalizeSnapshotChangeCandidate({ path, beforeSnapshot, afterSnapshot, newGitRepoInfoCache }) {
  const hadBefore = beforeSnapshot.has(path);
  const hasAfter = afterSnapshot.has(path);

  if (!hadBefore && hasAfter) {
    const newRepoInfo = await getNewGitRepoInfoForPath(path, beforeSnapshot, newGitRepoInfoCache);
    if (newRepoInfo?.statusPaths) {
      const repoRelativePath = normalizeGitStatusPath(relative(newRepoInfo.repoRoot, resolveWorkspacePath(path)));
      const repoReportsPath = newRepoInfo.statusPaths.some((statusPath) =>
        gitStatusPathCoversFile(statusPath, repoRelativePath)
      );

      if (!repoReportsPath) {
        return null;
      }

      const baselineText = await readGitHeadText(newRepoInfo.repoRoot, repoRelativePath);
      if (baselineText !== null) {
        return {
          path,
          kind: 'edited',
          before: baselineText,
          after: afterSnapshot.get(path) || '',
        };
      }
    }
  }

  return {
    path,
    kind: !hadBefore ? 'created' : !hasAfter ? 'deleted' : 'edited',
    before: beforeSnapshot.get(path) || '',
    after: afterSnapshot.get(path) || '',
  };
}

class BoundaryPolicyError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BoundaryPolicyError';
    this.code = code;
    this.details = details;
  }
}

function safeRealpathSync(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isWithinRoot(candidate, root) {
  const normalized = resolve(candidate);
  const normalizedRoot = resolve(root);
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${sep}`);
}

function isWithinWorkspace(candidate) {
  return isWithinRoot(candidate, WORKSPACE_ROOT) || isWithinRoot(candidate, WORKSPACE_ROOT_REALPATH);
}

function isWithinRealWorkspace(candidate) {
  return isWithinRoot(candidate, WORKSPACE_ROOT_REALPATH);
}

function isWithinPrimaryGitRoot(candidate) {
  return isWithinRoot(candidate, PRIMARY_GIT_ROOT) || isWithinRoot(candidate, PRIMARY_GIT_ROOT_REALPATH);
}

function normalizeWorkspaceRelativePath(value) {
  return toPosixPath(value).replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function resolveWorkspacePath(inputPath) {
  const input = typeof inputPath === 'string' && inputPath.length > 0 ? inputPath : '.';
  const resolved = input.startsWith('/') ? resolve(input) : resolve(WORKSPACE_ROOT, input);
  if (!isWithinWorkspace(resolved)) {
    throw new BoundaryPolicyError(`Path must stay within ${WORKSPACE_ROOT}`, 'path_outside_workspace', {
      path: inputPath,
    });
  }
  return resolved;
}

async function resolveExistingRealPath(absolutePath) {
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function resolveExistingLinkInfo(absolutePath) {
  try {
    return await lstat(absolutePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function resolveWorkspaceBoundary(inputPath, { requireExisting = true } = {}) {
  const requestedPath = resolveWorkspacePath(inputPath);
  const existingRealPath = await resolveExistingRealPath(requestedPath);

  if (existingRealPath) {
    if (!isWithinRealWorkspace(existingRealPath)) {
      throw new BoundaryPolicyError('Path resolves outside the workspace root', 'path_outside_workspace', {
        path: inputPath,
      });
    }
    return {
      requestedPath,
      realPath: existingRealPath,
      exists: true,
    };
  }

  if (requireExisting) {
    await realpath(requestedPath);
  }

  const unresolvedLinkInfo = await resolveExistingLinkInfo(requestedPath);
  if (unresolvedLinkInfo?.isSymbolicLink()) {
    throw new BoundaryPolicyError('Path symlink target could not be resolved inside the workspace root', 'path_outside_workspace', {
      path: inputPath,
    });
  }

  let current = dirname(requestedPath);
  while (isWithinWorkspace(current)) {
    const realParent = await resolveExistingRealPath(current);
    if (realParent) {
      if (!isWithinRealWorkspace(realParent)) {
        throw new BoundaryPolicyError('Path parent resolves outside the workspace root', 'path_outside_workspace', {
          path: inputPath,
        });
      }

      const realPath = resolve(realParent, relative(current, requestedPath));
      if (!isWithinRealWorkspace(realPath)) {
        throw new BoundaryPolicyError('Path resolves outside the workspace root', 'path_outside_workspace', {
          path: inputPath,
        });
      }

      return {
        requestedPath,
        realPath,
        exists: false,
      };
    }

    if (current === WORKSPACE_ROOT) {
      break;
    }
    current = dirname(current);
  }

  throw new BoundaryPolicyError('Path parent must stay within the workspace root', 'path_outside_workspace', {
    path: inputPath,
  });
}

function protectedPathRuleFor(relativePath) {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized) {
    return null;
  }

  const lower = normalized.toLowerCase();
  const pathSegments = lower.split('/').filter(Boolean);
  const baseName = pathSegments[pathSegments.length - 1] || '';
  if (PROTECTED_WORKSPACE_BASENAMES.has(baseName) || baseName.startsWith('.env.')) {
    return baseName;
  }

  if (pathSegments.includes('.ssh') || pathSegments.includes('.gnupg')) {
    return `${pathSegments.find((segment) => segment === '.ssh' || segment === '.gnupg')}/**`;
  }

  const gitIndex = pathSegments.indexOf('.git');
  if (gitIndex >= 0) {
    const gitChild = pathSegments[gitIndex + 1] || '';
    if (gitChild === 'config' || gitChild === 'credentials' || gitChild === 'hooks' || gitChild.startsWith('credential')) {
      return `.git/${gitChild}${gitChild === 'hooks' ? '/**' : ''}`;
    }
  }

  if (PROTECTED_WORKSPACE_PATHS.has(lower)) {
    return lower;
  }

  const protectedPrefix = PROTECTED_WORKSPACE_PREFIXES.find((prefix) => lower.startsWith(prefix));
  if (protectedPrefix) {
    return `${protectedPrefix}**`;
  }

  const protectedGlob = PROTECTED_WORKSPACE_GLOBS.find((pattern) => pattern.test(lower));
  return protectedGlob ? protectedGlob.source : null;
}

function getWorkspaceRelativeCandidate(absolutePath, rootPath) {
  if (!isWithinRoot(absolutePath, rootPath)) {
    return null;
  }

  return normalizeWorkspaceRelativePath(relative(rootPath, absolutePath));
}

function assertNotProtectedWorkspacePath(boundary, inputPath) {
  const candidates = [
    getWorkspaceRelativeCandidate(boundary.requestedPath, WORKSPACE_ROOT),
    getWorkspaceRelativeCandidate(boundary.realPath, WORKSPACE_ROOT_REALPATH),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const rule = protectedPathRuleFor(candidate);
    if (rule) {
      throw new BoundaryPolicyError('Path is protected by workspace policy', 'protected_path', {
        path: inputPath,
        workspacePath: candidate,
        rule,
      });
    }
  }
}

async function resolveWorkspaceFilePath(inputPath, options = {}) {
  const boundary = await resolveWorkspaceBoundary(inputPath, options);
  assertNotProtectedWorkspacePath(boundary, inputPath);
  return boundary.realPath;
}

function toWorkspaceRelativePath(absolutePath) {
  const resolved = resolve(absolutePath);
  const root = isWithinRoot(resolved, WORKSPACE_ROOT)
    ? WORKSPACE_ROOT
    : isWithinRoot(resolved, WORKSPACE_ROOT_REALPATH)
    ? WORKSPACE_ROOT_REALPATH
    : WORKSPACE_ROOT;
  const rel = relative(root, resolved);
  return rel.split(sep).join('/');
}

function formatWorkspaceDisplayPath(absolutePath) {
  return toWorkspaceRelativePath(absolutePath) || '.';
}

function toPosixPath(inputPath) {
  return inputPath.split(sep).join('/');
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
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
  const normalized = normalizeWorkspaceRelativePath(toWorkspaceRelativePath(filePath));
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

function isMissingPathError(error) {
  return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

async function writeWorkspaceFile(filePath, content) {
  const resolved = await resolveWorkspaceFilePath(filePath, { requireExisting: false });
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

async function readWorkspaceFile({ path, maxChars, startLine, endLine }) {
  const resolved = await resolveWorkspaceFilePath(path);
  const raw = await readFile(resolved, 'utf8');
  const lines = raw.split(/\r?\n/);
  const effectiveStart = Math.max((startLine || 1) - 1, 0);
  const effectiveEnd = Math.min(endLine || lines.length, lines.length);
  const sliced = lines.slice(effectiveStart, effectiveEnd).join('\n');
  const limited = sliced.length > (maxChars || MAX_READ_CHARS) ? sliced.slice(0, maxChars || MAX_READ_CHARS) : sliced;

  return {
    path: toWorkspaceRelativePath(resolved),
    chars: raw.length,
    lines: lines.length,
    startLine: startLine || 1,
    endLine: endLine || lines.length,
    truncated: limited.length < sliced.length || raw.length > (maxChars || MAX_READ_CHARS),
    text: limited,
  };
}

async function editWorkspaceFile({ path, oldText, newText, replaceAll = false }) {
  const resolved = await resolveWorkspaceFilePath(path);
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

function normalizeListDepth(value) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.min(1, MAX_LIST_DEPTH);
  }

  return Math.min(parsed, MAX_LIST_DEPTH);
}

function classifyPathInfo(pathInfo) {
  if (pathInfo.isSymbolicLink()) {
    return 'symlink';
  }
  if (pathInfo.isDirectory()) {
    return 'directory';
  }
  if (pathInfo.isFile()) {
    return 'file';
  }
  return 'other';
}

function shouldSkipListEntry(name, { includeHidden, respectGitignore }) {
  if (!includeHidden && name.startsWith('.')) {
    return true;
  }

  return respectGitignore && IGNORED_DIRS.has(name);
}

function buildListEntry(path, pathInfo) {
  return {
    path,
    kind: classifyPathInfo(pathInfo),
    size: pathInfo.size,
    mtime: pathInfo.mtime.toISOString(),
  };
}

async function resolveListableWorkspaceBoundary(inputPath) {
  const boundary = await resolveWorkspaceBoundary(inputPath);
  assertNotProtectedWorkspacePath(boundary, inputPath);
  return boundary;
}

async function listWorkspaceFiles({
  path = '.',
  depth = 1,
  includeHidden = false,
  include_hidden: includeHiddenSnake,
  respectGitignore = true,
  respect_gitignore: respectGitignoreSnake,
  limit = MAX_LIST_RESULTS,
} = {}) {
  const effectiveDepth = normalizeListDepth(depth);
  const effectiveLimit = clampPositiveInt(limit, MAX_LIST_RESULTS, MAX_LIST_RESULTS);
  const showHidden = includeHidden === true || includeHiddenSnake === true;
  const useIgnoredDirs = respectGitignore !== false && respectGitignoreSnake !== false;
  const rootBoundary = await resolveListableWorkspaceBoundary(path || '.');
  const rootInfo = await lstat(rootBoundary.realPath);
  const rootDisplayPath = formatWorkspaceDisplayPath(rootBoundary.realPath);
  const entries = [];
  let truncated = false;

  if (!rootInfo.isDirectory()) {
    return {
      path: rootDisplayPath,
      entries: [buildListEntry(rootDisplayPath, rootInfo)],
      truncated: false,
    };
  }

  async function walkDirectory(directoryPath, currentDepth) {
    if (entries.length >= effectiveLimit) {
      truncated = true;
      return;
    }
    if (currentDepth > effectiveDepth) {
      return;
    }

    let dirEntries;
    try {
      dirEntries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }

    dirEntries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of dirEntries) {
      if (entries.length >= effectiveLimit) {
        truncated = true;
        break;
      }
      if (shouldSkipListEntry(entry.name, { includeHidden: showHidden, respectGitignore: useIgnoredDirs })) {
        continue;
      }

      const absolutePath = resolve(directoryPath, entry.name);
      let entryInfo;
      let entryBoundary;
      try {
        entryInfo = await lstat(absolutePath);
        entryBoundary = await resolveListableWorkspaceBoundary(absolutePath);
      } catch (error) {
        if (error instanceof BoundaryPolicyError) {
          continue;
        }
        throw error;
      }

      entries.push(buildListEntry(formatWorkspaceDisplayPath(absolutePath), entryInfo));
      if (entryInfo.isDirectory() && currentDepth < effectiveDepth) {
        await walkDirectory(entryBoundary.realPath, currentDepth + 1);
      }
    }
  }

  if (effectiveDepth > 0) {
    await walkDirectory(rootBoundary.realPath, 1);
  }

  return {
    path: rootDisplayPath,
    entries,
    truncated,
  };
}

function normalizePatchLines(patch) {
  const lines = String(patch ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function parsePatchPath(line, prefix) {
  const path = line.slice(prefix.length).trim();
  if (!path) {
    throw new Error(`Patch directive is missing a path: ${line}`);
  }
  return path;
}

function patchLinesToText(lines) {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function parsePatchHunk(lines, index) {
  if (!lines[index]?.startsWith('@@')) {
    throw new Error('Update patch hunks must start with @@.');
  }

  const oldLines = [];
  const newLines = [];
  let cursor = index + 1;
  while (cursor < lines.length && !lines[cursor].startsWith('@@') && !lines[cursor].startsWith('*** ')) {
    const line = lines[cursor];
    if (line === '\\ No newline at end of file') {
      cursor += 1;
      continue;
    }
    if (!line || ![' ', '+', '-'].includes(line[0])) {
      throw new Error(`Unsupported patch hunk line: ${line}`);
    }

    const text = line.slice(1);
    if (line[0] === ' ' || line[0] === '-') {
      oldLines.push(text);
    }
    if (line[0] === ' ' || line[0] === '+') {
      newLines.push(text);
    }
    cursor += 1;
  }

  if (oldLines.length === 0) {
    throw new Error('Update patch hunks must include context or removed lines.');
  }

  return {
    hunk: {
      oldText: patchLinesToText(oldLines),
      newText: patchLinesToText(newLines),
    },
    nextIndex: cursor,
  };
}

function parseWorkspacePatch(patch) {
  const lines = normalizePatchLines(patch);
  if (lines[0] !== '*** Begin Patch') {
    throw new Error('Patch must start with *** Begin Patch.');
  }
  if (lines[lines.length - 1] !== '*** End Patch') {
    throw new Error('Patch must end with *** End Patch.');
  }

  const operations = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index];
    if (line.startsWith('*** Add File: ')) {
      const path = parsePatchPath(line, '*** Add File: ');
      const contentLines = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('*** ')) {
        if (!lines[index].startsWith('+')) {
          throw new Error(`Add file patch lines must start with +: ${lines[index]}`);
        }
        contentLines.push(lines[index].slice(1));
        index += 1;
      }
      operations.push({ kind: 'add', path, content: patchLinesToText(contentLines) });
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      operations.push({ kind: 'delete', path: parsePatchPath(line, '*** Delete File: ') });
      index += 1;
      continue;
    }

    if (line.startsWith('*** Update File: ')) {
      const path = parsePatchPath(line, '*** Update File: ');
      const hunks = [];
      index += 1;
      if (lines[index]?.startsWith('*** Move to: ')) {
        throw new Error('Patch move operations are not supported by this gateway.');
      }
      while (index < lines.length && !lines[index].startsWith('*** ')) {
        const parsed = parsePatchHunk(lines, index);
        hunks.push(parsed.hunk);
        index = parsed.nextIndex;
      }
      if (hunks.length === 0) {
        throw new Error(`Update patch for ${path} must include at least one hunk.`);
      }
      operations.push({ kind: 'update', path, hunks });
      continue;
    }

    throw new Error(`Unsupported patch directive: ${line}`);
  }

  if (operations.length === 0) {
    throw new Error('Patch does not contain any file operations.');
  }

  return operations;
}

function findReplacementTarget(content, oldText, cursor, path) {
  const candidates = [oldText];
  if (oldText.endsWith('\n')) {
    candidates.push(oldText.slice(0, -1));
  }

  for (const candidate of candidates) {
    const index = content.indexOf(candidate, cursor);
    if (candidate && index >= 0) {
      return { index, text: candidate };
    }
  }

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const firstIndex = content.indexOf(candidate);
    if (firstIndex < 0) {
      continue;
    }
    if (content.indexOf(candidate, firstIndex + candidate.length) >= 0) {
      throw new Error(`Patch hunk for ${path} is ambiguous.`);
    }
    return { index: firstIndex, text: candidate };
  }

  throw new Error(`Patch hunk did not match ${path}.`);
}

function replacementTextForMatch(hunk, matchedText) {
  if (matchedText === hunk.oldText) {
    return hunk.newText;
  }
  if (hunk.oldText.endsWith('\n') && matchedText === hunk.oldText.slice(0, -1)) {
    return hunk.newText.endsWith('\n') ? hunk.newText.slice(0, -1) : hunk.newText;
  }
  return hunk.newText;
}

function applyPatchHunks(content, hunks, path) {
  let updated = content;
  let cursor = 0;
  for (const hunk of hunks) {
    const match = findReplacementTarget(updated, hunk.oldText, cursor, path);
    const replacement = replacementTextForMatch(hunk, match.text);
    updated = `${updated.slice(0, match.index)}${replacement}${updated.slice(match.index + match.text.length)}`;
    cursor = match.index + replacement.length;
  }
  return updated;
}

function normalizeExpectedFiles(expectedFiles, expectedFilesSnake) {
  return [
    ...(Array.isArray(expectedFiles) ? expectedFiles : []),
    ...(Array.isArray(expectedFilesSnake) ? expectedFilesSnake : []),
  ]
    .filter(isRecord)
    .map((entry) => ({
      path: typeof entry.path === 'string' ? entry.path : '',
      sha256: typeof entry.sha256 === 'string' ? entry.sha256 : undefined,
    }))
    .filter((entry) => entry.path);
}

async function assertExpectedPatchFiles(expectedFiles) {
  for (const expectedFile of expectedFiles) {
    const resolved = await resolveWorkspaceFilePath(expectedFile.path);
    if (!expectedFile.sha256) {
      continue;
    }

    const content = await readFile(resolved, 'utf8');
    if (sha256Hex(content) !== expectedFile.sha256) {
      const error = new Error(`Expected sha256 did not match for ${expectedFile.path}`);
      error.code = 'expected_file_mismatch';
      throw error;
    }
  }
}

async function prepareWorkspacePatchChange(operation) {
  const requireExisting = operation.kind !== 'add';
  const resolved = await resolveWorkspaceFilePath(operation.path, { requireExisting });
  if (isReservedWorkspacePath(resolved)) {
    throw new Error('Lifecycle-managed skill files are read-only');
  }

  const exists = await fileExists(resolved);
  if (operation.kind === 'add' && exists) {
    throw new Error(`Cannot add ${operation.path}; file already exists.`);
  }
  if (operation.kind !== 'add' && !exists) {
    throw new Error(`Cannot ${operation.kind} ${operation.path}; file does not exist.`);
  }

  const before = exists ? await readFile(resolved, 'utf8') : '';
  const beforeInfo = exists ? await stat(resolved) : null;
  if (beforeInfo && !beforeInfo.isFile()) {
    throw new Error(`Patch path must be a file: ${operation.path}`);
  }

  const after =
    operation.kind === 'add'
      ? operation.content
      : operation.kind === 'delete'
      ? ''
      : applyPatchHunks(before, operation.hunks, operation.path);

  return {
    absolutePath: resolved,
    path: formatWorkspaceDisplayPath(resolved),
    kind: operation.kind === 'add' ? 'created' : operation.kind === 'delete' ? 'deleted' : 'edited',
    before,
    after,
    beforeExists: exists,
  };
}

async function buildWorkspacePatchChanges(operations) {
  const changes = [];
  const seenPaths = new Set();
  for (const operation of operations) {
    const change = await prepareWorkspacePatchChange(operation);
    if (seenPaths.has(change.absolutePath)) {
      throw new Error(`Patch contains multiple operations for ${change.path}.`);
    }
    seenPaths.add(change.absolutePath);
    changes.push(change);
  }
  return changes;
}

async function rollbackWorkspacePatchChanges(appliedChanges) {
  for (const change of [...appliedChanges].reverse()) {
    try {
      if (!change.beforeExists) {
        await rm(change.absolutePath, { force: true });
        continue;
      }

      await mkdir(dirname(change.absolutePath), { recursive: true });
      await writeFile(change.absolutePath, change.before, 'utf8');
    } catch {
      // Preserve the original patch failure; rollback best-effort details are not model-actionable here.
    }
  }
}

async function assertPostPatchBoundary(change) {
  if (change.kind === 'deleted') {
    return;
  }

  const boundary = await resolveWorkspaceBoundary(change.absolutePath);
  assertNotProtectedWorkspacePath(boundary, change.path);
}

function combineFileChangeDiffs(fileChanges) {
  return fileChanges.map((change) => change.unifiedDiff).filter(Boolean).join('\n');
}

async function applyWorkspacePatch({
  patch,
  format = 'codex_v4a',
  expectedFiles,
  expected_files: expectedFilesSnake,
} = {}) {
  if (format !== 'codex_v4a') {
    throw new Error(`Unsupported patch format: ${format}`);
  }

  const operations = parseWorkspacePatch(patch);
  await assertExpectedPatchFiles(normalizeExpectedFiles(expectedFiles, expectedFilesSnake));
  const changes = await buildWorkspacePatchChanges(operations);
  const fileChanges = [];
  for (const change of changes) {
    fileChanges.push(
      await buildFileChangeArtifact({
        path: change.path,
        kind: change.kind,
        before: change.before,
        after: change.after,
      })
    );
  }

  const appliedChanges = [];
  try {
    for (const change of changes) {
      if (change.kind === 'deleted') {
        await rm(change.absolutePath);
      } else {
        await mkdir(dirname(change.absolutePath), { recursive: true });
        await writeFile(change.absolutePath, change.after, 'utf8');
        await assertPostPatchBoundary(change);
      }
      appliedChanges.push(change);
    }
  } catch (error) {
    await rollbackWorkspacePatchChanges(appliedChanges);
    throw error;
  }

  const changedFiles = changes.map((change) => change.path);
  return {
    applied: true,
    changed_files: changedFiles,
    changedFiles,
    diff: combineFileChangeDiffs(fileChanges),
    fileChanges,
  };
}

async function snapshotWorkspaceTextFiles() {
  const snapshot = new Map();
  const files = await collectFilesUnderPath('.');

  for (const absolutePath of files) {
    try {
      if (isReservedWorkspacePath(absolutePath)) {
        continue;
      }
      const text = await readFile(absolutePath, 'utf8');
      snapshot.set(toWorkspaceRelativePath(absolutePath), text);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
  }

  return snapshot;
}

async function buildFileChangesFromSnapshots(beforeSnapshot, afterSnapshot) {
  const changedPaths = [...new Set([...beforeSnapshot.keys(), ...afterSnapshot.keys()])]
    .filter((path) => beforeSnapshot.get(path) !== afterSnapshot.get(path))
    .sort();
  const newGitRepoInfoCache = new Map();
  const candidates = [];

  for (const path of changedPaths) {
    const candidate = await normalizeSnapshotChangeCandidate({
      path,
      beforeSnapshot,
      afterSnapshot,
      newGitRepoInfoCache,
    });

    if (candidate) {
      candidates.push(candidate);
    }
  }

  const limitedCandidates = candidates.slice(0, MAX_EXEC_FILE_CHANGES);
  const fileChanges = [];

  for (const candidate of limitedCandidates) {
    fileChanges.push(
      await buildFileChangeArtifact({
        path: candidate.path,
        kind: candidate.kind,
        before: candidate.before,
        after: candidate.after,
      })
    );
  }

  return {
    fileChanges,
    fileChangesTruncated: candidates.length > limitedCandidates.length,
  };
}

function getCommandErrorFileChanges(error) {
  return isRecord(error) && Array.isArray(error.fileChanges) ? error.fileChanges : [];
}

function getCommandErrorFileChangesTruncated(error) {
  return isRecord(error) && error.fileChangesTruncated === true;
}

function commandErrorText(message, error) {
  const fileChanges = getCommandErrorFileChanges(error);
  const fileChangesTruncated = getCommandErrorFileChangesTruncated(error);
  const stdout = isRecord(error) && typeof error.stdout === 'string' ? truncateText(error.stdout) : null;
  const stderr = isRecord(error) && typeof error.stderr === 'string' ? truncateText(error.stderr) : null;
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : null;

  return textResult({
    ok: false,
    ...(code ? { code } : {}),
    error: message,
    details: error instanceof Error ? error.message : String(error),
    ...(typeof error?.operationId === 'string' ? { operationId: error.operationId } : {}),
    ...(typeof error?.status === 'string' ? { status: error.status } : {}),
    ...(typeof error?.exitCode !== 'undefined' ? { exitCode: error.exitCode } : {}),
    ...(typeof error?.signal !== 'undefined' ? { signal: error.signal } : {}),
    ...(stdout !== null ? { stdout } : {}),
    ...(stderr !== null ? { stderr } : {}),
    ...(fileChanges.length > 0 ? { fileChanges } : {}),
    ...(fileChangesTruncated ? { fileChangesTruncated } : {}),
  });
}

const TERMINAL_OPERATION_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'canceled']);
const workspaceOperations = new Map();
let nextOperationSequence = 0;
const TERMINAL_SERVICE_STATUSES = new Set(['stopped', 'exited', 'failed']);
const workspaceServices = new Map();
let nextServiceSequence = 0;

function clampPositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return Math.min(fallback, max);
  }

  return Math.min(parsed, max);
}

function clampNonNegativeInt(value, fallback, max) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return Math.min(fallback, max);
  }

  return Math.min(parsed, max);
}

function resolveOperationMaxDurationMs({ timeoutMs, maxDurationMs } = {}) {
  return clampPositiveInt(maxDurationMs ?? timeoutMs, DEFAULT_OPERATION_MAX_DURATION_MS, MAX_OPERATION_DURATION_MS);
}

function resolveOperationWaitMs(value, fallback = DEFAULT_OPERATION_WAIT_MS) {
  return clampNonNegativeInt(value, fallback, MAX_OPERATION_WAIT_MS);
}

function createOperationId() {
  nextOperationSequence += 1;
  return `op_${Date.now().toString(36)}_${nextOperationSequence.toString(36)}`;
}

function createServiceId(serviceName) {
  nextServiceSequence += 1;
  return `svc_${serviceName}_${Date.now().toString(36)}_${nextServiceSequence.toString(36)}`;
}

function createBoundedLog(maxChars) {
  return {
    text: '',
    omittedChars: 0,
    maxChars,
    append(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      if (!value) {
        return;
      }

      this.text += value;
      if (this.text.length > this.maxChars) {
        const overflow = this.text.length - this.maxChars;
        this.text = this.text.slice(overflow);
        this.omittedChars += overflow;
      }
    },
    read(limit = this.maxChars) {
      const max = Math.max(0, Math.min(limit, this.maxChars));
      if (this.text.length <= max) {
        return {
          text: this.text,
          truncated: this.omittedChars > 0,
          omittedChars: this.omittedChars,
        };
      }

      const readOmitted = this.text.length - max;
      return {
        text: this.text.slice(readOmitted),
        truncated: true,
        omittedChars: this.omittedChars + readOmitted,
      };
    },
  };
}

function formatBoundedLog(log, maxChars = MAX_COMMAND_OUTPUT_CHARS) {
  return formatBoundedLogRead(log.read(maxChars));
}

function formatBoundedLogRead(result) {
  if (!result.truncated) {
    return result.text;
  }

  return `[truncated oldest ${result.omittedChars} chars]\n${result.text}`;
}

function signalChildProcess(child, signal) {
  if (!child) {
    return;
  }

  const pid = child.pid;
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the shell process below; close/finalize handles races.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // Ignore process races; close/finalize handles the terminal state.
  }
}

function isOperationTerminal(operation) {
  return TERMINAL_OPERATION_STATUSES.has(operation.status);
}

function operationDurationMs(operation) {
  const end = operation.endedAt ? Date.parse(operation.endedAt) : Date.now();
  return Math.max(0, end - Date.parse(operation.startedAt));
}

function notifyOperationWaiters(operation) {
  const waiters = operation.waiters.splice(0);
  for (const waiter of waiters) {
    waiter();
  }
}

function cleanupWorkspaceOperations() {
  const now = Date.now();

  for (const [operationId, operation] of workspaceOperations.entries()) {
    if (!isOperationTerminal(operation) || !operation.endedAt) {
      continue;
    }

    if (now - Date.parse(operation.endedAt) > OPERATION_RETENTION_MS) {
      workspaceOperations.delete(operationId);
    }
  }

  const terminalOperations = [...workspaceOperations.values()]
    .filter((operation) => isOperationTerminal(operation))
    .sort((left, right) => Date.parse(left.endedAt || left.startedAt) - Date.parse(right.endedAt || right.startedAt));

  while (workspaceOperations.size > MAX_OPERATION_COUNT && terminalOperations.length > 0) {
    const operation = terminalOperations.shift();
    workspaceOperations.delete(operation.id);
  }
}

function assertOperationCapacity() {
  cleanupWorkspaceOperations();
  if (workspaceOperations.size < MAX_OPERATION_COUNT) {
    return;
  }

  throw new Error(`Too many workspace operations are retained; limit is ${MAX_OPERATION_COUNT}`);
}

async function finalizeWorkspaceOperation(operation, { exitCode = null, signal = null } = {}) {
  if (operation.finalizePromise) {
    return operation.finalizePromise;
  }

  operation.finalizePromise = (async () => {
    if (operation.timeoutHandle) {
      clearTimeout(operation.timeoutHandle);
    }
    if (operation.killHandle) {
      clearTimeout(operation.killHandle);
    }

    operation.exitCode = exitCode;
    operation.signal = signal;

    if (operation.beforeSnapshot) {
      try {
        const changes = await buildFileChangesFromSnapshots(
          operation.beforeSnapshot,
          await snapshotWorkspaceTextFiles()
        );
        operation.fileChanges = changes.fileChanges;
        operation.fileChangesTruncated = changes.fileChangesTruncated;
      } catch (error) {
        operation.fileChangeError = error instanceof Error ? error.message : String(error);
      }
    }

    operation.endedAt = new Date().toISOString();
    if (operation.timedOut) {
      operation.status = 'timed_out';
      operation.error = `Operation exceeded maxDurationMs=${operation.maxDurationMs}`;
    } else if (operation.cancelRequested) {
      operation.status = 'canceled';
      operation.error = 'Operation was canceled';
    } else if (operation.spawnError) {
      operation.status = 'failed';
      operation.error =
        operation.spawnError instanceof Error ? operation.spawnError.message : String(operation.spawnError);
    } else if (operation.fileChangeError) {
      operation.status = 'failed';
      operation.errorCode = 'file_change_capture_failed';
      operation.error = 'Unable to capture file changes after command execution';
    } else if (exitCode === 0) {
      operation.status = 'succeeded';
    } else {
      operation.status = 'failed';
      operation.error = `Command exited with code ${exitCode ?? 'unknown'}${signal ? ` signal ${signal}` : ''}`;
    }

    notifyOperationWaiters(operation);
    cleanupWorkspaceOperations();
    return operation;
  })();

  return operation.finalizePromise;
}

function requestWorkspaceOperationTermination(operation, reason) {
  if (isOperationTerminal(operation)) {
    return false;
  }

  const alreadyRequested = operation.timedOut || operation.cancelRequested;
  if (reason === 'timed_out') {
    if (!operation.cancelRequested) {
      operation.timedOut = true;
    }
  } else if (reason === 'canceled') {
    if (!operation.timedOut) {
      operation.cancelRequested = true;
    }
  }

  const newlyRequested = !alreadyRequested && (operation.timedOut || operation.cancelRequested);
  if (newlyRequested) {
    signalWorkspaceOperation(operation, 'SIGTERM');
  }

  if (!operation.killHandle && (operation.timedOut || operation.cancelRequested)) {
    operation.killHandle = setTimeout(() => {
      if (isOperationTerminal(operation)) {
        return;
      }

      signalWorkspaceOperation(operation, 'SIGKILL');
    }, OPERATION_KILL_GRACE_MS);
  }

  return newlyRequested;
}

function signalWorkspaceOperation(operation, signal) {
  signalChildProcess(operation.child, signal);
}

async function startWorkspaceOperation({ command, cwd = '.', timeoutMs, maxDurationMs, captureFileChanges = false }) {
  assertOperationCapacity();

  const resolvedCwd = await resolveWorkspaceFilePath(cwd);
  const beforeSnapshot = captureFileChanges ? await snapshotWorkspaceTextFiles() : null;
  const operationMaxDurationMs = resolveOperationMaxDurationMs({ timeoutMs, maxDurationMs });
  const operation = {
    id: createOperationId(),
    command,
    cwd: toWorkspaceRelativePath(resolvedCwd),
    absoluteCwd: resolvedCwd,
    pid: null,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    maxDurationMs: operationMaxDurationMs,
    exitCode: null,
    signal: null,
    error: null,
    errorCode: null,
    fileChangeError: null,
    fileChanges: [],
    fileChangesTruncated: false,
    captureFileChanges: captureFileChanges === true,
    beforeSnapshot,
    stdoutLog: createBoundedLog(MAX_OPERATION_LOG_CHARS),
    stderrLog: createBoundedLog(MAX_OPERATION_LOG_CHARS),
    child: null,
    timedOut: false,
    cancelRequested: false,
    spawnError: null,
    timeoutHandle: null,
    killHandle: null,
    finalizePromise: null,
    waiters: [],
  };

  workspaceOperations.set(operation.id, operation);

  try {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: resolvedCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: buildAgentCommandEnv(process.env, {
        HOME: process.env.HOME || WORKSPACE_ROOT,
      }),
    });

    operation.child = child;
    operation.pid = child.pid || null;
    operation.timeoutHandle = setTimeout(() => {
      requestWorkspaceOperationTermination(operation, 'timed_out');
    }, operationMaxDurationMs);

    child.stdout?.on('data', (chunk) => {
      operation.stdoutLog.append(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      operation.stderrLog.append(chunk);
    });
    child.on('error', (error) => {
      operation.spawnError = error;
    });
    child.on('close', (exitCode, signal) => {
      void finalizeWorkspaceOperation(operation, { exitCode, signal });
    });

    return operation;
  } catch (error) {
    operation.spawnError = error;
    await finalizeWorkspaceOperation(operation, {});
    throw error;
  }
}

function getWorkspaceOperation(operationId) {
  cleanupWorkspaceOperations();
  const operation = workspaceOperations.get(operationId);
  if (!operation) {
    throw new Error(`Workspace operation not found: ${operationId}`);
  }

  return operation;
}

function buildOperationSnapshot(operation, { includeLogs = false, maxChars = MAX_COMMAND_OUTPUT_CHARS } = {}) {
  const snapshot = {
    operationId: operation.id,
    status: operation.status,
    running: !isOperationTerminal(operation),
    command: operation.command,
    cwd: operation.cwd,
    pid: operation.pid,
    startedAt: operation.startedAt,
    endedAt: operation.endedAt,
    durationMs: operationDurationMs(operation),
    maxDurationMs: operation.maxDurationMs,
    exitCode: operation.exitCode,
    signal: operation.signal,
    success: operation.status === 'succeeded',
    ...(operation.errorCode ? { code: operation.errorCode } : {}),
    ...(operation.error ? { error: operation.error } : {}),
    ...(operation.fileChangeError ? { fileChangeError: operation.fileChangeError } : {}),
    ...(operation.fileChanges.length > 0 ? { fileChanges: operation.fileChanges } : {}),
    ...(operation.fileChangesTruncated ? { fileChangesTruncated: true } : {}),
  };

  if (!includeLogs) {
    return snapshot;
  }

  const stdout = operation.stdoutLog.read(maxChars);
  const stderr = operation.stderrLog.read(maxChars);

  return {
    ...snapshot,
    stdout: formatBoundedLogRead(stdout),
    stderr: formatBoundedLogRead(stderr),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

function buildWorkspaceCommandResult(operation) {
  return {
    operationId: operation.id,
    status: operation.status,
    cwd: operation.cwd,
    stdout: formatBoundedLog(operation.stdoutLog, MAX_COMMAND_OUTPUT_CHARS),
    stderr: formatBoundedLog(operation.stderrLog, MAX_COMMAND_OUTPUT_CHARS),
    success: operation.status === 'succeeded',
    ...(operation.errorCode ? { code: operation.errorCode } : {}),
    exitCode: operation.exitCode,
    signal: operation.signal,
    durationMs: operationDurationMs(operation),
    ...(operation.fileChanges.length > 0 ? { fileChanges: operation.fileChanges } : {}),
    ...(operation.fileChangesTruncated ? { fileChangesTruncated: true } : {}),
    ...(operation.fileChangeError ? { fileChangeError: operation.fileChangeError } : {}),
  };
}

function buildWorkspaceCommandError(operation) {
  const result = buildWorkspaceCommandResult(operation);
  const error = new Error(operation.error || 'Workspace command failed');
  if (operation.errorCode) {
    error.code = operation.errorCode;
  }
  Object.assign(error, result);
  return error;
}

async function waitForWorkspaceOperation(operationId, { waitMs, includeLogs = false, maxChars } = {}) {
  const operation = getWorkspaceOperation(operationId);
  if (!isOperationTerminal(operation)) {
    const effectiveWaitMs = resolveOperationWaitMs(waitMs, 0);
    if (effectiveWaitMs > 0) {
      await new Promise((resolveWait) => {
        let waiter;
        const timeoutHandle = setTimeout(() => {
          const index = operation.waiters.indexOf(waiter);
          if (index >= 0) {
            operation.waiters.splice(index, 1);
          }
          resolveWait();
        }, effectiveWaitMs);

        waiter = () => {
          clearTimeout(timeoutHandle);
          resolveWait();
        };
        operation.waiters.push(waiter);
      });
    }
  }

  return buildOperationSnapshot(operation, {
    includeLogs,
    maxChars: clampPositiveInt(maxChars, MAX_COMMAND_OUTPUT_CHARS, MAX_OPERATION_LOG_CHARS),
  });
}

function readWorkspaceOperationLogs(operationId, { stream = 'both', maxChars } = {}) {
  const operation = getWorkspaceOperation(operationId);
  const effectiveMaxChars = clampPositiveInt(maxChars, MAX_COMMAND_OUTPUT_CHARS, MAX_OPERATION_LOG_CHARS);
  const result = buildOperationSnapshot(operation);

  if (stream === 'stdout') {
    const stdout = operation.stdoutLog.read(effectiveMaxChars);
    return {
      ...result,
      stream,
      text: formatBoundedLogRead(stdout),
      truncated: stdout.truncated,
      omittedChars: stdout.omittedChars,
    };
  }

  if (stream === 'stderr') {
    const stderr = operation.stderrLog.read(effectiveMaxChars);
    return {
      ...result,
      stream,
      text: formatBoundedLogRead(stderr),
      truncated: stderr.truncated,
      omittedChars: stderr.omittedChars,
    };
  }

  const stdout = operation.stdoutLog.read(effectiveMaxChars);
  const stderr = operation.stderrLog.read(effectiveMaxChars);
  return {
    ...result,
    stream: 'both',
    stdout: formatBoundedLogRead(stdout),
    stderr: formatBoundedLogRead(stderr),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

function cancelWorkspaceOperation(operationId) {
  const operation = getWorkspaceOperation(operationId);
  const cancellationRequested = requestWorkspaceOperationTermination(operation, 'canceled');
  return {
    ...buildOperationSnapshot(operation),
    cancellationRequested,
  };
}

function listWorkspaceOperations({ includeCompleted = true, limit = 20 } = {}) {
  cleanupWorkspaceOperations();
  const effectiveLimit = clampPositiveInt(limit, 20, 100);
  const operations = [...workspaceOperations.values()]
    .filter((operation) => includeCompleted || !isOperationTerminal(operation))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, effectiveLimit)
    .map((operation) => buildOperationSnapshot(operation));

  return {
    count: operations.length,
    operations,
  };
}

async function cancelAllWorkspaceOperations({ waitMs = OPERATION_KILL_GRACE_MS + 1000 } = {}) {
  const operations = [...workspaceOperations.values()].filter((operation) => !isOperationTerminal(operation));
  for (const operation of operations) {
    requestWorkspaceOperationTermination(operation, 'canceled');
  }

  await Promise.all(
    operations.map((operation) => waitForWorkspaceOperation(operation.id, { waitMs }).catch(() => null))
  );

  return listWorkspaceOperations({ includeCompleted: true, limit: MAX_OPERATION_COUNT });
}

async function runWorkspaceCommand({
  command,
  cwd = '.',
  timeoutMs,
  maxDurationMs,
  captureFileChanges = false,
  async: asyncRequested = false,
  waitMs,
}) {
  const operation = await startWorkspaceOperation({
    command,
    cwd,
    timeoutMs,
    maxDurationMs,
    captureFileChanges,
  });
  const requestedOperationHandle = asyncRequested === true || typeof waitMs !== 'undefined';
  const effectiveWaitMs =
    asyncRequested === true && typeof waitMs === 'undefined'
      ? 0
      : typeof waitMs === 'undefined'
      ? operation.maxDurationMs + OPERATION_KILL_GRACE_MS
      : resolveOperationWaitMs(waitMs, 0);

  if (effectiveWaitMs > 0) {
    await waitForWorkspaceOperation(operation.id, { waitMs: effectiveWaitMs });
  }

  if (!isOperationTerminal(operation)) {
    return buildOperationSnapshot(operation, {
      includeLogs: true,
      maxChars: MAX_COMMAND_OUTPUT_CHARS,
    });
  }

  if (operation.status !== 'succeeded' && !requestedOperationHandle) {
    throw buildWorkspaceCommandError(operation);
  }

  return requestedOperationHandle
    ? buildOperationSnapshot(operation, {
        includeLogs: true,
        maxChars: MAX_COMMAND_OUTPUT_CHARS,
      })
    : buildWorkspaceCommandResult(operation);
}

function normalizeServiceName(name = 'app') {
  const normalized = typeof name === 'string' && name.trim() ? name.trim() : 'app';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(normalized)) {
    throw new Error(
      'Service name must start with a letter or number and contain only letters, numbers, dots, underscores, or dashes'
    );
  }

  return normalized;
}

function normalizeOptionalServiceName(name) {
  return typeof name === 'string' && name.trim() ? normalizeServiceName(name) : null;
}

function resolveWorkspaceServiceName({ serviceName, name } = {}) {
  const primaryName = normalizeOptionalServiceName(serviceName);
  const aliasName = normalizeOptionalServiceName(name);
  if (primaryName && aliasName && primaryName !== aliasName) {
    throw new Error('serviceName and name must match when both are provided');
  }

  return primaryName || aliasName || 'app';
}

function normalizeServicePort(port) {
  if (typeof port === 'undefined' || port === null || port === '') {
    return null;
  }

  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('Service port must be an integer between 1 and 65535');
  }

  return parsed;
}

function isServiceTerminal(service) {
  return TERMINAL_SERVICE_STATUSES.has(service.status);
}

function serviceDurationMs(service) {
  const end = service.endedAt ? Date.parse(service.endedAt) : Date.now();
  return Math.max(0, end - Date.parse(service.startedAt));
}

function notifyServiceWaiters(service) {
  const waiters = service.waiters.splice(0);
  for (const waiter of waiters) {
    waiter();
  }
}

function cleanupWorkspaceServices() {
  const now = Date.now();

  for (const [name, service] of workspaceServices.entries()) {
    if (!isServiceTerminal(service) || !service.endedAt) {
      continue;
    }

    if (now - Date.parse(service.endedAt) > SERVICE_RETENTION_MS) {
      workspaceServices.delete(name);
    }
  }

  const terminalServices = [...workspaceServices.values()]
    .filter((service) => isServiceTerminal(service))
    .sort((left, right) => Date.parse(left.endedAt || left.startedAt) - Date.parse(right.endedAt || right.startedAt));

  while (workspaceServices.size > MAX_SERVICE_COUNT && terminalServices.length > 0) {
    const service = terminalServices.shift();
    workspaceServices.delete(service.name);
  }
}

function assertServiceCapacity(name) {
  cleanupWorkspaceServices();
  if (workspaceServices.has(name) || workspaceServices.size < MAX_SERVICE_COUNT) {
    return;
  }

  throw new Error(`Too many workspace services are retained; limit is ${MAX_SERVICE_COUNT}`);
}

async function finalizeWorkspaceService(service, { exitCode = null, signal = null } = {}) {
  if (service.finalizePromise) {
    return service.finalizePromise;
  }

  service.finalizePromise = (async () => {
    if (service.killHandle) {
      clearTimeout(service.killHandle);
    }

    service.exitCode = exitCode;
    service.signal = signal;
    service.endedAt = new Date().toISOString();

    if (service.spawnError) {
      service.status = 'failed';
      service.error = service.spawnError instanceof Error ? service.spawnError.message : String(service.spawnError);
    } else if (service.stopRequested) {
      service.status = 'stopped';
    } else if (exitCode === 0) {
      service.status = 'exited';
    } else {
      service.status = 'failed';
      service.error = `Service exited with code ${exitCode ?? 'unknown'}${signal ? ` signal ${signal}` : ''}`;
    }

    notifyServiceWaiters(service);
    cleanupWorkspaceServices();
    return service;
  })();

  return service.finalizePromise;
}

function requestWorkspaceServiceStop(service) {
  if (isServiceTerminal(service)) {
    return false;
  }

  const newlyRequested = service.stopRequested !== true;
  service.stopRequested = true;
  service.status = 'stopping';

  if (newlyRequested) {
    signalChildProcess(service.child, 'SIGTERM');
  }

  if (!service.killHandle) {
    service.killHandle = setTimeout(() => {
      if (isServiceTerminal(service)) {
        return;
      }

      signalChildProcess(service.child, 'SIGKILL');
    }, SERVICE_STOP_GRACE_MS);
  }

  return newlyRequested;
}

async function waitForWorkspaceServiceObject(service, waitMs = 0) {
  if (isServiceTerminal(service)) {
    return;
  }

  const effectiveWaitMs = resolveOperationWaitMs(waitMs, 0);
  if (effectiveWaitMs < 1) {
    return;
  }

  await new Promise((resolveWait) => {
    let waiter;
    const timeoutHandle = setTimeout(() => {
      const index = service.waiters.indexOf(waiter);
      if (index >= 0) {
        service.waiters.splice(index, 1);
      }
      resolveWait();
    }, effectiveWaitMs);

    waiter = () => {
      clearTimeout(timeoutHandle);
      resolveWait();
    };
    service.waiters.push(waiter);
  });
}

async function waitForWorkspaceService(name = 'app', { waitMs = 0, includeLogs = false, maxChars } = {}) {
  const service = getWorkspaceService(name);
  await waitForWorkspaceServiceObject(service, waitMs);
  return buildServiceSnapshot(service, {
    includeLogs,
    maxChars: clampPositiveInt(maxChars, MAX_COMMAND_OUTPUT_CHARS, MAX_SERVICE_LOG_CHARS),
  });
}

async function startWorkspaceService({ name = 'app', command, cwd = '.', port, restart = false, waitMs = 0 }) {
  const serviceName = normalizeServiceName(name);
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('Service command is required');
  }
  const existing = workspaceServices.get(serviceName);
  if (existing && !isServiceTerminal(existing)) {
    if (restart !== true) {
      throw new Error(`Workspace service is already running: ${serviceName}`);
    }

    const stopped = await stopWorkspaceService(serviceName, {
      waitMs: SERVICE_STOP_GRACE_MS + 1000,
    });
    if (stopped.running) {
      throw new Error(`Workspace service is still stopping: ${serviceName}`);
    }
  }

  assertServiceCapacity(serviceName);

  const resolvedCwd = await resolveWorkspaceFilePath(cwd);
  const service = {
    id: createServiceId(serviceName),
    name: serviceName,
    command,
    cwd: toWorkspaceRelativePath(resolvedCwd),
    absoluteCwd: resolvedCwd,
    port: normalizeServicePort(port),
    pid: null,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    stdoutLog: createBoundedLog(MAX_SERVICE_LOG_CHARS),
    stderrLog: createBoundedLog(MAX_SERVICE_LOG_CHARS),
    child: null,
    stopRequested: false,
    spawnError: null,
    killHandle: null,
    finalizePromise: null,
    waiters: [],
  };

  workspaceServices.set(serviceName, service);

  try {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: resolvedCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: buildAgentCommandEnv(process.env, {
        HOME: process.env.HOME || WORKSPACE_ROOT,
      }),
    });

    service.child = child;
    service.pid = child.pid || null;

    child.stdout?.on('data', (chunk) => {
      service.stdoutLog.append(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      service.stderrLog.append(chunk);
    });
    child.on('error', (error) => {
      service.spawnError = error;
    });
    child.on('close', (exitCode, signal) => {
      void finalizeWorkspaceService(service, { exitCode, signal });
    });

    return waitForWorkspaceService(serviceName, {
      waitMs,
      includeLogs: true,
    });
  } catch (error) {
    service.spawnError = error;
    await finalizeWorkspaceService(service, {});
    throw error;
  }
}

function getWorkspaceService(name = 'app') {
  cleanupWorkspaceServices();
  const serviceName = normalizeServiceName(name);
  const service = workspaceServices.get(serviceName);
  if (!service) {
    throw new Error(`Workspace service not found: ${serviceName}`);
  }

  return service;
}

function buildServiceSnapshot(service, { includeLogs = false, maxChars = MAX_COMMAND_OUTPUT_CHARS } = {}) {
  const snapshot = {
    serviceId: service.id,
    name: service.name,
    status: service.status,
    running: !isServiceTerminal(service),
    command: service.command,
    cwd: service.cwd,
    port: service.port,
    pid: service.pid,
    startedAt: service.startedAt,
    endedAt: service.endedAt,
    durationMs: serviceDurationMs(service),
    exitCode: service.exitCode,
    signal: service.signal,
    ...(service.error ? { error: service.error } : {}),
  };

  if (!includeLogs) {
    return snapshot;
  }

  const stdout = service.stdoutLog.read(maxChars);
  const stderr = service.stderrLog.read(maxChars);

  return {
    ...snapshot,
    stdout: formatBoundedLogRead(stdout),
    stderr: formatBoundedLogRead(stderr),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

async function stopWorkspaceService(
  name = 'app',
  { waitMs = SERVICE_STOP_GRACE_MS + 1000, includeLogs = false, maxChars } = {}
) {
  const service = getWorkspaceService(name);
  const stopRequested = requestWorkspaceServiceStop(service);
  await waitForWorkspaceServiceObject(service, waitMs);

  return {
    ...buildServiceSnapshot(service, {
      includeLogs,
      maxChars: clampPositiveInt(maxChars, MAX_COMMAND_OUTPUT_CHARS, MAX_SERVICE_LOG_CHARS),
    }),
    stopRequested,
  };
}

function readWorkspaceServiceLogs(name = 'app', { stream = 'both', maxChars } = {}) {
  const service = getWorkspaceService(name);
  const effectiveMaxChars = clampPositiveInt(maxChars, MAX_COMMAND_OUTPUT_CHARS, MAX_SERVICE_LOG_CHARS);
  const result = buildServiceSnapshot(service);

  if (stream === 'stdout') {
    const stdout = service.stdoutLog.read(effectiveMaxChars);
    return {
      ...result,
      stream,
      text: formatBoundedLogRead(stdout),
      truncated: stdout.truncated,
      omittedChars: stdout.omittedChars,
    };
  }

  if (stream === 'stderr') {
    const stderr = service.stderrLog.read(effectiveMaxChars);
    return {
      ...result,
      stream,
      text: formatBoundedLogRead(stderr),
      truncated: stderr.truncated,
      omittedChars: stderr.omittedChars,
    };
  }

  const stdout = service.stdoutLog.read(effectiveMaxChars);
  const stderr = service.stderrLog.read(effectiveMaxChars);
  return {
    ...result,
    stream: 'both',
    stdout: formatBoundedLogRead(stdout),
    stderr: formatBoundedLogRead(stderr),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

function listWorkspaceServices({ includeStopped = true, limit = 20 } = {}) {
  cleanupWorkspaceServices();
  const effectiveLimit = clampPositiveInt(limit, 20, 100);
  const services = [...workspaceServices.values()]
    .filter((service) => includeStopped || !isServiceTerminal(service))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, effectiveLimit)
    .map((service) => buildServiceSnapshot(service));

  return {
    count: services.length,
    services,
  };
}

async function stopAllWorkspaceServices({ waitMs = SERVICE_STOP_GRACE_MS + 1000 } = {}) {
  const services = [...workspaceServices.values()].filter((service) => !isServiceTerminal(service));
  await Promise.all(services.map((service) => stopWorkspaceService(service.name, { waitMs })));
  return listWorkspaceServices({ includeStopped: true, limit: MAX_SERVICE_COUNT });
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
    if (protectedPathRuleFor(relativePath)) {
      continue;
    }

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
  const resolved = await resolveWorkspaceFilePath(searchPath || '.');
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
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      continue;
    }

    for (const entry of entries) {
      const absolutePath = resolve(current, entry.name);
      if (protectedPathRuleFor(toWorkspaceRelativePath(absolutePath))) {
        continue;
      }

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        queue.push(absolutePath);
        continue;
      }

      if (isLikelyTextFile(absolutePath)) {
        try {
          files.push(await resolveWorkspaceFilePath(absolutePath));
        } catch (error) {
          if (error instanceof BoundaryPolicyError) {
            continue;
          }
          throw error;
        }
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

function parseHostAndPort(rawAddress) {
  const address = String(rawAddress || '').trim();
  const bracketed = address.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketed) {
    return { host: bracketed[1], port: Number.parseInt(bracketed[2], 10) };
  }

  const match = address.match(/^(.*):(\d+)$/);
  if (!match) {
    return { host: address || null, port: null };
  }

  return {
    host: match[1] || null,
    port: Number.parseInt(match[2], 10),
  };
}

function parseSsListeningPortLine(line) {
  const columns = line.trim().split(/\s+/);
  if (columns.length < 5 || columns[0] !== 'LISTEN') {
    return null;
  }

  const local = parseHostAndPort(columns[3]);
  if (!Number.isInteger(local.port)) {
    return null;
  }

  const processText = columns.slice(5).join(' ');
  const pidMatch = processText.match(/\bpid=(\d+)/);
  const nameMatch = processText.match(/"([^"]+)"/);

  return {
    source: 'live',
    protocol: 'tcp',
    state: columns[0],
    localAddress: local.host,
    port: local.port,
    peerAddress: columns[4] || null,
    process:
      pidMatch || nameMatch
        ? {
            pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : null,
            name: nameMatch ? nameMatch[1] : null,
          }
        : null,
  };
}

async function listLiveListeningPorts() {
  try {
    const { stdout } = await execFile('ss', ['-lntpH'], {
      timeout: LIVE_STATE_COMMAND_TIMEOUT_MS,
      maxBuffer: 128 * 1024,
    });
    return stdout.split('\n').map(parseSsListeningPortLine).filter(Boolean).slice(0, MAX_LIST_RESULTS);
  } catch {
    return [];
  }
}

function parseProcessLine(line) {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
  if (!match) {
    return null;
  }

  return {
    source: 'live',
    pid: Number.parseInt(match[1], 10),
    ppid: Number.parseInt(match[2], 10),
    status: match[3],
    command: match[4],
    args: match[5] || '',
  };
}

async function listLiveProcesses() {
  try {
    const { stdout } = await execFile('ps', ['-eo', 'pid=,ppid=,stat=,comm=,args='], {
      timeout: LIVE_STATE_COMMAND_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    return stdout.split('\n').map(parseProcessLine).filter(Boolean).slice(0, MAX_LIST_RESULTS);
  } catch {
    return [];
  }
}

async function readPortsState() {
  const snapshot = await loadSnapshot(PORTS_FILE, []);
  if (Array.isArray(snapshot) && snapshot.length > 0) {
    return snapshot;
  }

  return listLiveListeningPorts();
}

async function readProcessesState() {
  const snapshot = await loadSnapshot(PROCESSES_FILE, []);
  if (Array.isArray(snapshot) && snapshot.length > 0) {
    return snapshot;
  }

  return listLiveProcesses();
}

async function summarizeWorkspaceState() {
  const [topLevelEntries, sessionState, portsState, processesState, servicesState, gitState] = await Promise.all([
    walkFiles(WORKSPACE_ROOT),
    loadSnapshot(STATE_FILE, null),
    readPortsState(),
    readProcessesState(),
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
  if (!isWithinSkillRoot(entryRoot, sourceRoot)) {
    throw new Error(`Skill entry path must stay within source repo: ${normalizedPath}`);
  }

  const filePath = resolve(entryRoot, normalizedFile);
  if (!isWithinSkillRoot(filePath, sourceRoot)) {
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
  const text =
    raw.length > MAX_READ_CHARS ? `${raw.slice(0, MAX_READ_CHARS)}\n\n[truncated to ${MAX_READ_CHARS} chars]` : raw;

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
        return textResult(await readWorkspaceFile({ path, maxChars, startLine, endLine }));
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
          ...(await writeWorkspaceFile(path, content)),
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
          ...(await editWorkspaceFile({ path, oldText, newText, replaceAll: replaceAll === true })),
        });
      } catch (error) {
        return errorText('Unable to edit file', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'workspace.list_files',
    {
      title: 'List workspace files',
      description: 'List files and directories under a workspace path with bounded depth and result count.',
      inputSchema: {
        path: z.string().optional().describe('Workspace-relative path or absolute path inside the workspace'),
        depth: z.number().int().nonnegative().max(MAX_LIST_DEPTH).optional().describe('Directory depth to traverse'),
        includeHidden: z.boolean().optional().describe('Include dotfiles and dot-directories'),
        include_hidden: z.boolean().optional().describe('Snake-case alias for includeHidden'),
        respectGitignore: z.boolean().optional().describe('Skip noisy generated directories by default'),
        respect_gitignore: z.boolean().optional().describe('Snake-case alias for respectGitignore'),
        limit: z.number().int().positive().max(MAX_LIST_RESULTS).optional().describe('Maximum entries to return'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path, depth, includeHidden, include_hidden, respectGitignore, respect_gitignore, limit }) => {
      try {
        return textResult(
          await listWorkspaceFiles({
            path: path || '.',
            depth,
            includeHidden,
            include_hidden,
            respectGitignore,
            respect_gitignore,
            limit,
          })
        );
      } catch (error) {
        return errorText('Unable to list workspace files', error instanceof Error ? error.message : String(error));
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
    'workspace.apply_patch',
    {
      title: 'Apply workspace patch',
      description: 'Apply a Codex-style multi-file patch inside the workspace.',
      inputSchema: {
        patch: z.string().min(1).describe('Patch text starting with *** Begin Patch'),
        format: z.enum(['codex_v4a']).optional().describe('Patch grammar identifier'),
        expectedFiles: z
          .array(
            z.object({
              path: z.string().min(1),
              sha256: z.string().optional(),
            })
          )
          .optional()
          .describe('Optional optimistic concurrency checks'),
        expected_files: z
          .array(
            z.object({
              path: z.string().min(1),
              sha256: z.string().optional(),
            })
          )
          .optional()
          .describe('Snake-case alias for expectedFiles'),
        reason: z.string().optional().describe('Optional caller reason for audit context'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ patch, format, expectedFiles, expected_files }) => {
      try {
        return textResult({
          ok: true,
          ...(await applyWorkspacePatch({ patch, format, expectedFiles, expected_files })),
        });
      } catch (error) {
        return errorText('Unable to apply patch', error instanceof Error ? error.message : String(error));
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
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(MAX_OPERATION_DURATION_MS)
          .optional()
          .describe('Backward-compatible alias for maxDurationMs, capped by the gateway.'),
        maxDurationMs: z
          .number()
          .int()
          .positive()
          .max(MAX_OPERATION_DURATION_MS)
          .optional()
          .describe('Maximum operation runtime in milliseconds before the gateway terminates the process.'),
        async: z.boolean().optional().describe('Return an operation handle without waiting for command completion.'),
        waitMs: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_OPERATION_WAIT_MS)
          .optional()
          .describe('Maximum time to wait for completion before returning a running operation handle.'),
        captureFileChanges: z.boolean().optional().describe('Internal Lifecycle flag for file-change capture'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ command, cwd, timeoutMs, maxDurationMs, async: asyncRequested, waitMs, captureFileChanges }) => {
      try {
        return textResult({
          ok: true,
          command,
          ...(await runWorkspaceCommand({
            command,
            cwd: cwd || '.',
            timeoutMs,
            maxDurationMs,
            async: asyncRequested === true,
            waitMs,
            captureFileChanges: captureFileChanges === true,
          })),
        });
      } catch (error) {
        return commandErrorText('Unable to run workspace command', error);
      }
    }
  );

  server.registerTool(
    'workspace.operation_status',
    {
      title: 'Get workspace operation status',
      description: 'Return metadata for a workspace command operation by operationId.',
      inputSchema: {
        operationId: z.string().min(1).describe('Operation id returned by workspace.exec or workspace.operation_list'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ operationId }) => {
      try {
        return textResult({
          ok: true,
          ...buildOperationSnapshot(getWorkspaceOperation(operationId)),
        });
      } catch (error) {
        return errorText(
          'Unable to read workspace operation status',
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  );

  server.registerTool(
    'workspace.operation_wait',
    {
      title: 'Wait for workspace operation',
      description: 'Wait briefly for a workspace command operation and return its current status and bounded logs.',
      inputSchema: {
        operationId: z.string().min(1).describe('Operation id returned by workspace.exec or workspace.operation_list'),
        waitMs: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_OPERATION_WAIT_MS)
          .optional()
          .describe('Maximum time to wait before returning the current operation state.'),
        maxChars: z
          .number()
          .int()
          .positive()
          .max(MAX_OPERATION_LOG_CHARS)
          .optional()
          .describe('Maximum log chars per stream'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ operationId, waitMs, maxChars }) => {
      try {
        return textResult({
          ok: true,
          ...(await waitForWorkspaceOperation(operationId, {
            waitMs: resolveOperationWaitMs(waitMs),
            includeLogs: true,
            maxChars,
          })),
        });
      } catch (error) {
        return errorText(
          'Unable to wait for workspace operation',
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  );

  server.registerTool(
    'workspace.operation_logs',
    {
      title: 'Read workspace operation logs',
      description: 'Return bounded stdout and stderr for a workspace command operation.',
      inputSchema: {
        operationId: z.string().min(1).describe('Operation id returned by workspace.exec or workspace.operation_list'),
        stream: z.enum(['stdout', 'stderr', 'both']).optional().describe('Log stream to return'),
        maxChars: z
          .number()
          .int()
          .positive()
          .max(MAX_OPERATION_LOG_CHARS)
          .optional()
          .describe('Maximum log chars per stream'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ operationId, stream, maxChars }) => {
      try {
        return textResult({
          ok: true,
          ...readWorkspaceOperationLogs(operationId, { stream: stream || 'both', maxChars }),
        });
      } catch (error) {
        return errorText(
          'Unable to read workspace operation logs',
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  );

  server.registerTool(
    'workspace.operation_cancel',
    {
      title: 'Cancel workspace operation',
      description: 'Terminate a running workspace command operation.',
      inputSchema: {
        operationId: z.string().min(1).describe('Operation id returned by workspace.exec or workspace.operation_list'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ operationId }) => {
      try {
        return textResult({
          ok: true,
          ...cancelWorkspaceOperation(operationId),
        });
      } catch (error) {
        return errorText(
          'Unable to cancel workspace operation',
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  );

  server.registerTool(
    'workspace.operation_list',
    {
      title: 'List workspace operations',
      description: 'List retained workspace command operations.',
      inputSchema: {
        includeCompleted: z
          .boolean()
          .optional()
          .describe('Include completed, failed, timed out, and canceled operations'),
        limit: z.number().int().positive().max(100).optional().describe('Maximum number of operations to return'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ includeCompleted, limit }) => {
      try {
        return textResult({
          ok: true,
          ...listWorkspaceOperations({
            includeCompleted: includeCompleted !== false,
            limit: limit || 20,
          }),
        });
      } catch (error) {
        return errorText('Unable to list workspace operations', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'workspace.service_start',
    {
      title: 'Start workspace service',
      description:
        'Start or restart a long-lived workspace service such as a dev server. Services are managed separately from bounded command operations and are not terminated by operation maxDurationMs.',
      inputSchema: {
        command: z.string().min(1).describe('Command to start with bash -lc'),
        serviceName: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
          .optional()
          .describe('Stable service name. Defaults to app.'),
        name: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
          .optional()
          .describe('Alias for serviceName. Must match serviceName when both are provided.'),
        cwd: z.string().optional().describe('Working directory relative to the workspace'),
        port: z.number().int().positive().max(65535).optional().describe('Primary HTTP port exposed by the service'),
        restart: z.boolean().optional().describe('Stop and replace an existing running service with the same name'),
        waitMs: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_OPERATION_WAIT_MS)
          .optional()
          .describe('Optional startup wait before returning the service status.'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ serviceName, name, command, cwd, port, restart, waitMs }) => {
      try {
        return textResult({
          ok: true,
          ...(await startWorkspaceService({
            name: resolveWorkspaceServiceName({ serviceName, name }),
            command,
            cwd: cwd || '.',
            port,
            restart: restart === true,
            waitMs,
          })),
        });
      } catch (error) {
        return errorText('Unable to start workspace service', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'workspace.service_status',
    {
      title: 'Get workspace service status',
      description: 'Return metadata for a named long-lived workspace service.',
      inputSchema: {
        name: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
          .optional()
          .describe('Alias for serviceName. Must match serviceName when both are provided.'),
        serviceName: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
          .optional()
          .describe('Service name. Defaults to app.'),
        includeLogs: z.boolean().optional().describe('Include bounded stdout and stderr tail.'),
        maxChars: z
          .number()
          .int()
          .positive()
          .max(MAX_SERVICE_LOG_CHARS)
          .optional()
          .describe('Maximum log chars per stream'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ serviceName, name, includeLogs, maxChars }) => {
      try {
        return textResult({
          ok: true,
          ...buildServiceSnapshot(getWorkspaceService(resolveWorkspaceServiceName({ serviceName, name })), {
            includeLogs: includeLogs === true,
            maxChars: clampPositiveInt(maxChars, MAX_COMMAND_OUTPUT_CHARS, MAX_SERVICE_LOG_CHARS),
          }),
        });
      } catch (error) {
        return errorText(
          'Unable to read workspace service status',
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  );

  server.registerTool(
    'workspace.service_logs',
    {
      title: 'Read workspace service logs',
      description: 'Return bounded stdout and stderr for a named long-lived workspace service.',
      inputSchema: {
        name: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
          .optional()
          .describe('Alias for serviceName. Must match serviceName when both are provided.'),
        serviceName: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
          .optional()
          .describe('Service name. Defaults to app.'),
        stream: z.enum(['stdout', 'stderr', 'both']).optional().describe('Log stream to return'),
        maxChars: z
          .number()
          .int()
          .positive()
          .max(MAX_SERVICE_LOG_CHARS)
          .optional()
          .describe('Maximum log chars per stream'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ serviceName, name, stream, maxChars }) => {
      try {
        return textResult({
          ok: true,
          ...readWorkspaceServiceLogs(resolveWorkspaceServiceName({ serviceName, name }), {
            stream: stream || 'both',
            maxChars,
          }),
        });
      } catch (error) {
        return errorText(
          'Unable to read workspace service logs',
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  );

  server.registerTool(
    'workspace.service_stop',
    {
      title: 'Stop workspace service',
      description: 'Terminate a named long-lived workspace service.',
      inputSchema: {
        name: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
          .optional()
          .describe('Alias for serviceName. Must match serviceName when both are provided.'),
        serviceName: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
          .optional()
          .describe('Service name. Defaults to app.'),
        waitMs: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_OPERATION_WAIT_MS)
          .optional()
          .describe('Maximum time to wait for the service to stop.'),
        maxChars: z
          .number()
          .int()
          .positive()
          .max(MAX_SERVICE_LOG_CHARS)
          .optional()
          .describe('Maximum log chars per stream'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ serviceName, name, waitMs, maxChars }) => {
      try {
        return textResult({
          ok: true,
          ...(await stopWorkspaceService(resolveWorkspaceServiceName({ serviceName, name }), {
            waitMs,
            includeLogs: true,
            maxChars,
          })),
        });
      } catch (error) {
        return errorText('Unable to stop workspace service', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'workspace.service_list',
    {
      title: 'List workspace services',
      description: 'List retained long-lived workspace services.',
      inputSchema: {
        includeStopped: z.boolean().optional().describe('Include exited, failed, and stopped services.'),
        limit: z.number().int().positive().max(100).optional().describe('Maximum number of services to return'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ includeStopped, limit }) => {
      try {
        return textResult({
          ok: true,
          ...listWorkspaceServices({
            includeStopped: includeStopped !== false,
            limit: limit || 20,
          }),
        });
      } catch (error) {
        return errorText('Unable to list workspace services', error instanceof Error ? error.message : String(error));
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
              startPoint ? `-b ${quoteShellSingle(name)} ${quoteShellSingle(startPoint)}` : quoteShellSingle(name)
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
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, mcp-session-id, mcp-protocol-version, Last-Event-ID'
  );
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

function parsePreviewProxyPort(rawPort) {
  if (typeof rawPort !== 'string' || !/^\d+$/.test(rawPort)) {
    return null;
  }

  const port = Number(rawPort);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function parsePreviewProxyUpgradeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl || '/', 'http://workspace-gateway.local');
  } catch {
    return null;
  }

  const match = /^\/preview\/([^/]+)(?:\/(.*))?$/.exec(parsed.pathname);
  if (!match) {
    return null;
  }

  const port = parsePreviewProxyPort(match[1]);
  if (!port) {
    return { error: 'invalid-port' };
  }

  const forwardPath = match[2] === undefined ? '/' : `/${match[2]}`;
  return {
    port,
    pathAndQuery: `${forwardPath}${parsed.search}`,
  };
}

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) {
    return value.join(', ');
  }

  return value == null ? '' : String(value);
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) {
    return value.find((entry) => typeof entry === 'string' && entry.length > 0) || '';
  }

  return typeof value === 'string' ? value : '';
}

function buildConnectionHeaderBlocklist(headers, includeUpgradeHeaders) {
  const blocked = new Set();
  for (const token of normalizeHeaderValue(headers.connection).split(',')) {
    const normalizedToken = token.trim().toLowerCase();
    if (!normalizedToken) {
      continue;
    }

    if (includeUpgradeHeaders && normalizedToken === 'upgrade') {
      continue;
    }

    blocked.add(normalizedToken);
  }
  return blocked;
}

function shouldForwardPreviewProxyHeader(normalizedKey, connectionBlockedHeaders, includeUpgradeHeaders) {
  if (!normalizedKey || PREVIEW_PROXY_BLOCKED_REQUEST_HEADERS.has(normalizedKey)) {
    return false;
  }

  if (normalizedKey.startsWith('x-lifecycle-')) {
    return false;
  }

  if (connectionBlockedHeaders.has(normalizedKey)) {
    return false;
  }

  if (!HOP_BY_HOP_HEADERS.has(normalizedKey)) {
    return true;
  }

  return includeUpgradeHeaders && (normalizedKey === 'connection' || normalizedKey === 'upgrade');
}

function inferForwardedProto(req) {
  return req.socket?.encrypted ? 'https' : 'http';
}

function inferForwardedPort(host, proto) {
  const bracketed = host.match(/^\[[^\]]+\]:(\d+)$/);
  if (bracketed) {
    return bracketed[1];
  }

  const match = host.match(/:(\d+)$/);
  if (match && !host.slice(0, match.index).includes(':')) {
    return match[1];
  }

  return proto === 'https' ? '443' : '80';
}

function buildPreviewProxyHeaders(req, port, { includeUpgradeHeaders = false } = {}) {
  const targetHost = `127.0.0.1:${port}`;
  const forwardedHost = firstHeaderValue(req.headers.host) || targetHost;
  const forwardedProto = inferForwardedProto(req);
  const headers = {};
  const connectionBlockedHeaders = buildConnectionHeaderBlocklist(req.headers, includeUpgradeHeaders);

  for (const [key, value] of Object.entries(req.headers)) {
    const normalizedKey = key.toLowerCase();
    if (
      value == null ||
      !shouldForwardPreviewProxyHeader(normalizedKey, connectionBlockedHeaders, includeUpgradeHeaders)
    ) {
      continue;
    }

    headers[key] = normalizeHeaderValue(value);
  }

  headers.host = targetHost;
  headers['x-forwarded-for'] = req.socket?.remoteAddress || '';
  headers['x-forwarded-host'] = forwardedHost;
  headers['x-forwarded-port'] = inferForwardedPort(forwardedHost, forwardedProto);
  headers['x-forwarded-prefix'] = `${PREVIEW_PROXY_PATH_PREFIX}/${port}`;
  headers['x-forwarded-proto'] = forwardedProto;

  if (includeUpgradeHeaders) {
    headers.connection = 'Upgrade';
    headers.upgrade = firstHeaderValue(req.headers.upgrade) || 'websocket';
  }

  return headers;
}

function buildPreviewProxyTarget(port, pathAndQuery) {
  return new URL(pathAndQuery || '/', `http://127.0.0.1:${port}`);
}

function shouldPipeRequestBody(method) {
  return !['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase());
}

function setPreviewProxyResponseHeaders(proxyRes, res) {
  for (const [key, value] of Object.entries(proxyRes.headers)) {
    const normalizedKey = key.toLowerCase();
    if (value == null || HOP_BY_HOP_HEADERS.has(normalizedKey)) {
      continue;
    }

    res.setHeader(key, Array.isArray(value) ? value : value.toString());
  }
}

function sendPreviewProxyError(res, statusCode, message) {
  if (res.destroyed || res.writableEnded) {
    return;
  }

  if (res.headersSent) {
    res.destroy(new Error(message));
    return;
  }

  res.status(statusCode).json({ error: message });
}

function handlePreviewProxyRequest(req, res) {
  const port = parsePreviewProxyPort(req.params?.port);
  if (!port) {
    res.status(400).json({ error: 'Port must be an integer between 1 and 65535.' });
    return;
  }

  const targetUrl = buildPreviewProxyTarget(port, req.url || '/');
  let timedOut = false;
  const proxyReq = httpRequest(
    targetUrl,
    {
      method: req.method,
      headers: buildPreviewProxyHeaders(req, port),
    },
    (proxyRes) => {
      res.statusCode = proxyRes.statusCode || 502;
      res.statusMessage = proxyRes.statusMessage || res.statusMessage;
      setPreviewProxyResponseHeaders(proxyRes, res);

      proxyRes.on('error', (error) => {
        if (res.headersSent) {
          res.destroy(error);
          return;
        }

        sendPreviewProxyError(res, 502, 'Preview proxy response failed.');
      });

      proxyRes.pipe(res);
    }
  );

  proxyReq.setTimeout(PREVIEW_PROXY_TIMEOUT_MS, () => {
    timedOut = true;
    proxyReq.destroy(new Error('preview-proxy-timeout'));
  });

  proxyReq.on('error', () => {
    sendPreviewProxyError(
      res,
      timedOut ? 504 : 502,
      timedOut ? 'Preview proxy timed out.' : 'Preview target unavailable.'
    );
  });

  req.on('error', (error) => proxyReq.destroy(error));
  res.on('close', () => {
    if (!res.writableEnded) {
      proxyReq.destroy();
    }
  });

  if (shouldPipeRequestBody(req.method)) {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

function isAuthorizedPreviewUpgradeRequest(req, expectedToken) {
  return isAuthorizedGatewayRequest(
    req.headers?.authorization,
    expectedToken,
    req.headers?.[LIFECYCLE_GATEWAY_TOKEN_HEADER]
  );
}

function serializeSocketResponse({ statusCode, statusMessage, headers = {}, body = '' }) {
  const bodyBuffer = Buffer.from(body, 'utf8');
  const responseHeaders = {
    connection: 'close',
    'content-length': String(bodyBuffer.length),
    ...headers,
  };
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage || STATUS_CODES[statusCode] || 'Unknown'}`];
  for (const [key, value] of Object.entries(responseHeaders)) {
    if (value == null) {
      continue;
    }
    lines.push(`${key}: ${value}`);
  }
  return Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8'), bodyBuffer]);
}

function writeSocketResponse(socket, statusCode, body) {
  socket.end(
    serializeSocketResponse({
      statusCode,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body,
    })
  );
}

function writeProxyUpgradeHead(socket, proxyRes) {
  const statusCode = proxyRes.statusCode || 101;
  const statusMessage = proxyRes.statusMessage || STATUS_CODES[statusCode] || 'Switching Protocols';
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];

  for (let index = 0; index < proxyRes.rawHeaders.length; index += 2) {
    const key = proxyRes.rawHeaders[index];
    const value = proxyRes.rawHeaders[index + 1];
    if (!key || value == null) {
      continue;
    }

    const normalizedKey = key.toLowerCase();
    if (normalizedKey === 'transfer-encoding' || normalizedKey === 'keep-alive') {
      continue;
    }

    lines.push(`${key}: ${value}`);
  }

  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
}

function handlePreviewProxyUpgrade(expectedToken, req, socket, head) {
  if (!String(req.url || '').startsWith(`${PREVIEW_PROXY_PATH_PREFIX}/`)) {
    writeSocketResponse(socket, 404, 'Not found');
    return;
  }

  if (!isAuthorizedPreviewUpgradeRequest(req, expectedToken)) {
    writeSocketResponse(socket, 401, 'Unauthorized');
    return;
  }

  const parsed = parsePreviewProxyUpgradeUrl(req.url);
  if (!parsed || parsed.error === 'invalid-port') {
    writeSocketResponse(socket, 400, 'Port must be an integer between 1 and 65535.');
    return;
  }

  const targetUrl = buildPreviewProxyTarget(parsed.port, parsed.pathAndQuery);
  const proxyReq = httpRequest(targetUrl, {
    method: req.method,
    headers: buildPreviewProxyHeaders(req, parsed.port, { includeUpgradeHeaders: true }),
  });

  proxyReq.setTimeout(PREVIEW_PROXY_TIMEOUT_MS, () => {
    proxyReq.destroy(new Error('preview-proxy-timeout'));
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    writeProxyUpgradeHead(socket, proxyRes);
    if (head?.length) {
      proxySocket.write(head);
    }
    if (proxyHead?.length) {
      socket.write(proxyHead);
    }
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on('response', (proxyRes) => {
    const statusCode = proxyRes.statusCode || 502;
    const lines = [`HTTP/1.1 ${statusCode} ${proxyRes.statusMessage || STATUS_CODES[statusCode] || 'Unknown'}`];
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value == null || key.toLowerCase() === 'transfer-encoding') {
        continue;
      }
      if (Array.isArray(value)) {
        value.forEach((entry) => lines.push(`${key}: ${entry}`));
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    proxyRes.pipe(socket);
  });

  proxyReq.on('error', () => {
    if (!socket.destroyed) {
      writeSocketResponse(socket, 502, 'Preview target unavailable.');
    }
  });

  socket.on('error', () => proxyReq.destroy());
  socket.on('close', () => proxyReq.destroy());
  proxyReq.end();
}

function moveStackLayersBeforeJsonParser(app, startIndex) {
  const stack = app.router?.stack;
  if (!Array.isArray(stack) || !Number.isInteger(startIndex) || startIndex < 0 || startIndex >= stack.length) {
    return;
  }

  const layers = stack.splice(startIndex);
  const jsonParserIndex = stack.findIndex((layer) => layer.name === 'jsonParser');
  if (jsonParserIndex < 0) {
    stack.push(...layers);
    return;
  }

  stack.splice(jsonParserIndex, 0, ...layers);
}

function installMiddlewareBeforeJsonParser(app, register) {
  const stack = app.router?.stack;
  const startIndex = Array.isArray(stack) ? stack.length : -1;
  register();
  moveStackLayersBeforeJsonParser(app, startIndex);
}

function installPreviewProxyRoute(app, requireGatewayAuth) {
  installMiddlewareBeforeJsonParser(app, () => {
    app.use(PREVIEW_PROXY_MOUNT_PATH, requireGatewayAuth, handlePreviewProxyRequest);
  });
}

function installPreviewProxyUpgradeHandler(httpServer, expectedToken) {
  httpServer.on('upgrade', (req, socket, head) => {
    handlePreviewProxyUpgrade(expectedToken, req, socket, head);
  });
}

const app = createMcpExpressApp({ host: HOST });

// SECURITY: per-instance bearer token minted by the Lifecycle control plane (D9); /health stays open.
const expectedGatewayToken = process.env.LIFECYCLE_GATEWAY_TOKEN || '';
const requireGatewayAuth = createGatewayAuthMiddleware(expectedGatewayToken);

installMiddlewareBeforeJsonParser(app, () => {
  app.use((_req, res, next) => {
    setCorsHeaders(res);
    next();
  });
});
installPreviewProxyRoute(app, requireGatewayAuth);

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

app.post('/mcp', requireGatewayAuth, async (req, res) => {
  await handleStreamableMcpRequest(
    req,
    res,
    async () => ({
      server: buildServer(),
      close: async () => {},
    }),
    'Workspace gateway MCP'
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

app.post('/servers/:slug/mcp', requireGatewayAuth, async (req, res) => {
  const serverConfig = getExternalServerConfig(req.params.slug);
  if (!serverConfig) {
    res.status(404).json({ error: 'External MCP server not found' });
    return;
  }

  await handleStreamableMcpRequest(
    req,
    res,
    async () => buildExternalProxyServer(serverConfig),
    `Workspace gateway external MCP '${serverConfig.slug}'`
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

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  const httpServer = app.listen(PORT, HOST, () => {
    console.log(`Workspace gateway MCP server listening on http://${HOST}:${PORT}`);
    console.log(`Workspace root: ${WORKSPACE_ROOT}`);
    console.log(`Health check: http://${HOST}:${PORT}/health`);
    console.log(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
  });
  installPreviewProxyUpgradeHandler(httpServer, expectedGatewayToken);

  httpServer.on('error', (error) => {
    console.error('Workspace gateway MCP server failed', error);
    process.exit(1);
  });

  const shutdown = async (signal) => {
    try {
      console.log(`Workspace gateway MCP shutting down signal=${signal}`);
      await Promise.all([
        cancelAllWorkspaceOperations({ waitMs: OPERATION_KILL_GRACE_MS + 1000 }),
        stopAllWorkspaceServices({ waitMs: SERVICE_STOP_GRACE_MS + 1000 }),
      ]);
      await new Promise((resolveShutdown) => {
        httpServer.close(() => resolveShutdown());
      });
    } catch {
      // Ignore shutdown errors during process exit.
    }
  };

  process.on('SIGINT', async () => {
    await shutdown('SIGINT');
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await shutdown('SIGTERM');
    process.exit(0);
  });
}

export {
  PREVIEW_PROXY_ROUTE_PATTERN,
  app,
  buildOperationSnapshot,
  buildServiceSnapshot,
  buildServer,
  cancelAllWorkspaceOperations,
  cancelWorkspaceOperation,
  getWorkspaceOperation,
  getWorkspaceService,
  installPreviewProxyUpgradeHandler,
  listWorkspaceOperations,
  listWorkspaceFiles,
  listWorkspaceServices,
  applyWorkspacePatch,
  readWorkspaceFile,
  readWorkspaceOperationLogs,
  readWorkspaceServiceLogs,
  runWorkspaceCommand,
  resolveWorkspaceServiceName,
  startWorkspaceService,
  startWorkspaceOperation,
  stopAllWorkspaceServices,
  stopWorkspaceService,
  editWorkspaceFile,
  writeWorkspaceFile,
  waitForWorkspaceOperation,
  waitForWorkspaceService,
};
