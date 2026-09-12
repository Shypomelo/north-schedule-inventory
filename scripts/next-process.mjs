import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const devLockPath = resolve(projectRoot, '.next-dev.lock');
export const defaultDistDir = '.next';
export const verificationDistDir = '.next-verify';

export function isProcessRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function readActiveDevLock() {
  if (!existsSync(devLockPath)) return null;
  try {
    const lock = JSON.parse(readFileSync(devLockPath, 'utf8'));
    if (isProcessRunning(lock.ownerPid) || isProcessRunning(lock.nextPid) || isProcessRunning(lock.pid)) return lock;
  } catch {}
  rmSync(devLockPath, { force: true });
  return null;
}

export function writeDevLock(distDir, nextPid) {
  writeFileSync(devLockPath, JSON.stringify({
    ownerPid: process.pid,
    nextPid,
    distDir,
    startedAt: new Date().toISOString(),
  }, null, 2));
}

export function clearOwnedDevLock() {
  try {
    const lock = JSON.parse(readFileSync(devLockPath, 'utf8'));
    if (lock.ownerPid === process.pid || lock.pid === process.pid) rmSync(devLockPath, { force: true });
  } catch {}
}

export function assertSafeDistPath(distDir) {
  if (![defaultDistDir, verificationDistDir].includes(distDir)) {
    throw new Error(`Unsupported Next.js output directory: ${distDir}`);
  }
  const target = resolve(projectRoot, distDir);
  if (dirname(target) !== projectRoot) {
    throw new Error(`Refusing output directory outside project root: ${target}`);
  }
  return target;
}

export function runNext(command, args = [], env = process.env) {
  const nextBin = resolve(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  return spawn(process.execPath, [nextBin, command, ...args], {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
  });
}

export function forwardSignals(child) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
}
