import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(name) : /\.[jt]sx?$/.test(name) ? [name] : [];
  });
}

it('does not register the retired v1 API in either Next router', () => {
  expect(sourceFiles(path.join(root, 'src/pages/api/v1'))).toEqual([]);
  expect(sourceFiles(path.join(root, 'src/app/api/v1'))).toEqual([]);
});

it('does not leave first-party pages or the environment banner calling the retired API', () => {
  const files = [...sourceFiles(path.join(root, 'src/pages')), path.join(root, 'public/utils/0-banner.js')];
  const callers = files.filter((file) => readFileSync(file, 'utf8').includes('/api/v1'));
  expect(callers).toEqual([]);
  expect(readFileSync(path.join(root, 'public/utils/0-banner.js'), 'utf8')).not.toContain('new EventSource');
});
