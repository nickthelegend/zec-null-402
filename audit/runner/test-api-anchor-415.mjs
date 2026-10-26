import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Gateway, serveGateway } from '../../packages/gateway/dist/index.js';

const dir = mkdtempSync(join(tmpdir(), 'z402-anchor-415-'));
let sendAnchorCalled = false;

const gw = new Gateway({
  statePath: join(dir, 'state.db'),
  depositUa: 'utest1mock',
  unitZat: 1000,
  prices: { '/api/quote': 10n },
  content: () => ({ ok: true }),
  adminToken: 'test-admin-token',
  sendAnchor: async () => {
    sendAnchorCalled = true;
    throw new Error('must not send');
  },
});

const s = serveGateway(gw);
await new Promise((r) => s.listen(0, '127.0.0.1', r));
const port = s.address().port;
const base = `http://127.0.0.1:${port}`;

const item = {
  id: 'API-ANCHOR-415-UNSUPPORTED-MEDIA',
  url: `${base}/api/info`,
  width: 1280,
  height: 800,
  outDir: 'retest',
  allowStatuses: [415],
  assert: `fetch('/api/anchor', {
    method: 'POST',
    headers: {
      'authorization': 'Bearer test-admin-token',
      'content-type': 'text/plain'
    },
    body: 'plain text'
  }).then(async (res) => {
    if (res.status !== 415) return 'expected status 415, got ' + res.status;
    const body = await res.json();
    if (body.error !== 'an anchor request must be sent as content-type: application/json') {
      return 'unexpected error message: ' + body.error;
    }
    return true;
  })`,
  evaluateActual: `(async () => {
    const res = await fetch('/api/anchor', {
      method: 'POST',
      headers: {
        'authorization': 'Bearer test-admin-token',
        'content-type': 'text/plain'
      },
      body: 'plain text'
    });
    return JSON.stringify({ status: res.status, body: await res.json() });
  })()`,
};

const child = spawn('node', ['audit/runner/capture.mjs', JSON.stringify(item)], { stdio: 'inherit' });

child.on('exit', (code) => {
  s.close();
  gw.close();
  rmSync(dir, { recursive: true, force: true });
  if (sendAnchorCalled) {
    console.error('FAIL: sendAnchor was called!');
    process.exit(1);
  }
  process.exit(code ?? 0);
});
