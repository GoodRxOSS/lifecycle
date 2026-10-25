import { codefreshRunArgs } from '../command';

describe('Codefresh run option boundaries', () => {
  it.each(['--local', '-d', '--', '-pipeline'])('rejects option-like pipeline name %s', (pipeline) => {
    expect(() => codefreshRunArgs(pipeline, ['--branch=main'])).toThrow('must not start with a hyphen');
  });

  it.each(['org/pipeline', "org/o'hare;$(id)", '雪', ''])(
    'preserves pipeline name %s and attached values',
    (pipeline) => {
      const args = ['--branch=--local', '--trigger=--local', '--runtime-name=--local', '--variable=--local=value'];
      expect(codefreshRunArgs(pipeline, args)).toEqual(['run', pipeline, ...args, '-d']);
    }
  );
});
