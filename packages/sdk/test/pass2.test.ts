// The Oct 22 live run (deployments/testnet-pass2.json), re-checked from published data on Zcash testnet:
// its anchors are on-chain and signed with the published anchor key, and the competing anchor the operator
// sent at the end makes a client refuse the deployment. A fresh gateway is rebuilt from the run's two real
// deposits (its viewing key checks them) and adopts the run's newest honest anchor. Clients here replay the
// run at a pinned block height (replayAtHeight), so the scan range is fixed and later memos cannot change it.
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Gateway, readAnchor, serveGateway, verifyAnchorSignature } from '@z402/gateway';
import { AnchorRefusedError, Z402Client } from '../src/index.js';

const p = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet-pass2.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'z402-pass2-'));
const closers: (() => void)[] = [];
afterAll(() => closers.forEach((c) => c()));
type A = { txid: string; leaves: number; root: string; height: number };
const newest = (p.anchors as A[]).reduce((b, a) => (a.height > b.height ? a : b));
let n = 0;

/** A fresh gateway rebuilt from the run's two real deposits (its viewing key checks them), adopting `adopt` (default: the newest honest anchor). */
async function rebuilt(adopt: A[] = [newest]) {
  const gw = new Gateway({ statePath: join(dir, `state-${n++}.db`), depositUa: p.wallets.gateway.address, depositUivk: p.wallets.gateway.uivk, unitZat: 1000, prices: { '/api/quote': 10n }, content: (x) => ({ served: x }), anchorUivk: p.wallets.anchor.uivk });
  for (const d of p.deposits) await gw.claim(d.txid, d.items);
  expect(await gw.root()).toBe(p.gateway.root);
  for (const a of adopt) await gw.adoptAnchor(a.txid);
  const s = serveGateway(gw);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  closers.push(() => (s.close(), gw.close()));
  return { gw, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

/** A notes file holding the run's one published fixture note (leaf 5), unspent: the rebuilt gateway has burned nothing. */
async function fixtureNotes(base: string) {
  const notes = join(dir, `notes-${n++}.json`);
  writeFileSync(notes, JSON.stringify({ type: 'zec-null-402-notes', gateway: base, plans: {}, notes: [{ ...p.fixtureNote, deposit: p.deposits[1].memo.slice(5), spent: false }] }), { mode: 0o600 });
  return notes;
}

/** A proxy in front of `upstream` whose 402 challenges name `named` instead of the anchor the gateway names (the run's probe). */
async function naming(upstream: string, named: A) {
  const s = createServer(async (req, res) => {
    const header = req.headers['x-payment'];
    const r = await fetch(upstream + req.url, typeof header === 'string' ? { headers: { 'x-payment': header } } : {});
    const body = (await r.json()) as { accepts?: Record<string, unknown>[] };
    if (r.status === 402 && body.accepts) body.accepts = body.accepts.map((c) => ({ ...c, root: named.root, anchor: { txid: named.txid, leaves: named.leaves, root: named.root, height: named.height } }));
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  closers.push(() => s.close());
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

describe('pass 2 (Oct 22) on testnet', () => {
  it('every anchor of the run, and the competing one, is on-chain with a memo signed by the published anchor key', async () => {
    for (const a of [...(p.anchors as A[]), p.competing as A]) {
      const r = await readAnchor(p.wallets.anchor.uivk, a.txid);
      expect(r.height, a.txid).toBe(a.height);
      const m = r.anchors.find((x) => x.root === a.root && x.leaves === a.leaves);
      expect(m, a.txid).toBeDefined();
      expect(verifyAnchorSignature(p.protocol.anchorPubkey, m!), a.txid).toBe(true);
    }
  }, 120_000);

  it('replayed as of block 4,529,604 (after its newest honest anchor, before the competing one), a pinned-key client with the default 2,880-block window pays: HTTP 200 against the newest signed anchor', async () => {
    const { gw, base } = await rebuilt();
    const at = p.competing.height - 2;
    expect(at).toBeGreaterThan(newest.height);
    const c = new Z402Client(base, await fixtureNotes(base), { anchorUivk: p.wallets.anchor.uivk, anchorPubkey: p.protocol.anchorPubkey, replayAtHeight: at });
    expect(c.maxAnchorAgeBlocks).toBe(2880);
    // the replay window is the 2,881 blocks ending at `at`: the four honest anchors, not the competing one
    const w = await c.windowAnchors();
    expect(w.tip).toBe(at);
    expect(w.anchors.map((a) => a.txid).sort()).toEqual((p.anchors as A[]).map((a) => a.txid).sort());
    const r = await c.pay(`${base}/api/quote`);
    expect(r.status).toBe(200);
    expect(r.anchor).toMatchObject({ txid: newest.txid, leaves: 6, root: p.gateway.root, height: newest.height });
    expect(r.nullifier).toBe(p.fixtureNote.nullifier);
    expect(Object.keys(gw.state.nullifiers)).toEqual([p.fixtureNote.nullifier]);
  }, 180_000);

  it('after it has accepted the newest anchor, a gateway that still names an older anchor of the same history is paid again (no ANCHOR_ROLLBACK): the client proves against the newest in its window each time', async () => {
    const oldest = (p.anchors as A[]).reduce((b, a) => (a.height < b.height ? a : b));
    expect(oldest.txid).toBe(p.probe.named.txid);
    const at = p.competing.height - 2;
    const opts = { anchorUivk: p.wallets.anchor.uivk, anchorPubkey: p.protocol.anchorPubkey, replayAtHeight: at };
    const g1 = await rebuilt(p.anchors as A[]);
    const notes = await fixtureNotes(g1.base);
    const proxy1 = await naming(g1.base, oldest);
    const first = await new Z402Client(proxy1, notes, opts).pay(`${proxy1}/api/quote`);
    expect(first.status).toBe(200);
    expect(first.anchor).toMatchObject({ txid: newest.txid, leaves: 6 });
    expect(JSON.parse(readFileSync(notes, 'utf8')).anchor).toMatchObject({ txid: newest.txid, height: newest.height });
    // the same note again on a second rebuilt gateway (which has burned nothing), still named the older anchor
    const f = JSON.parse(readFileSync(notes, 'utf8'));
    f.notes[0].spent = false;
    writeFileSync(notes, JSON.stringify(f), { mode: 0o600 });
    const g2 = await rebuilt(p.anchors as A[]);
    const proxy2 = await naming(g2.base, oldest);
    const again = await new Z402Client(proxy2, notes, opts).pay(`${proxy2}/api/quote`).catch((e) => e);
    expect(again).not.toBeInstanceOf(Error);
    expect(again.status).toBe(200);
    expect(again.anchor).toMatchObject({ txid: newest.txid, leaves: 6 });
    expect(Object.keys(g2.gw.state.nullifiers)).toEqual([p.fixtureNote.nullifier]);
  }, 240_000);

  it('a client of a gateway rebuilt from the run refuses once the competing signed root is in its window: ANCHOR_COMPETING, nothing proven', async () => {
    const { gw, base } = await rebuilt();
    expect(p.competing.height).toBeGreaterThanOrEqual(newest.height);
    // replayed at the record's last block: the window holds the competing anchor mined after the newest honest one
    const err = await new Z402Client(base, await fixtureNotes(base), { anchorUivk: p.wallets.anchor.uivk, anchorPubkey: p.protocol.anchorPubkey, replayAtHeight: p.tipAtEnd }).pay(`${base}/api/quote`).catch((e) => e);
    expect(err).toBeInstanceOf(AnchorRefusedError);
    expect(err.code).toBe('ANCHOR_COMPETING');
    expect(err.message).toContain(p.competing.txid.slice(0, 12));
    expect(Object.keys(gw.state.nullifiers)).toHaveLength(0);
  }, 180_000);
});
