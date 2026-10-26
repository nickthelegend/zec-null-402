import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Tree, provePayment } from '../../packages/circuits/dist/index.js';
import { Gateway, serveGateway } from '../../packages/gateway/dist/index.js';

const d = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'z402-concurrent-two-'));

const gw = new Gateway({
  statePath: join(dir, 'state.db'),
  depositUa: d.wallets.gateway.address,
  depositUivk: d.wallets.gateway.uivk,
  unitZat: d.unitZat,
  prices: { '/api/quote': BigInt(d.priceUnits) },
  content: () => ({ quote: 'ZEC/USD' }),
  anchorUivk: d.wallets.anchor.uivk,
});

await gw.claim(d.deposit.txid, d.deposit.items);
await gw.adoptAnchor(d.anchor.txid);

const s = serveGateway(gw);
await new Promise((r) => s.listen(0, '127.0.0.1', r));
const port = s.address().port;
const base = `http://127.0.0.1:${port}`;

const c1 = (await (await fetch(`${base}/api/quote`)).json()).accepts[0];
const c2 = (await (await fetch(`${base}/api/quote`)).json()).accepts[0];

const leaves = (await (await fetch(`${base}/api/leaves`)).json()).leaves;
const tree = await Tree.build(leaves.map(BigInt));

const n = d.fixtureNotes[0];
const note = { noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value) };

const p1 = await provePayment(note, n.index, tree, BigInt(c1.payTo), BigInt(c1.requiredAmount), BigInt(c1.contextHash));
const p2 = await provePayment(note, n.index, tree, BigInt(c2.payTo), BigInt(c2.requiredAmount), BigInt(c2.contextHash));

const h1 = Buffer.from(JSON.stringify({ nonce: c1.nonce, proof: p1.proof, signals: p1.signals })).toString('base64');
const h2 = Buffer.from(JSON.stringify({ nonce: c2.nonce, proof: p2.proof, signals: p2.signals })).toString('base64');

const item = {
  id: 'API-PAYMENT-CONCURRENT-TWO-PROOFS-SAME-NOTE',
  url: `${base}/api/info`,
  width: 1280,
  height: 800,
  outDir: 'retest',
  allowStatuses: [402],
  initScript: `window.__P1 = ${JSON.stringify(h1)}; window.__P2 = ${JSON.stringify(h2)};`,
  assert: `(async () => {
    const post1 = fetch('/api/quote', { headers: { 'x-payment': window.__P1 } });
    const post2 = fetch('/api/quote', { headers: { 'x-payment': window.__P2 } });
    const responses = await Promise.all([post1, post2]);
    const statuses = responses.map(r => r.status);
    const bodies = await Promise.all(responses.map(r => r.json()));
    window.__RESULT = { statuses, bodies };

    const ok200 = responses.filter(r => r.status === 200);
    const ref402 = responses.filter(r => r.status === 402);
    if (ok200.length !== 1 || ref402.length !== 1) {
      return 'expected exactly one 200 and one 402, got ' + JSON.stringify(statuses);
    }
    const bad = bodies.find(b => b.reason && b.reason !== 'NULLIFIER_SPENT');
    if (bad) return 'expected reason NULLIFIER_SPENT, got ' + bad.reason;
    return true;
  })()`,
  evaluateActual: `(() => JSON.stringify(window.__RESULT))()`,
};

const child = spawn('node', ['audit/runner/capture.mjs', JSON.stringify(item)], { stdio: 'inherit' });

child.on('exit', (code) => {
  s.close();
  gw.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(code ?? 0);
});
