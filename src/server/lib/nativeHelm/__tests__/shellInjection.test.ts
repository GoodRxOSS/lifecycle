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

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({ loadFromDefault: jest.fn(), makeApiClient: jest.fn() })),
  RbacAuthorizationV1Api: jest.fn(),
}));
jest.mock('server/lib/logger', () => ({
  getLogger: jest.fn(() => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}));
jest.mock('server/services/globalConfig');

import { ChartType, escapeHelmValue, generateHelmInstallScript } from '../utils';
import { createHelmContainer } from '../helm';
import { serializeHelmEnvMap } from '../../helm/utils';
import { createCloneScript, createGitCloneContainer } from '../../nativeBuild/utils';

const simulateK8sExpand = (input: string, env: Record<string, string> = {}): string => {
  let out = '';
  for (let i = 0; i < input.length; ) {
    if (input.startsWith('$$', i)) {
      out += '$';
      i += 2;
      continue;
    }
    const ref = /^\$\(([A-Za-z_][A-Za-z0-9_.-]*)\)/.exec(input.slice(i));
    if (ref && ref[1] in env) {
      out += env[ref[1]];
      i += ref[0].length;
      continue;
    }
    out += input[i];
    i += 1;
  }
  return out;
};

const HOSTILE_VALUES: Record<string, string> = {
  ampersand: 'pr-12&x=<y>',
  redirects: 'a>b <c 2>&1',
  semicolon: 'a;touch PWNED;b',
  'command substitution': 'a$(touch PWNED)b',
  backticks: 'a`touch PWNED`b',
  quotes: "it's \"quoted\" 'both'",
  newline: 'line1\nline2;touch PWNED',
  'variable refs': '$HOME ${PATH} $USER',
  'dollar pairs and env refs': 'a$$b $(NODE_ENV) $$(X) $$$ end',
  'helm separators': 'a,b/c',
  spaces: 'two  words',
  glob: '*',
  pipes: 'a|b||c&&d',
  'backslash comma': 'a\\,b',
};

describe('native helm deploy script with shell metacharacters', () => {
  let workDir: string;
  let binDir: string;
  let argvFile: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-script-'));
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-bin-'));
    argvFile = path.join(binDir, 'argv');
    fs.writeFileSync(
      path.join(binDir, 'helm'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a" >> "${argvFile}"; done\n`,
      { mode: 0o755 }
    );
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  const runScript = (script: string, env: Record<string, string> = {}) => {
    const result = spawnSync('/bin/sh', ['-c', simulateK8sExpand(script, env)], {
      cwd: workDir,
      encoding: 'utf8',
      env: { ...process.env, ...env, PATH: `${binDir}:${process.env.PATH}` },
    });
    const argv = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf8').split('\0').slice(0, -1) : [];
    return { result, argv };
  };

  it.each(Object.entries(HOSTILE_VALUES))('passes %s to helm as one literal --set argument', (_name, value) => {
    const script = generateHelmInstallScript(
      'no-repo',
      'chart',
      'my-release',
      'env-test',
      [`deployment.env.KEY=${value}`, 'plain.key=plain'],
      ['values.yaml'],
      ChartType.ORG_CHART,
      undefined,
      'oci://registry.example.com/chart'
    );

    const { result, argv } = runScript(script, { NODE_ENV: 'production' });

    expect(result.status).toBe(0);
    expect(argv).toContain(`deployment.env.KEY=${escapeHelmValue(value).replace(/\\([\\"$`])/g, '$1')}`);
    expect(argv).toContain('plain.key=plain');
    expect(fs.readdirSync(workDir)).toEqual([]);
  });

  it('does not evaluate hostile release names or repo URLs in the log and repo-add lines', () => {
    const script = generateHelmInstallScript(
      'no-repo',
      'chart',
      'rel$(touch PWNED)ease',
      'env-test',
      [],
      [],
      ChartType.PUBLIC,
      undefined,
      'https://charts.example.com/$(touch PWNED)'
    );

    const { argv } = runScript(script);
    expect(fs.readdirSync(workDir)).toEqual([]);
    expect(argv).toContain('rel$(touch PWNED)ease');
  });

  it('doubles dollar signs in job container env values', async () => {
    const container = await createHelmContainer(
      'no-repo',
      'chart',
      'rel',
      'env-test',
      '3.12.0',
      [],
      [],
      ChartType.ORG_CHART,
      'svc$$name',
      'job$(X)'
    );
    const env = Object.fromEntries(container.env.map((e: any) => [e.name, e.value]));
    expect(simulateK8sExpand(env.LC_SERVICE_NAME)).toBe('svc$$name');
    expect(simulateK8sExpand(env.LC_JOB_NAME)).toBe('job$(X)');
  });
});

describe('git clone scripts with hostile refs', () => {
  const run = (script: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-'));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-bin-'));
    const argvFile = path.join(binDir, 'argv');
    fs.writeFileSync(
      path.join(binDir, 'git'),
      `#!/bin/sh\nprintf '%s\\0' "$@" >> "${argvFile}"\nprintf '\\1' >> "${argvFile}"\n`,
      { mode: 0o755 }
    );
    try {
      const result = spawnSync('/bin/sh', ['-c', `mkdir -p /tmp/_unused; ${simulateK8sExpand(script)}`], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GIT_USERNAME: 'u', GIT_PASSWORD: 'p', PATH: `${binDir}:${process.env.PATH}` },
      });
      return { result, listing: fs.readdirSync(dir), argv: fs.readFileSync(argvFile, 'utf8') };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  };

  it.each(['feat/$(touch PWNED)', 'a;touch PWNED', 'a`touch PWNED`b', "it's$$x"])(
    'passes branch %s to git as a single literal argument',
    (branch) => {
      const script = createCloneScript('owner/repo', branch, 'abc$(touch PWNED)');
      const { result, listing, argv } = run(script.replace(' && cd /workspace', ''));
      expect(result.status).toBe(0);
      expect(listing).not.toContain('PWNED');
      expect(argv).toContain(`\0${branch}\0`);
    }
  );

  it('escapes dollar signs in revision and target dir for the clone container', () => {
    const container = createGitCloneContainer('owner/repo', 'rev$(touch PWNED)', 'u', 'p');
    expect(container.args[0]).toContain("'rev$$(touch PWNED)'");
  });
});

