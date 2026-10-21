// Video demo, live: a fresh gateway credits the run's real deposit through its viewing key, then
// two calls are paid with real proofs (the published fixture notes), a replay and a tamper are
// refused, and the run's anchor is re-read on-chain.
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provePayment, Tree } from '@z402/circuits';
import { Gateway, scan, serveGateway } from '@z402/gateway';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const d = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet.json'), 'utf8'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = async (s: string, ms = 800) => {
  console.log(s);
  await sleep(ms);
};

async function main() {
  const gw = new Gateway({ statePath: join(mkdtempSync(join(tmpdir(), 'z402-demo-')), 'state.db'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': BigInt(d.priceUnits) }, content: () => ({ quote: 'ZEC/USD' }) });
  const s = serveGateway(gw);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

  await say(`1. a fresh gateway claims the shielded deposit ${d.deposit.txid.slice(0, 12)}… (22 notes, ${Number(d.deposit.amountZat).toLocaleString()} zat)`);
  const t0 = Date.now();
  const c = await gw.claim(d.deposit.txid, d.deposit.items);
  await say(`   its viewing key saw the deposit on testnet; ${c.count} notes credited in ${Date.now() - t0} ms, root ${c.root.slice(0, 14)}…`);
  try {
    await gw.claim(d.deposit.txid, d.deposit.items);
  } catch (e) {
    await say(`   claiming it again: ${(e as Error).message}`);
  }

  await say('\n2. pay two calls with zero-knowledge proofs (no transaction)');
  const tree = await Tree.build(gw.state.leaves.map(BigInt));
  const ch = async () => ((await (await fetch(`${base}/api/quote`)).json()) as { accepts: { payTo: string; requiredAmount: string; contextHash: string; nonce: string }[] }).accepts[0];
  const send = (p: object) => fetch(`${base}/api/quote`, { headers: { 'x-payment': Buffer.from(JSON.stringify(p)).toString('base64') } }).then(async (r) => ({ status: r.status, body: (await r.json()) as { reason?: string } }));
  const proofs = [];
  for (const n of d.fixtureNotes) {
    const note = { noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value) };
    const c1 = await ch();
    const t = Date.now();
    const p = await provePayment(note, Number(n.index), tree, BigInt(c1.payTo), BigInt(c1.requiredAmount), BigInt(c1.contextHash));
    const r = await send({ nonce: c1.nonce, ...p });
    proofs.push(p);
    await say(`   GET /api/quote → 402; proof ${Date.now() - t} ms → HTTP ${r.status}, nullifier ${p.signals.nullifier.slice(0, 12)}…`);
  }

  await say('\n3. attacks');
  const c2 = await ch();
  const replay = await send({ nonce: c2.nonce, proof: proofs[0].proof, signals: { ...proofs[0].signals, context_hash: c2.contextHash } });
  await say(`   replay a paid proof: HTTP ${replay.status} ${replay.body.reason}`);
  const c3 = await ch();
  const tampered = await send({ nonce: c3.nonce, proof: proofs[1].proof, signals: { ...proofs[1].signals, context_hash: c3.contextHash, nullifier: (BigInt(proofs[1].signals.nullifier) + 1n).toString() } });
  await say(`   change the nullifier: HTTP ${tampered.status} ${tampered.body.reason}`);
  s.close();

  await say('\n4. the live run’s anchor, read now with the anchor address’s viewing key');
  const a = await scan(d.wallets.anchor.uivk, d.anchor.txid, 1, d.anchor.memo);
  await say(`   ${d.anchor.txid.slice(0, 12)}… block ${a.height}: memo ${d.anchor.memo.slice(0, 40)}… on-chain ${a.ok}`, 2000);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${(e as Error).message}`);
    process.exit(1);
  },
);
