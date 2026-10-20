// A fresh gateway over HTTP, a real deposit on Zcash testnet (checked with the gateway's viewing key)
// and real Groth16 proofs. The two fixture notes were spent in the live run and their secrets
// published; this gateway starts empty, so they are unspent here.
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leafFromItem, nullifierOf, provePayment, Tree, type Note } from '@z402/circuits';
import { anchorMemo, Gateway, nullifierSetHash, scan, serveGateway } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const items = d.deposit.items as { secretHash: string; value: string }[];
const notes: (Note & { index: number })[] = d.fixtureNotes.map((n: Record<string, string>) => ({ noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value), index: Number(n.index) }));
let base = '';
let gw: Gateway;
let close = () => {};

beforeAll(async () => {
  gw = new Gateway({ statePath: join(mkdtempSync(join(tmpdir(), 'z402-')), 'state.json'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': BigInt(d.priceUnits) }, content: (p) => ({ served: p }) });
  const s = serveGateway(gw);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  close = () => s.close();
});
afterAll(() => close());

const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
const challenge = async () => ((await (await fetch(`${base}/api/quote`)).json()) as { accepts: { payTo: string; requiredAmount: string; contextHash: string; nonce: string; root: string }[] }).accepts[0];
const pay = (p: object) => fetch(`${base}/api/quote`, { headers: { 'x-payment': Buffer.from(JSON.stringify(p)).toString('base64') } }).then(async (r) => ({ status: r.status, body: (await r.json()) as { reason?: string; paid?: unknown } }));

describe('deposits (live testnet)', () => {
  it('altered note values are not credited: the memo commits to them', async () => {
    const r = await post('/api/deposits', { txid: d.deposit.txid, items: items.map((i, k) => (k === 0 ? { ...i, value: '1000' } : i)) });
    expect(r.status).toBe(402);
    expect(r.body.error).toMatch(/MEMO_MISMATCH/);
  });

  it('the real deposit credits its 22 notes, once; the tree matches the leaves computed from the published items', async () => {
    const r = await post('/api/deposits', { txid: d.deposit.txid, items });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ first: 0, count: 22 });
    const leaves = await Promise.all(items.map(leafFromItem));
    expect(r.body.root).toBe((await Tree.build(leaves)).root.toString());
    expect(r.body.root).toBe(d.gateway.root);
    expect((await post('/api/deposits', { txid: d.deposit.txid, items })).status).toBe(409);
  });

  it('a deposit that does not pay this gateway is refused', async () => {
    const other = await post('/api/deposits', { txid: d.txs.fund, items: items.slice(0, 1) });
    expect(other.status).toBe(402);
    expect(other.body.error).toMatch(/NO_OUTPUT_TO_KEY|MEMO_MISMATCH/);
  });
});

describe('per-call payments (real proofs, verified off-chain by the gateway)', () => {
  it('a proof of a credited note pays; replaying it is refused', async () => {
    const tree = await Tree.build(gw.state.leaves.map(BigInt));
    const c = await challenge();
    const p = await provePayment(notes[0], notes[0].index, tree, BigInt(c.payTo), BigInt(c.requiredAmount), BigInt(c.contextHash));
    expect((await pay({ nonce: c.nonce, ...p })).status).toBe(200);
    const c2 = await challenge();
    expect((await pay({ nonce: c2.nonce, proof: p.proof, signals: { ...p.signals, context_hash: c2.contextHash } })).body.reason).toBe('NULLIFIER_SPENT');
  });

  it('a tampered nullifier, an unknown root, another request’s proof and an unknown nonce are refused', async () => {
    const tree = await Tree.build(gw.state.leaves.map(BigInt));
    const c = await challenge();
    const p = await provePayment(notes[1], notes[1].index, tree, BigInt(c.payTo), BigInt(c.requiredAmount), BigInt(c.contextHash));
    expect((await pay({ nonce: c.nonce, proof: p.proof, signals: { ...p.signals, nullifier: (BigInt(p.signals.nullifier) + 1n).toString() } })).body.reason).toBe('BAD_PROOF');
    const c2 = await challenge();
    expect((await pay({ nonce: c2.nonce, ...p })).body.reason).toBe('NOT_BOUND_TO_CHALLENGE');
    expect((await pay({ nonce: c.nonce, proof: p.proof, signals: { ...p.signals, merkle_root: '7' } })).body.reason).toBe('UNKNOWN_ROOT');
    expect((await pay({ nonce: 'never-issued', ...p })).body.reason).toBe('UNKNOWN_CHALLENGE');
    expect((await pay({ nonce: c.nonce, ...p })).status).toBe(200);
  });
});

describe('the live run’s anchor (testnet)', () => {
  it('the anchor memo is on-chain and equals the root and nullifier set recomputed from published data', async () => {
    const callNullifiers = (d.calls as { nullifier: string }[]).map((c) => c.nullifier);
    const fixtureNullifiers = await Promise.all(notes.map(async (n) => (await nullifierOf(n)).toString()));
    const all = [...callNullifiers, ...fixtureNullifiers];
    expect(new Set(all).size).toBe(22);
    expect(nullifierSetHash(all)).toBe(d.anchor.nullifierHash);
    const memo = anchorMemo(22, d.gateway.root, 22, d.anchor.nullifierHash);
    expect(memo).toBe(d.anchor.memo);
    expect((await scan(d.wallets.anchor.uivk, d.anchor.txid, 1, memo)).ok).toBe(true);
  });
});