describe('legacy --set value compatibility', () => {
  // Shapes found in real configs: values sh used to rewrite inside double quotes.
  const LEGACY_VALUES = [
    'master.disableCommands[0]="FLUSHALL"',
    'auth.username=""',
    'secrets.env.WEB_SERVICE="svc.example.svc.cluster.local/pass-api"',
    'job.annotations.helm\\.sh/hook=post-install\\,post-upgrade',
    'ingress.extraAnnotations.external-dns\\.alpha\\.kubernetes\\.io/hostname=host.example.com',
    'plain.key=plain',
    'url.key=https://host.example.com/a/b?x=1',
    ...serializeHelmEnvMap(
      {
        PLAIN: 'value',
        SLASHED: 'a/b/c',
        NUMBER: 3,
        FLAG: true,
        TOKEN: { valueFrom: { secretKeyRef: { name: 'app-secrets', key: 'TOKEN' } } },
      },
      'deployment.env',
      { quoteStringValues: true }
    ),
  ];

  const oldShellArgv = (entry: string): string[] => {
    const eq = entry.indexOf('=');
    const key = entry.slice(0, eq);
    const val = escapeHelmValue(entry.slice(eq + 1));
    const result = spawnSync('/bin/sh', ['-c', `printf '%s\\0' --set "${key}=${val}"`], { encoding: 'utf8' });
    return result.stdout.split('\0').slice(0, -1);
  };

  const newArgv = (entry: string): string[] => {
    const script = generateHelmInstallScript(
      'no-repo',
      'chart',
      'rel',
      'env-test',
      [entry],
      [],
      ChartType.ORG_CHART,
      undefined,
      'oci://registry.example.com/chart'
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-legacy-'));
    const argvFile = path.join(dir, 'argv');
    fs.writeFileSync(
      path.join(dir, 'helm'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a" >> "${argvFile}"; done\n`,
      {
        mode: 0o755,
      }
    );
    try {
      spawnSync('/bin/sh', ['-c', simulateK8sExpand(script)], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
      const argv = fs.readFileSync(argvFile, 'utf8').split('\0').slice(0, -1);
      const idx = argv.indexOf('--set');
      return argv.slice(idx, idx + 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it.each(LEGACY_VALUES)('passes %s to helm exactly as the old shell evaluation did', (entry) => {
    expect(newArgv(entry)).toEqual(oldShellArgv(entry));
  });

  it('strips the quotes the env serializer adds to secret names', () => {
    expect(newArgv('deployment.env.TOKEN.valueFrom.secretKeyRef.name="app-secrets"')).toEqual([
      '--set',
      'deployment.env.TOKEN.valueFrom.secretKeyRef.name=app-secrets',
    ]);
  });
});
