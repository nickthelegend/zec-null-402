import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Gateway, serveGateway } from '../../packages/gateway/dist/index.js';

const d = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'z402-bad-proof-'));

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

const s = serveGateway(gw);
await new Promise((r) => s.listen(0, '127.0.0.1', r));
const port = s.address().port;
const base = `http://127.0.0.1:${port}`;

const item = {
  id: 'API-PAYMENT-402-BAD-PROOF',
  url: `${base}/api/info`,
  width: 1280,
  height: 800,
  outDir: 'retest',
  allowStatuses: [402],
  assert: `fetch('/api/quote').then(r => r.json()).then(async (c) => {
    const a = c.accepts[0];
    const p = {
      nonce: a.nonce,
      proof: {
        pi_a: ['1', '2', '1'],
        pi_b: [['1', '2'], ['3', '4'], ['1', '0']],
        pi_c: ['1', '2', '1'],
        protocol: 'groth16',
        curve: 'bn128'
      },
      signals: {
        nullifier: '12345678901234567890',
        merkle_root: a.root,
        pay_to: a.payTo,
        required_amount: a.requiredAmount,
        context_hash: a.contextHash
      }
    };
    const res = await fetch('/api/quote', {
      headers: { 'x-payment': btoa(JSON.stringify(p)) }
    });
    if (res.status !== 402) return 'expected status 402, got ' + res.status;
    const body = await res.json();
    if (body.reason !== 'BAD_PROOF') return 'expected reason BAD_PROOF, got ' + body.reason;
    return true;
  })`,
  evaluateActual: `(async () => {
    const a = (await (await fetch('/api/quote')).json()).accepts[0];
    const p = {
      nonce: a.nonce,
      proof: {
        pi_a: ['1', '2', '1'],
        pi_b: [['1', '2'], ['3', '4'], ['1', '0']],
        pi_c: ['1', '2', '1'],
        protocol: 'groth16',
        curve: 'bn128'
      },
      signals: {
        nullifier: '12345678901234567890',
        merkle_root: a.root,
        pay_to: a.payTo,
        required_amount: a.requiredAmount,
        context_hash: a.contextHash
      }
    };
    const res = await fetch('/api/quote', {
      headers: { 'x-payment': btoa(JSON.stringify(p)) }
    });
    return JSON.stringify({ status: res.status, body: await res.json() });
  })()`,
};

const child = spawn('node', ['audit/runner/capture.mjs', JSON.stringify(item)], { stdio: 'inherit' });

child.on('exit', (code) => {
  s.close();
  gw.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(code ?? 0);
});
