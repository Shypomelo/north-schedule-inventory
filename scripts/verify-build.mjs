import { rmSync } from 'node:fs';
import {
  assertSafeDistPath,
  forwardSignals,
  runNext,
  verificationDistDir,
} from './next-process.mjs';

const target = assertSafeDistPath(verificationDistDir);
rmSync(target, { recursive: true, force: true });

console.log(`Running isolated verification build in ${verificationDistDir}.`);
const child = runNext('build', process.argv.slice(2), {
  ...process.env,
  NEXT_DIST_DIR: verificationDistDir,
});
forwardSignals(child);
child.once('exit', code => { process.exitCode = code ?? 1; });
child.once('error', error => {
  console.error('Failed to start isolated Next.js build:', error);
  process.exitCode = 1;
});
