import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Tree, provePayment } from '../../packages/circuits/dist/index.js';
import { Gateway, serveGateway } from '../../packages/gateway/dist/index.js';

const d = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'z402-concurrent-same-'));

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

const challenge = (await (await fetch(`${base}/api/quote`)).json()).accepts[0];
const leaves = (await (await fetch(`${base}/api/leaves`)).json()).leaves;
const tree = await Tree.build(leaves.map(BigInt));

const n = d.fixtureNotes[0];
const note = { noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value) };
const { proof, signals } = await provePayment(note, n.index, tree, BigInt(challenge.payTo), BigInt(challenge.requiredAmount), BigInt(challenge.contextHash));
const paymentHeader = Buffer.from(JSON.stringify({ nonce: challenge.nonce, proof, signals })).toString('base64');

const item = {
  id: 'API-PAYMENT-CONCURRENT-SAME-PAYMENT',
  url: `${base}/api/info`,
  width: 1280,
  height: 800,
  outDir: 'retest',
  allowStatuses: [402],
  initScript: `window.__PAYMENT_HEADER = ${JSON.stringify(paymentHeader)};`,
  assert: `(async () => {
    const post = () => fetch('/api/quote', { headers: { 'x-payment': window.__PAYMENT_HEADER } });
    const responses = await Promise.all([post(), post(), post()]);
    const statuses = responses.map(r => r.status);
    const bodies = await Promise.all(responses.map(r => r.json()));
    window.__RESULT = { statuses, bodies };

    const ok200 = responses.filter(r => r.status === 200);
    const ref402 = responses.filter(r => r.status === 402);
    if (ok200.length !== 1 || ref402.length !== 2) {
      return 'expected exactly one 200 and two 402, got ' + JSON.stringify(statuses);
    }
    for (const b of bodies) {
      if (b.reason && b.reason !== 'NULLIFIER_SPENT') {
        return 'expected reason NULLIFIER_SPENT, got ' + b.reason;
      }
    }
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
