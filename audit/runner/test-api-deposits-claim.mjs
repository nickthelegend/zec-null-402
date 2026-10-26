import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Gateway, serveGateway } from '../../packages/gateway/dist/index.js';

const d = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'z402-deposits-claim-'));

const gw = new Gateway({
  statePath: join(dir, 'state.db'),
  depositUa: d.wallets.gateway.address,
  depositUivk: d.wallets.gateway.uivk,
  unitZat: d.unitZat,
  prices: { '/api/quote': BigInt(d.priceUnits) },
  content: () => ({ quote: 'ZEC/USD' }),
  anchorUivk: d.wallets.anchor.uivk,
});

const s = serveGateway(gw);
await new Promise((r) => s.listen(0, '127.0.0.1', r));
const port = s.address().port;
const base = `http://127.0.0.1:${port}`;

const expectedRoot = '4498787375493044641629502448109918628546215513903653918575713697752952913389';
const postBody = JSON.stringify({ txid: d.deposit.txid, items: d.deposit.items });

const item = {
  id: 'API-DEPOSITS-200-CLAIM',
  url: `${base}/api/info`,
  width: 1280,
  height: 800,
  outDir: 'retest',
  initScript: `window.__CLAIM_BODY = ${JSON.stringify(postBody)};`,
  assert: `fetch('/api/deposits', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: window.__CLAIM_BODY
  }).then(async (res) => {
    if (res.status !== 200) return 'expected status 200, got ' + res.status;
    const body = await res.json();
    if (body.first !== 0) return 'expected first === 0, got ' + body.first;
    if (body.count !== 22) return 'expected count === 22, got ' + body.count;
    if (body.root !== "${expectedRoot}") return 'expected root ${expectedRoot}, got ' + body.root;
    return true;
  })`,
  evaluateActual: `(async () => {
    const res = await fetch('/api/leaves');
    const leavesBody = await res.json();
    return JSON.stringify({ count: leavesBody.leaves.length, root: leavesBody.root });
  })()`,
};

const child = spawn('node', ['audit/runner/capture.mjs', JSON.stringify(item)], { stdio: 'inherit' });

child.on('exit', (code) => {
  s.close();
  gw.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(code ?? 0);
});
