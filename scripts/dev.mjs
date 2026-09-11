import {
  clearOwnedDevLock,
  defaultDistDir,
  forwardSignals,
  readActiveDevLock,
  runNext,
  writeDevLock,
} from './next-process.mjs';

const existing = readActiveDevLock();
if (existing) {
  console.error(`A managed dev server is already running (PID ${existing.nextPid ?? existing.ownerPid ?? existing.pid}, distDir ${existing.distDir}).`);
  process.exit(1);
}

const child = runNext('dev', process.argv.slice(2), {
  ...process.env,
  NEXT_DIST_DIR: defaultDistDir,
});
writeDevLock(defaultDistDir, child.pid);
forwardSignals(child);

child.once('exit', code => {
  clearOwnedDevLock();
  process.exitCode = code ?? 1;
});
child.once('error', error => {
  console.error('Failed to start Next.js dev server:', error);
  clearOwnedDevLock();
  process.exitCode = 1;
});
