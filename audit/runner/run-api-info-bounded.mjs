import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Gateway, serveGateway } from '../../packages/gateway/dist/index.js';

const d = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const items = d.deposit.items;

const dir = mkdtempSync(join(tmpdir(), 'z402-bounded-test-'));
const gw = new Gateway({
  statePath: join(dir, 'state.db'),
  depositUa: d.wallets.gateway.address,
  depositUivk: d.wallets.gateway.uivk,
  unitZat: d.unitZat,
  prices: { '/api/quote': BigInt(d.priceUnits) },
  content: (p) => ({ served: p }),
});

console.log('Claiming deposit...');
await gw.claim(d.deposit.txid, items);

console.log('Inserting 50,000 anchor rows...');
const ins = gw.db.prepare('INSERT INTO anchors (txid, leaves, root, nullifiers, nullifier_hash, at, height) VALUES (?, 22, ?, 0, ?, ?, ?)');
gw.db.exec('BEGIN');
for (let i = 0; i < 50_000; i++) {
  ins.run(randomBytes(32).toString('hex'), d.gateway.root, '0'.repeat(64), '2026-10-22T00:00:00.000Z', 4_500_000 + i);
}
gw.db.exec('COMMIT');

const s = serveGateway(gw);
await new Promise((r) => s.listen(0, '127.0.0.1', r));
const port = s.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`Server listening at ${base}`);

// Run capture asynchronously so node event loop remains active!
const item = {
  id: 'API-INFO-BOUNDED',
  url: `${base}/api/info`,
  width: 1280,
  height: 800,
  outDir: 'retest',
  assert: '(() => { const b = JSON.parse(document.body.innerText); if (b.anchorCount !== 50000) return `anchorCount ${b.anchorCount}`; if (b.anchors?.length !== 16) return `anchors length ${b.anchors?.length}`; if (b.anchors.at(-1)?.height !== 4549999) return `last height ${b.anchors.at(-1)?.height}`; if (b.latestAnchor?.height !== 4549999) return `latestAnchor ${b.latestAnchor?.height}`; return true; })()',
  evaluateActual: '(() => { const b = JSON.parse(document.body.innerText); return JSON.stringify({ anchorCount: b.anchorCount, anchorsLength: b.anchors?.length, lastAnchorHeight: b.anchors?.at(-1)?.height, latestAnchorHeight: b.latestAnchor?.height, bodyBytes: document.body.innerText.length }); })()',
};

const child = spawn('node', ['audit/runner/capture.mjs', JSON.stringify(item)], { stdio: 'inherit' });

child.on('exit', (code) => {
  s.close();
  gw.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(code ?? 0);
});
