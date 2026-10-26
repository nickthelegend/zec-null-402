#!/usr/bin/env node
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resultsDir = path.join(root, 'audit/results');
const resultsFile = path.join(resultsDir, 'ui.json');
const auditMdFile = path.join(root, 'AUDIT.md');

if (!fs.existsSync(auditMdFile)) {
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'ui-blocked.md'), '# UI Audit Blocked\n\nAUDIT.md is missing at repo root.\n');
  console.error('AUDIT.md is missing; wrote audit/results/ui-blocked.md and stopping.');
  process.exit(1);
}

fs.mkdirSync(resultsDir, { recursive: true });
fs.mkdirSync(path.join(root, 'audit/evidence/ui'), { recursive: true });

// Read expected results from AUDIT.md
const auditContent = fs.readFileSync(auditMdFile, 'utf8');
const expectedMap = new Map();
for (const line of auditContent.split('\n')) {
  const trimmed = line.trim();
  if (trimmed.startsWith('|')) {
    const parts = trimmed.split('|').map((s) => s.trim());
    if (parts.length >= 4) {
      const id = parts[1];
      const expected = parts[3];
      if (id && expected && id !== 'ID' && !id.startsWith('---')) {
        expectedMap.set(id, expected);
      }
    }
  }
}

export const LOCAL_LANDING = 'http://127.0.0.1:5184/';
export const LOCAL_EVID = 'http://127.0.0.1:5184/evidence.html';
export const LOCAL_DASH = 'http://127.0.0.1:5183/';

export const LIVE_LANDING = 'https://kippu-landing.vercel.app/';
export const LIVE_EVID = 'https://kippu-landing.vercel.app/evidence.html';
export const LIVE_DASH = 'https://kippu-dashboard.vercel.app/';

// Ensure stack is stopped on exit
let stackStarted = false;
export function stopStack() {
  if (stackStarted) {
    try {
      execSync('./e2e/stack.sh stop', { cwd: root, stdio: 'inherit' });
    } catch {}
    stackStarted = false;
  }
}

process.on('exit', stopStack);
process.on('SIGINT', () => { stopStack(); process.exit(130); });
process.on('SIGTERM', () => { stopStack(); process.exit(143); });

// Start local stack
console.log('Starting local stack via e2e/stack.sh...');
try {
  execSync('./e2e/stack.sh stop', { cwd: root, stdio: 'ignore' });
} catch {}
try {
  execSync('./e2e/stack.sh', { cwd: root, stdio: 'inherit' });
  stackStarted = true;
} catch (err) {
  console.error('Failed to start local stack:', err);
  process.exit(1);
}

export function runCapture(item) {
  const args = [path.join(root, 'audit/runner/capture.mjs'), JSON.stringify(item)];
  const res = spawnSync('node', args, { cwd: root, encoding: 'utf8' });
  const jsonPath = path.join(root, 'audit/evidence', item.outDir || 'runner-smoke', `${item.id}.json`);
  let data = null;
  if (fs.existsSync(jsonPath)) {
    try {
      data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {}
  }
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    data,
    jsonPath: `audit/evidence/${item.outDir || 'runner-smoke'}/${item.id}.json`,
    screenshotPath: data?.screenshot || `audit/evidence/${item.outDir || 'runner-smoke'}/${item.id}.jpg`,
  };
}

// Import test definitions
const { TESTS } = await import('./test-definitions.mjs');

console.log(`Running UI audit for ${TESTS.length} rows...`);

const results = [];
let passCount = 0;
let failCount = 0;
const failures = [];

for (let i = 0; i < TESTS.length; i++) {
  const t = TESTS[i];
  const expected = expectedMap.get(t.id) || '';
  process.stdout.write(`[${i + 1}/${TESTS.length}] ${t.id} ... `);

  let finalOk = true;
  let finalActual = '';
  let finalEvidence = null;

  if (t.viewport) {
    // Single viewport test
    const captureItem = {
      id: t.id,
      url: t.url,
      width: t.viewport.width,
      height: t.viewport.height,
      outDir: 'ui',
      waitFor: t.waitFor,
      actions: t.actions,
      reducedMotion: t.reducedMotion,
      initScript: t.initScript,
      assert: t.assert,
      evaluateActual: t.evaluateActual,
    };
    const res = runCapture(captureItem);
    finalOk = res.status === 0 && res.data && res.data.ok;
    finalEvidence = {
      screenshot: res.screenshotPath,
      json: res.jsonPath,
    };
    if (finalOk) {
      finalActual = res.data?.actual || 'Matches expected result exactly';
    } else {
      finalActual = (res.data?.failures || []).join('; ') || res.stderr.trim() || 'Check failed';
    }
  } else {
    // "Where a row names no viewport, run 1280x800 and 375x812 and fail the row if either fails."
    const item1280 = {
      id: t.id,
      url: t.url,
      width: 1280,
      height: 800,
      outDir: 'ui',
      waitFor: t.waitFor,
      actions: t.actions,
      reducedMotion: t.reducedMotion,
      initScript: t.initScript,
      assert: t.assert,
      evaluateActual: t.evaluateActual,
    };
    const res1280 = runCapture(item1280);
    const ok1280 = res1280.status === 0 && res1280.data && res1280.data.ok;

    const item375 = {
      id: `${t.id}-375`,
      url: t.url,
      width: 375,
      height: 812,
      outDir: 'ui',
      waitFor: t.waitFor,
      actions: t.actions,
      reducedMotion: t.reducedMotion,
      initScript: t.initScript,
      assert: t.assert,
      evaluateActual: t.evaluateActual,
    };
    const res375 = runCapture(item375);
    const ok375 = res375.status === 0 && res375.data && res375.data.ok;

    // Clean up temporary 375 evidence files if pass to keep audit under 15 MB
    if (ok375 && ok1280) {
      try {
        fs.rmSync(path.join(root, 'audit/evidence/ui', `${t.id}-375.json`), { force: true });
        fs.rmSync(path.join(root, 'audit/evidence/ui', `${t.id}-375.jpg`), { force: true });
        fs.rmSync(path.join(root, 'audit/evidence/ui', `${t.id}-375.webp`), { force: true });
      } catch {}
    }

    finalOk = Boolean(ok1280 && ok375);
    finalEvidence = {
      screenshot: res1280.screenshotPath,
      json: res1280.jsonPath,
    };

    if (finalOk) {
      finalActual = res1280.data?.actual || 'Matches expected result exactly at 1280px and 375px';
    } else {
      const errs = [];
      if (!ok1280) errs.push(`1280px: ${(res1280.data?.failures || []).join(', ') || res1280.stderr.trim()}`);
      if (!ok375) errs.push(`375px: ${(res375.data?.failures || []).join(', ') || res375.stderr.trim()}`);
      finalActual = errs.join('; ') || 'Failed on one or both viewports';
    }
  }

  const status = finalOk ? 'PASS' : 'FAIL';
  if (finalOk) {
    passCount++;
    console.log('PASS');
  } else {
    failCount++;
    console.log(`FAIL (${finalActual})`);
    failures.push({ id: t.id, actual: finalActual });
  }

  results.push({
    id: t.id,
    status,
    expected,
    actual: finalActual,
    evidence: finalEvidence,
  });

  // Incrementally save ui.json
  fs.writeFileSync(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
}

// Stop local stack
stopStack();

console.log('\n========================================');
console.log(`AUDIT COMPLETE: ${passCount} PASS, ${failCount} FAIL (Total: ${TESTS.length})`);
console.log('========================================');
if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) {
    console.log(`- ${f.id}: ${f.actual}`);
  }
}
