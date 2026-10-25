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

import { generateOptions } from 'server/lib/codefresh/__fixtures__/codefresh';
import {
  deletePendingHelmReleaseStep,
  generateCodefreshCmd,
  waitForInProgressDeploys,
} from 'server/lib/codefresh/utils/generateCodefreshCmd';

jest.mock('fs', () => ({ mkdirSync: jest.fn(), writeFileSync: jest.fn() }));
jest.mock('server/lib/codefresh/utils/generateYaml');
import * as yaml from 'server/lib/codefresh/utils/generateYaml';

describe('generateCodefreshCmd', () => {
  it('rejects an option-like pipeline before writing a submission file', () => {
    const { writeFileSync } = jest.requireMock('fs');
    writeFileSync.mockClear();
    jest.spyOn(yaml, 'generateYaml').mockReturnValue('yaml');
    expect(() => generateCodefreshCmd({ ...generateOptions, buildPipelineName: '--local' })).toThrow(
      'must not start with a hyphen'
    );
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('should generate command with master branch', () => {
    jest.spyOn(yaml, 'generateYaml').mockReturnValue('yaml');
    const options = { ...generateOptions, branch: 'master' };
    const result = generateCodefreshCmd(options);

    expect(result[2]).toEqual('--branch=master');
  });

  it('should generate command with unique branch', () => {
    jest.spyOn(yaml, 'generateYaml').mockReturnValue('yaml');
    const customBranchOptions = {
      ...generateOptions,
      branch: 'unique-branch-name',
    };

    const result = generateCodefreshCmd(customBranchOptions);

    expect(result[2]).toEqual('--branch=unique-branch-name');
  });

  it('preserves the image-derived filename with path separators removed', () => {
    jest.spyOn(yaml, 'generateYaml').mockReturnValue('yaml');
    const customImageOptions = {
      ...generateOptions,
      imageTag: 'latest',
    };

    const result = generateCodefreshCmd(customImageOptions);

    expect(result.find((arg) => arg.startsWith('--yaml='))).toContain('latest');
  });

  it('includes the selected runtime and every build environment variable', () => {
    jest.spyOn(yaml, 'generateYaml').mockReturnValue('yaml');

    const result = generateCodefreshCmd({
      ...generateOptions,
      runtimeName: 'production-runtime',
      envVars: { API_URL: 'https://api.example.test', EMPTY_VALUE: '' },
    });

    expect(result).toContain('--runtime-name=production-runtime');
    expect(result).toContain('--variable=API_URL=https://api.example.test');
    expect(result).toContain('--variable=EMPTY_VALUE=');
  });
});

describe('Codefresh deployment coordination steps', () => {
  it('builds the pending Helm release cleanup step for the deployment namespace', () => {
    expect(
      deletePendingHelmReleaseStep({
        deploy: { uuid: 'deploy-123' } as never,
        namespace: 'candidate-123',
      })
    ).toEqual({
      title: 'Delete Pending Helm Releases',
      stage: 'Cleanup',
      image: 'alpine/helm:3.7.2',
      fail_fast: false,
      commands: [
        "helm list --namespace='candidate-123' -m 1000 --pending -q | grep -- 'deploy-123' | xargs --no-run-if-empty helm uninstall --wait --namespace='candidate-123' --",
      ],
    });
  });

  it('builds the wait step with the requested deployment and pipeline identifiers', () => {
    const step = waitForInProgressDeploys({ deployUUID: 'deploy-123', pipelineId: 'pipeline-456' });

    expect(step).toMatchObject({
      title: 'Wait for pending deploys to finish',
      stage: 'Wait',
      image: 'codefresh/cli:0.87.4',
      fail_fast: false,
    });
    expect(step.commands).toHaveLength(1);
    expect(step.commands[0]).toContain('pipeline=pipeline-456&status=running');
    expect(step.commands[0]).toContain("--arg DEPLOY_UUID 'deploy-123'");
    expect(step.commands[0]).toContain('.value==$DEPLOY_UUID');
    expect(step.commands[0]).toContain('if [ "$1" != "$CF_BUILD_ID" ]');
  });
});

describe('generated Codefresh commands preserve data boundaries', () => {
  it('passes all CLI fields literally while preserving the existing env string coercion', () => {
    jest.spyOn(yaml, 'generateYaml').mockReturnValue('yaml');
    const value = "quote'$(id);`uname`\nnext";
    const args = generateCodefreshCmd({
      ...generateOptions,
      buildPipelineName: value,
      branch: value,
      runtimeName: value,
      envVars: { [value]: value, OBJECT: { a: 1 }, NULL: null },
    } as any);
    expect(args.slice(0, 4)).toEqual(['run', value, `--branch=${value}`, `--runtime-name=${value}`]);
    expect(args).toContain(`--variable=${value}=${value}`);
    expect(args).toContain('--variable=OBJECT=[object Object]');
    expect(args).toContain('--variable=NULL=null');
  });

  it('binds jq data separately and never inserts returned pipeline IDs into a second shell program', () => {
    const { execFileSync } = jest.requireActual('child_process');
    const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = jest.requireActual('fs');
    const { join } = jest.requireActual('path');
    const { tmpdir } = jest.requireActual('os');
    const directory = mkdtempSync(join(tmpdir(), 'lfc-codefresh-'));
    try {
      const log = join(directory, 'args.jsonl');
      const marker = join(directory, 'unexpected');
      const value = `quote' ; touch ${marker}; #`;
      const returnedId = `$(touch\${IFS}${marker});id`;
      for (const tool of ['curl', 'jq', 'cf_export', 'codefresh']) {
        writeFileSync(
          join(directory, tool),
          `#!${process.execPath}\nrequire('fs').appendFileSync(process.env.ARGV_LOG,JSON.stringify([${JSON.stringify(
            tool
          )},...process.argv.slice(2)])+'\\n');if(${JSON.stringify(
            tool
          )}==='jq')process.stdout.write(process.env.PIPELINE_ID+'\\n');`,
          { mode: 0o755 }
        );
      }
      const script = waitForInProgressDeploys({ deployUUID: value, pipelineId: value }).commands[0];
      execFileSync('/bin/sh', ['-c', script], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          ARGV_LOG: log,
          PIPELINE_ID: returnedId,
          CF_BUILD_ID: 'current',
          CF_BUILD_TIMESTAMP: '42',
          CODEFRESH_API_KEY: 'synthetic',
        },
      });
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      expect(calls.find((args) => args[0] === 'curl')[3]).toBe(
        `https://g.codefresh.io/api/workflow?pipeline=${encodeURIComponent(value)}&status=running`
      );
      const jq = calls.find((args) => args[0] === 'jq');
      expect(jq.slice(5, 8)).toEqual(['--arg', 'DEPLOY_UUID', value]);
      expect(calls.find((args) => args[0] === 'codefresh')).toEqual(['codefresh', 'wait', '-v', returnedId]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
