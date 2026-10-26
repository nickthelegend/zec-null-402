#!/usr/bin/env node
// One-page evidence capture for the Kippu audit. Plain Node, Playwright from e2e/.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const e2eDir = path.join(root, 'e2e');
const DEFAULT_OUT_DIR = 'runner-smoke';
const OUT_DIR_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
// Assigned only after parseItem accepts the item. Screenshot and JSON both use it.
let evidenceDir = '';
const HEAVY_SLOT = '/Volumes/Extreme SSD/Projects/grokbot/tools/heavy-slot.sh';
const SLOT_NAME = 'audit-kippu';
const MAX_SCREENSHOT_BYTES = 200 * 1024;
const LOAD_STATES = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);

// Document navigations to these hosts are refused. The requested page's own host is allowed.
const EXPLORER_EXACT = new Set([
  'zecblock.com',
  'zcha.in',
  'blockchair.com',
  'blockstream.info',
  '3xpl.com',
  'zec.rocks',
  'blockchain.com',
  'mempool.space',
  'chain.so',
  'sochain.com',
]);
const EXPLORER_SUFFIXES = [
  '.zecblock.com',
  '.zcha.in',
  '.blockchair.com',
  '.blockstream.info',
  '.3xpl.com',
  '.zec.rocks',
  '.blockchain.com',
  '.mempool.space',
];
const GITHUB_EXACT = new Set(['github.com', 'githubusercontent.com', 'github.io']);
const GITHUB_SUFFIXES = ['.github.com', '.githubusercontent.com', '.github.io'];

let acquired = false;
let browserPid = 0;
let browserHandle = null;
let browserServer = null;

