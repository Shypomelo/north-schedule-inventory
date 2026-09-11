import {
  defaultDistDir,
  forwardSignals,
  readActiveDevLock,
  runNext,
} from './next-process.mjs';

const distDir = process.env.NEXT_DIST_DIR?.trim() || defaultDistDir;
const activeDev = readActiveDevLock();
if (distDir === defaultDistDir && activeDev?.distDir === defaultDistDir) {
  console.error(`Refusing to build into ${defaultDistDir}: dev server PID ${activeDev.nextPid ?? activeDev.ownerPid ?? activeDev.pid} is using it.`);
  console.error('Use "npm run build:verify" while localhost is running, or stop dev before "npm run build".');
  process.exit(1);
}

const child = runNext('build', process.argv.slice(2), {
  ...process.env,
  NEXT_DIST_DIR: distDir,
});
forwardSignals(child);
child.once('exit', code => { process.exitCode = code ?? 1; });
child.once('error', error => {
  console.error('Failed to start Next.js build:', error);
  process.exitCode = 1;
});
