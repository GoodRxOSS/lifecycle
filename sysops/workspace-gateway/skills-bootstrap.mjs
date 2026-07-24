import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  SESSION_HOME_ROOT,
  SKILL_SOURCES_ROOT,
  SKILLS_ROOT,
  SKILLS_INDEX_PATH,
  SKILLS_LOCK_PATH,
  buildSkillSourceRepoKey,
  isWithinRoot,
  normalizeRelativeSkillPath,
  readSkillMetadata,
  toSessionRelativePath,
} from './skills-lib.mjs';

const execFile = promisify(execFileCallback);

function parseSkillPlanArg() {
  const encoded = process.argv[2] || '';
  if (!encoded) {
    return { version: 1, skills: [] };
  }

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const parsed = JSON.parse(decoded);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.skills)) {
    throw new Error('Invalid skill plan payload');
  }

  return {
    version: 1,
    skills: parsed.skills,
  };
}

async function runGit(args, cwd) {
  const result = await execFile('git', args, {
    cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: process.env.HOME || SESSION_HOME_ROOT,
      },
    });

  return {
    stdout: result.stdout?.trim() || '',
    stderr: result.stderr?.trim() || '',
  };
}

async function ensureRepoAtBranch(repo) {
  const repoKey = buildSkillSourceRepoKey(repo.repo, repo.branch);
  const sourceRoot = resolve(SKILL_SOURCES_ROOT, repoKey);
  const gitDir = resolve(sourceRoot, '.git');

  await mkdir(SKILL_SOURCES_ROOT, { recursive: true });

  let hasGitRepo = false;
  try {
    const gitStat = await stat(gitDir);
    if (!gitStat.isDirectory()) {
      throw new Error(`Expected ${gitDir} to be a directory`);
    }
    hasGitRepo = true;
  } catch {
    hasGitRepo = false;
  }

  if (hasGitRepo) {
    await runGit(['fetch', '--depth', '1', 'origin', repo.branch], sourceRoot);
    await runGit(['checkout', '-B', repo.branch, `origin/${repo.branch}`], sourceRoot);
    await runGit(['reset', '--hard', `origin/${repo.branch}`], sourceRoot);
    await runGit(['clean', '-fd'], sourceRoot);
  } else {
    await mkdir(dirname(sourceRoot), { recursive: true });
    await runGit(
      ['clone', '--depth', '1', '--branch', repo.branch, '--single-branch', repo.repoUrl, sourceRoot],
      SESSION_HOME_ROOT
    );
  }

  const { stdout } = await runGit(['rev-parse', 'HEAD'], sourceRoot);

  return {
    repoKey,
    sourceRoot,
    resolvedSha: stdout,
  };
}

async function main() {
  const skillPlan = parseSkillPlanArg();
  const repos = new Map();

  await mkdir(SKILLS_ROOT, { recursive: true });

  for (const skill of skillPlan.skills) {
    const repoKey = `${skill.repo}::${skill.branch}`;
    if (repos.has(repoKey)) {
      continue;
    }

    repos.set(repoKey, null);
  }

  const preparedRepos = await Promise.all(
    Array.from(repos.keys()).map(async (repoKey) => {
      const [repo, branch] = repoKey.split('::');
      const skill = skillPlan.skills.find((entry) => entry.repo === repo && entry.branch === branch);
      if (!skill) {
        throw new Error(`Missing skill metadata for ${repoKey}`);
      }

      return [
        repoKey,
        await ensureRepoAtBranch({
          repo: skill.repo,
          repoUrl: skill.repoUrl,
          branch: skill.branch,
        }),
      ];
    })
  );

  for (const [repoKey, preparedRepo] of preparedRepos) {
    repos.set(repoKey, preparedRepo);
  }

  const skills = await Promise.all(
    skillPlan.skills.map(async (skill) => {
      const sourceRepo = repos.get(`${skill.repo}::${skill.branch}`);
      if (!sourceRepo) {
        throw new Error(`Skill repo was not prepared for ${skill.repo}@${skill.branch}`);
      }

      const normalizedPath = normalizeRelativeSkillPath(skill.path);
      const skillDir = resolve(sourceRepo.sourceRoot, normalizedPath);
      if (!isWithinRoot(skillDir, sourceRepo.sourceRoot)) {
        throw new Error(`Skill path must stay within source repo: ${skill.path}`);
      }

      const skillFile = resolve(skillDir, 'SKILL.md');
      const skillFileStat = await stat(skillFile).catch(() => null);
      if (!skillFileStat?.isFile()) {
        throw new Error(`Missing SKILL.md for ${skill.repo}@${skill.branch}:${normalizedPath}`);
      }

      const metadata = await readSkillMetadata(skillFile, normalizedPath.split('/').pop() || normalizedPath);

      return {
        ...skill,
        path: normalizedPath,
        sourceRoot: toSessionRelativePath(sourceRepo.sourceRoot),
        shortName: metadata.shortName,
        title: metadata.title,
        description: metadata.description,
      };
    })
  );

  await writeFile(
    SKILLS_INDEX_PATH,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        skills,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  await writeFile(
    SKILLS_LOCK_PATH,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        repos: Array.from(repos.values()).map((repo) => ({
          sourceRoot: toSessionRelativePath(repo.sourceRoot),
          resolvedSha: repo.resolvedSha,
        })),
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