function writeErr(message) {
  process.stderr.write(`${message}\n`);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

function hasBin(name) {
  return run('which', [name], { stdio: 'ignore' }).status === 0;
}

function parseHttp(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function hostnameOf(value) {
  const url = parseHttp(value);
  return url ? url.hostname.toLowerCase() : '';
}

function matchesHost(hostname, exact, suffixes) {
  return exact.has(hostname) || suffixes.some((suffix) => hostname.endsWith(suffix));
}

function isGithubHost(hostname) {
  return matchesHost(hostname, GITHUB_EXACT, GITHUB_SUFFIXES);
}

function isExplorerHost(hostname) {
  if (matchesHost(hostname, EXPLORER_EXACT, EXPLORER_SUFFIXES)) return true;
  return hostname.includes('explorer');
}

function isForbiddenHost(hostname) {
  return isGithubHost(hostname) || isExplorerHost(hostname);
}

// The page we were asked to open may link out to GitHub or a block explorer.
// Those document navigations are aborted. The requested host itself is allowed.
function forbiddenNavigation(target, requestUrl) {
  const targetUrl = parseHttp(target);
  if (!targetUrl) return false;
  const request = parseHttp(requestUrl);
  if (request && targetUrl.host === request.host) return false;
  return isForbiddenHost(targetUrl.hostname.toLowerCase());
}

function classify(responseUrl, requestUrl, pageUrl) {
  let response;
  try {
    response = new URL(responseUrl);
  } catch {
    return { host: '', sameOrigin: false, counted: false };
  }
  const http = response.protocol === 'http:' || response.protocol === 'https:';
  const request = parseHttp(requestUrl);
  const page = parseHttp(pageUrl);
  const sameOrigin = http && (
    (request && response.origin === request.origin)
    || (page && response.origin === page.origin)
  );
  // Same-origin responses count, and so does any response on the request URL's host
  // (or the host the page actually landed on). Other hosts are recorded only.
  const hostCounts = http && response.host !== '' && (
    (request && response.host === request.host)
    || (page && response.host === page.host)
  );
  return { host: response.host, sameOrigin, counted: Boolean(sameOrigin || hostCounts) };
}

function parseItem(raw) {
  if (process.argv.length > 3) throw new Error('pass exactly one JSON item on argv');
  if (!raw) throw new Error('usage: node audit/runner/capture.mjs \'{"id":"...","url":"...","width":1280,"height":800}\'');
  let item;
  try {
    item = JSON.parse(raw);
  } catch {
    throw new Error('argv is not valid JSON');
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('argv must be one JSON object');
  if (typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(item.id)) {
    throw new Error('id must be a short safe filename token');
  }
  if (typeof item.url !== 'string' || item.url.length === 0) throw new Error('url is required');
  let parsed;
  try {
    parsed = new URL(item.url);
  } catch {
    throw new Error('url is not a valid URL');
  }
  if (!['http:', 'https:', 'data:'].includes(parsed.protocol)) throw new Error('url must be http, https, or data');
  for (const key of ['width', 'height']) {
    if (!Number.isInteger(item[key]) || item[key] < 1 || item[key] > 10000) {
      throw new Error(`${key} must be an integer from 1 to 10000`);
    }
  }
  if (item.waitFor != null && typeof item.waitFor !== 'string' && typeof item.waitFor !== 'number') {
    throw new Error('waitFor must be a load state, a selector, or milliseconds');
  }
  if (typeof item.waitFor === 'number' && (!Number.isFinite(item.waitFor) || item.waitFor < 0 || item.waitFor > 120000)) {
    throw new Error('waitFor milliseconds must be between 0 and 120000');
  }
  if (item.expectStatus != null && (!Number.isInteger(item.expectStatus) || item.expectStatus < 100 || item.expectStatus > 599)) {
    throw new Error('expectStatus must be an integer status code');
  }
  if (item.allowStatuses != null && (!Array.isArray(item.allowStatuses) || item.allowStatuses.some((status) => !Number.isInteger(status)))) {
    throw new Error('allowStatuses must be an array of integer status codes');
  }
  const actions = item.actions ?? [];
  if (!Array.isArray(actions)) throw new Error('actions must be an array');
  for (const action of actions) {
    if (!action || typeof action !== 'object') throw new Error('each action must be an object');
    if (!['click', 'fill', 'press'].includes(action.type)) throw new Error('action type must be click, fill, or press');
    if (typeof action.selector !== 'string' || action.selector.length === 0) throw new Error('action selector is required');
    if ((action.type === 'fill' || action.type === 'press') && typeof action.text !== 'string') {
      throw new Error(`${action.type} requires text`);
    }
  }
  return {
    id: item.id,
    url: item.url,
    width: item.width,
    height: item.height,
    waitFor: item.waitFor ?? 'load',
    expectStatus: item.expectStatus ?? null,
    allowStatuses: item.allowStatuses ?? [],
    actions,
    outDir: checkedOutDir(item),
  };
}

// outDir is optional. When present it is one directory name under audit/evidence.
function checkedOutDir(item) {
  if (item.outDir === undefined) return DEFAULT_OUT_DIR;
  const outDir = item.outDir;
  if (typeof outDir !== 'string') throw new Error('outDir must match ^[a-z0-9][a-z0-9-]{0,40}$');
  if (path.isAbsolute(outDir) || /[/\\.]/.test(outDir) || outDir.includes('..')) {
    throw new Error('outDir rejects absolute paths, slashes, dots, and ..');
  }
  if (!OUT_DIR_RE.test(outDir)) throw new Error('outDir must match ^[a-z0-9][a-z0-9-]{0,40}$');
  return outDir;
}

function evidenceDirectory(outDir) {
  const base = path.resolve(root, 'audit/evidence');
  const dir = path.resolve(base, outDir);
  const rel = path.relative(base, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).includes('..')) {
    throw new Error('outDir must stay under audit/evidence');
  }
  return dir;
}

function ensurePlaywrightInstalled() {
  const pkgPath = path.join(e2eDir, 'node_modules/@playwright/test/package.json');
  if (fs.existsSync(pkgPath)) return;
  const installed = run('npm', ['install'], { cwd: e2eDir });
  if (installed.status !== 0) {
    writeErr(installed.stderr || installed.stdout || 'npm install in e2e/ failed');
    process.exit(1);
  }
  if (!fs.existsSync(pkgPath)) {
    writeErr('npm install did not provide @playwright/test');
    process.exit(1);
  }
}

async function loadChromium() {
  ensurePlaywrightInstalled();
  const pkg = JSON.parse(fs.readFileSync(path.join(e2eDir, 'node_modules/@playwright/test/package.json'), 'utf8'));
  if (pkg.version !== '1.63.0') {
    throw new Error(`expected @playwright/test 1.63.0, found ${pkg.version}`);
  }
  const entry = path.join(e2eDir, 'node_modules/@playwright/test/index.mjs');
  const mod = await import(pathToFileURL(entry).href);
  return mod.chromium;
}

function ensureBrowserBinary(chromium) {
  const executablePath = chromium.executablePath();
  if (fs.existsSync(executablePath)) return executablePath;
  const cli = path.join(e2eDir, 'node_modules/.bin/playwright');
  const installed = run(cli, ['install', 'chromium'], { cwd: e2eDir });
  if (installed.status !== 0 || !fs.existsSync(executablePath)) {
    writeErr(installed.stderr || installed.stdout || `Chrome for Testing is missing at ${executablePath}`);
    process.exit(1);
  }
  return executablePath;
}

function listProcesses() {
  const listed = run('ps', ['-ax', '-o', 'pid=,ppid=']);
  const rows = [];
  if (listed.status !== 0) return rows;
  for (const line of listed.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) rows.push({ pid, ppid });
  }
  return rows;
}

function descendantsOf(pid) {
  const byParent = new Map();
  for (const row of listProcesses()) {
    const kids = byParent.get(row.ppid) ?? [];
    kids.push(row.pid);
    byParent.set(row.ppid, kids);
  }
  const out = [];
  const stack = [...(byParent.get(pid) ?? [])];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current) || current === pid) continue;
    seen.add(current);
    out.push(current);
    for (const child of byParent.get(current) ?? []) stack.push(child);
  }
  return out;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Kill only the browser process this run started, plus descendants it spawned.
