const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const config = read('next.config.mjs');
const build = read('scripts/build.mjs');
const verify = read('scripts/verify-build.mjs');
const dev = read('scripts/dev.mjs');
const processHelper = read('scripts/next-process.mjs');

test('dev and verification builds use separate Next.js output directories', () => {
  assert.match(config, /process\.env\.NEXT_DIST_DIR\?\.trim\(\) \|\| '\.next'/);
  assert.equal(packageJson.scripts.dev, 'node scripts/dev.mjs');
  assert.equal(packageJson.scripts['build:verify'], 'node scripts/verify-build.mjs');
  assert.match(verify, /verificationDistDir/);
  assert.match(verify, /NEXT_DIST_DIR: verificationDistDir/);
  assert.match(dev, /NEXT_DIST_DIR: defaultDistDir/);
});

test('default production build refuses to share .next with a managed dev server', () => {
  assert.equal(packageJson.scripts.build, 'node scripts/build.mjs');
  assert.match(build, /readActiveDevLock\(\)/);
  assert.match(build, /Refusing to build into/);
  assert.match(processHelper, /process\.kill\(pid, 0\)/);
  assert.match(processHelper, /isProcessRunning\(lock\.ownerPid\) \|\| isProcessRunning\(lock\.nextPid\)/);
});

test('verification cleanup is constrained to the explicit project-local output', () => {
  assert.match(verify, /assertSafeDistPath\(verificationDistDir\)/);
  assert.match(processHelper, /\[defaultDistDir, verificationDistDir\]\.includes\(distDir\)/);
  assert.match(processHelper, /dirname\(target\) !== projectRoot/);
});

test('generated local output and the dev lock are ignored', () => {
  const gitignore = read('.gitignore');
  assert.match(gitignore, /^\.next$/m);
  assert.match(gitignore, /^\.next-verify$/m);
  assert.match(gitignore, /^\.next-dev\.lock$/m);
});
