export function codefreshRunArgs(pipeline: string, args: string[]): string[] {
  // Codefresh 0.81.5 does not bind its pipeline positional after an option terminator.
  if (pipeline.startsWith('-')) {
    throw new Error('Codefresh pipeline must not start with a hyphen.');
  }
  return ['run', pipeline, ...args, '-d'];
}