function killBrowserTree(pid) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  const victims = [...descendantsOf(pid), pid];
  for (const victim of victims) {
    try { process.kill(victim, 'SIGTERM'); } catch { /* already gone */ }
  }
  if (victims.some(alive)) run('sleep', ['0.25'], { stdio: 'ignore' });
  for (const victim of victims) {
    if (!alive(victim)) continue;
    try { process.kill(victim, 'SIGKILL'); } catch { /* already gone */ }
  }
}

function acquireSlot() {
  const result = run(HEAVY_SLOT, ['acquire', SLOT_NAME]);
  if (result.error) {
    writeErr(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    writeErr(result.stderr || 'heavy-slot acquire failed');
    process.exit(1);
  }
  acquired = true;
}

function releaseSlot() {
  if (!acquired) return;
  const result = run(HEAVY_SLOT, ['release', SLOT_NAME]);
  if (result.status === 0) acquired = false;
  else writeErr(result.stderr || 'heavy-slot release failed');
}

function cleanupSync() {
  const pid = browserPid;
  browserPid = 0;
  if (pid) killBrowserTree(pid);
  releaseSlot();
}

process.on('exit', cleanupSync);
process.on('SIGINT', () => { cleanupSync(); process.exit(130); });
process.on('SIGTERM', () => { cleanupSync(); process.exit(143); });
process.on('SIGHUP', () => { cleanupSync(); process.exit(129); });

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function runActions(page, actions) {
  for (const action of actions) {
    const locator = page.locator(action.selector);
    if (action.type === 'click') await locator.click({ timeout: 15000 });
    else if (action.type === 'fill') await locator.fill(action.text, { timeout: 15000 });
    else await locator.press(action.text, { timeout: 15000 });
  }
}

function shrinkWithSips(png, jpg) {
  if (!hasBin('sips')) return false;
  const widths = [null, 1400, 1100, 900, 700, 520, 360];
  const qualities = [70, 50, 35, 20, 12];
  for (const width of widths) {
    for (const quality of qualities) {
      const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality)];
      if (width) args.push('--resampleWidth', String(width));
      args.push(png, '--out', jpg);
      const result = run('sips', args, { stdio: 'ignore' });
      if (result.status === 0 && fileSize(jpg) > 0 && fileSize(jpg) <= MAX_SCREENSHOT_BYTES) return true;
    }
  }
  return false;
}

function shrinkWithFfmpeg(png, dest, kind) {
  if (!hasBin('ffmpeg')) return false;
  const scales = ['iw:-1', '1280:-1', '960:-1', '720:-1', '480:-1'];
  for (const scale of scales) {
    const qualities = kind === 'webp' ? [70, 50, 35, 20] : [8, 12, 16, 20, 24, 30];
    for (const quality of qualities) {
      const args = ['-y', '-i', png, '-vf', `scale=${scale}`];
      if (kind === 'webp') args.push('-c:v', 'libwebp', '-quality', String(quality));
      else args.push('-q:v', String(quality));
      args.push(dest);
      const result = run('ffmpeg', args, { stdio: 'ignore', timeout: 20000 });
      if (result.status === 0 && fileSize(dest) > 0 && fileSize(dest) <= MAX_SCREENSHOT_BYTES) return true;
    }
  }
  return false;
}

