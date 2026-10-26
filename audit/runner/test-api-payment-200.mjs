import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Tree, provePayment } from '../../packages/circuits/dist/index.js';
import { Gateway, serveGateway } from '../../packages/gateway/dist/index.js';

const d = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'z402-payment-200-'));

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
  id: 'API-PAYMENT-200-SUCCESS',
  url: `${base}/api/info`,
  width: 1280,
  height: 800,
  outDir: 'retest',
  initScript: `window.__PAYMENT_HEADER = ${JSON.stringify(paymentHeader)};`,
  assert: `fetch('/api/quote', {
    headers: { 'x-payment': window.__PAYMENT_HEADER }
  }).then(async (res) => {
    const receipt = res.headers.get('x-payment-response');
    const body = await res.json();
    window.__RESULT = { status: res.status, receipt, body };
    if (res.status !== 200) return 'expected status 200, got ' + res.status;
    if (!receipt) return 'missing x-payment-response header';
    if (!body.paid || body.paid.amount !== '10') return 'paid amount mismatch: ' + JSON.stringify(body.paid);
    if (!body.data || body.data.quote !== 'ZEC/USD') return 'data mismatch: ' + JSON.stringify(body.data);
    return true;
  })`,
  evaluateActual: `(() => JSON.stringify(window.__RESULT))()`,
};

const child = spawn('node', ['audit/runner/capture.mjs', JSON.stringify(item)], { stdio: 'inherit' });

child.on('exit', (code) => {
  s.close();
  gw.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(code ?? 0);
});
