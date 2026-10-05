import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { deploymentEnvironmentError } from './verify-deployment-environment.mjs';

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, '..');
const candidateUrl = 'https://fssogssryeunkjkdgewx.supabase.co';
const productionUrl = 'https://dghozkqvxlwpjmgleekw.supabase.co';

test('build guard rejects Preview targeting Production', () => {
  assert.equal(deploymentEnvironmentError('preview', productionUrl), 'PREVIEW_SUPABASE_TARGET_MISMATCH');
});

test('build guard accepts Preview targeting Candidate', () => {
  assert.equal(deploymentEnvironmentError('preview', candidateUrl), null);
});

test('build guard rejects Production targeting Candidate', () => {
  assert.equal(deploymentEnvironmentError('production', candidateUrl), 'PRODUCTION_SUPABASE_TARGET_MISMATCH');
});

test('build guard accepts Production targeting Production and leaves development unrestricted', () => {
  assert.equal(deploymentEnvironmentError('production', productionUrl), null);
  assert.equal(deploymentEnvironmentError('development', productionUrl), null);
});

function loadTs(file, resolve = require) {
  const source = readFileSync(join(root, file), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'process', outputText)(resolve, module, module.exports, process);
  return module.exports;
}

test('runtime Preview to Production renders the block before app bootstrap', () => {
  const safety = loadTs('src/lib/deployment-safety.ts');
  const { DeploymentSafetyGate } = loadTs('src/components/DeploymentSafetyGate.tsx', name =>
    name === '@/lib/deployment-safety' ? safety : require(name));

  const previousEnvironment = process.env.NEXT_PUBLIC_DEPLOYMENT_ENV;
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let bootstraps = 0;
  function AppBootstrap() {
    bootstraps += 1;
    return React.createElement('span', null, 'normal app');
  }

  try {
    process.env.NEXT_PUBLIC_DEPLOYMENT_ENV = 'preview';
    process.env.NEXT_PUBLIC_SUPABASE_URL = productionUrl;
    const blocked = renderToStaticMarkup(React.createElement(DeploymentSafetyGate, null, React.createElement(AppBootstrap)));
    assert.match(blocked, /環境設定錯誤/);
    assert.match(blocked, /Preview 不可連線正式資料庫/);
    assert.equal(bootstraps, 0);

    process.env.NEXT_PUBLIC_SUPABASE_URL = candidateUrl;
    assert.equal(safety.deploymentSafetyState('preview', candidateUrl), 'preview-candidate');
    const allowed = renderToStaticMarkup(React.createElement(DeploymentSafetyGate, null, React.createElement(AppBootstrap)));
    assert.match(allowed, /normal app/);
    assert.equal(bootstraps, 1);
    assert.equal(safety.deploymentSafetyState('production', productionUrl), 'normal');
  } finally {
    if (previousEnvironment === undefined) delete process.env.NEXT_PUBLIC_DEPLOYMENT_ENV;
    else process.env.NEXT_PUBLIC_DEPLOYMENT_ENV = previousEnvironment;
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
  }
});