async function saveScreenshot(page, id) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const jpg = path.join(evidenceDir, `${id}.jpg`);
  const webp = path.join(evidenceDir, `${id}.webp`);
  const tmpPng = path.join(os.tmpdir(), `kippu-capture-${process.pid}-${id}.png`);
  const finish = (chosen) => {
    for (const file of [jpg, webp, tmpPng]) {
      if (file !== chosen) fs.rmSync(file, { force: true });
    }
    return chosen;
  };
  try {
    for (const quality of [82, 64, 48, 32, 20]) {
      await page.screenshot({ path: jpg, type: 'jpeg', quality, animations: 'disabled' });
      if (fileSize(jpg) > 0 && fileSize(jpg) <= MAX_SCREENSHOT_BYTES) return finish(jpg);
    }
  } catch {
    fs.rmSync(jpg, { force: true });
  }
  await page.screenshot({ path: tmpPng, type: 'png', animations: 'disabled' });
  if (shrinkWithSips(tmpPng, jpg)) return finish(jpg);
  if (shrinkWithFfmpeg(tmpPng, jpg, 'jpg')) return finish(jpg);
  if (shrinkWithFfmpeg(tmpPng, webp, 'webp')) return finish(webp);
  fs.rmSync(tmpPng, { force: true });
  throw new Error(`screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes`);
}

