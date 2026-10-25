/** Quote one literal argument for a generated POSIX shell script. */
export function shellQuote(value: unknown): string {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}
