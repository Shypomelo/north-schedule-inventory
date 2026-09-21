import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const testRoot = join(projectRoot, 'src', 'lib');
const testFilePattern = /\.test\.(?:js|cjs|mjs)$/;

function findTests(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const fullPath = join(directory, entry.name);
      return entry.isDirectory() ? findTests(fullPath) : [fullPath];
    })
    .filter(filePath => testFilePattern.test(filePath))
    .sort();
}

const testFiles = findTests(testRoot);
if (testFiles.length === 0) {
  console.error('No Full JS tests found under src/lib.');
  process.exit(1);
}

if (process.argv.includes('--list')) {
  testFiles.forEach(filePath => console.log(relative(projectRoot, filePath)));
  process.exit(0);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