function relativeToRoot(abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

async function capture(chromium, executablePath, item) {
  const consoleMessages = [];
  const pageErrors = [];
  const responses = [];
  const blockedNavigations = [];
  const failures = [];
  const allowed = new Set(item.allowStatuses);

  // Browser.process() is gone in Playwright 1.63. launchServer still exposes the
  // Chrome PID. executablePath selects Google Chrome for Testing, not the headless shell.
  const server = await chromium.launchServer({
    headless: true,
    executablePath,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  browserServer = server;
  const launched = server.process();
  browserPid = launched?.pid || 0;
  const spawnfile = launched?.spawnfile || executablePath;
  if (!`${spawnfile}\n${executablePath}`.includes('Google Chrome for Testing')) {
    throw new Error(`Chrome for Testing was not launched (${spawnfile})`);
  }
  const browser = await chromium.connect(server.wsEndpoint());
  browserHandle = browser;

  const context = await browser.newContext({
    viewport: { width: item.width, height: item.height },
  });
  await context.addInitScript((cfg) => {
    const forbidden = (href) => {
      let url;
      try { url = new URL(href, location.href); } catch { return false; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      if (cfg.itemHost && url.host === cfg.itemHost) return false;
      const host = url.hostname.toLowerCase();
      if (cfg.githubExact.includes(host) || cfg.explorerExact.includes(host)) return true;
      if (cfg.githubSuffixes.some((suffix) => host.endsWith(suffix))) return true;
      if (cfg.explorerSuffixes.some((suffix) => host.endsWith(suffix))) return true;
      return host.includes('explorer');
    };
    const blockAnchor = (event) => {
      const node = event.target;
      const anchor = node && node.closest ? node.closest('a[href]') : null;
      if (!anchor || !forbidden(anchor.href)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    addEventListener('click', blockAnchor, true);
    addEventListener('auxclick', blockAnchor, true);
    addEventListener('submit', (event) => {
      const form = event.target;
      if (!form || !form.action || !forbidden(form.action)) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  }, {
    itemHost: parseHttp(item.url)?.host || '',
    githubExact: [...GITHUB_EXACT],
    githubSuffixes: GITHUB_SUFFIXES,
    explorerExact: [...EXPLORER_EXACT],
    explorerSuffixes: EXPLORER_SUFFIXES,
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && forbiddenNavigation(request.url(), item.url)) {
      blockedNavigations.push(request.url());
      await route.abort('aborted');
      return;
    }
    await route.continue();
  });

  const watch = (page) => {
    page.on('console', (message) => {
      consoleMessages.push({
        type: message.type(),
        text: clip(message.text(), 2000),
        location: message.location(),
      });
    });
    page.on('pageerror', (error) => {
      pageErrors.push({
        message: clip(error instanceof Error ? error.message : error, 2000),
        stack: clip(error instanceof Error ? error.stack : '', 4000),
      });
    });
    page.on('response', (response) => {
      const url = response.url();
      responses.push({
        url,
        status: response.status(),
        ...classify(url, item.url, page.url()),
      });
    });
  };

  const page = await context.newPage();
  watch(page);
  context.on('page', (popup) => {
    watch(popup);
    popup.waitForLoadState('domcontentloaded').then(() => {
      if (forbiddenNavigation(popup.url(), item.url)) return popup.close();
      return undefined;
    }).catch(() => {});
  });

  const waitUntil = typeof item.waitFor === 'string' && LOAD_STATES.has(item.waitFor) ? item.waitFor : 'load';
  let navigation = null;
  try {
    navigation = await page.goto(item.url, { waitUntil, timeout: 30000 });
  } catch (error) {
    failures.push(`navigation failed: ${clip(error.message, 500)}`);
  }
  const navigationStatus = navigation ? navigation.status() : null;
  if (item.expectStatus != null && navigationStatus !== item.expectStatus) {
    failures.push(`expected status ${item.expectStatus}, got ${navigationStatus}`);
  }
  try {
    if (typeof item.waitFor === 'number') await new Promise((resolve) => setTimeout(resolve, item.waitFor));
    else if (typeof item.waitFor === 'string' && !LOAD_STATES.has(item.waitFor)) {
      await page.locator(item.waitFor).waitFor({ state: 'visible', timeout: 15000 });
    }
  } catch (error) {
    failures.push(`waitFor failed: ${clip(error.message, 500)}`);
  }
  try {
    await runActions(page, item.actions);
  } catch (error) {
    failures.push(`action failed: ${clip(error.message, 500)}`);
  }

  let screenshot = '';
  let screenshotBytes = 0;
  try {
    const shot = await saveScreenshot(page, item.id);
    screenshot = relativeToRoot(shot);
    screenshotBytes = fileSize(shot);
    if (screenshotBytes > MAX_SCREENSHOT_BYTES) failures.push(`screenshot is ${screenshotBytes} bytes`);
  } catch (error) {
    failures.push(clip(error.message, 500));
  }

  if (blockedNavigations.length) {
    failures.push(`refused navigation to a third-party explorer or GitHub: ${blockedNavigations[0]}`);
  }
  for (const message of consoleMessages) {
    if (message.type === 'error') failures.push(`console error: ${message.text}`);
  }
  for (const error of pageErrors) failures.push(`page error: ${error.message}`);
  const mainUrl = navigation?.url() || '';
  let excusedMain = false;
  for (const response of responses) {
    if (!response.counted || response.status < 400 || response.status > 599) continue;
    if (allowed.has(response.status)) continue;
    if (!excusedMain && item.expectStatus != null && response.status === item.expectStatus && response.url === mainUrl) {
      excusedMain = true;
      continue;
    }
    failures.push(`unexpected ${response.status} ${response.url}`);
  }

  const payload = {
    id: item.id,
    url: item.url,
    requestHost: parseHttp(item.url)?.host || '',
    width: item.width,
    height: item.height,
    waitFor: item.waitFor,
    expectStatus: item.expectStatus,
    allowStatuses: item.allowStatuses,
    ok: failures.length === 0,
    failures,
    navigationStatus,
    screenshot,
    screenshotBytes,
    browserExecutable: spawnfile,
    console: consoleMessages,
    pageErrors,
    responses,
    blockedNavigations,
  };
  fs.mkdirSync(evidenceDir, { recursive: true });
  const jsonAbs = path.join(evidenceDir, `${item.id}.json`);
  fs.writeFileSync(jsonAbs, `${JSON.stringify(payload, null, 2)}\n`);
  return { ok: payload.ok, jsonPath: relativeToRoot(jsonAbs), failures };
}

async function shutdownBrowser() {
  const browser = browserHandle;
  const server = browserServer;
  browserHandle = null;
  browserServer = null;
  if (browser) {
    try { await browser.close(); } catch { /* the exit trap still kills the pid */ }
  }
  if (server) {
    try { await server.close(); } catch { /* same */ }
  }
  const pid = browserPid;
  if (pid && alive(pid)) killBrowserTree(pid);
  browserPid = 0;
}

async function main() {
  const item = parseItem(process.argv[2]);
  evidenceDir = evidenceDirectory(item.outDir);
  if (isForbiddenHost(hostnameOf(item.url))) {
    throw new Error('refusing to navigate to a third-party explorer or GitHub URL');
  }
  const chromium = await loadChromium();
  const executablePath = ensureBrowserBinary(chromium);
  acquireSlot();
  let code = 1;
  let jsonPath = '';
  try {
    const result = await capture(chromium, executablePath, item);
    code = result.ok ? 0 : 1;
    jsonPath = result.jsonPath;
    if (!result.ok) writeErr(result.failures.join('\n'));
  } finally {
    await shutdownBrowser();
    releaseSlot();
  }
  if (jsonPath) process.stdout.write(`${jsonPath}\n`);
  process.exit(code);
}

main().catch(async (error) => {
  writeErr(error.stack || error.message || String(error));
  await shutdownBrowser();
  releaseSlot();
  process.exit(1);
});
