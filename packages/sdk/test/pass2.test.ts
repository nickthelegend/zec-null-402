// The Oct 22 live run (deployments/testnet-pass2.json), re-checked from published data on Zcash testnet:
// its anchors are on-chain and signed with the published anchor key, and the competing anchor the operator
// sent at the end makes a client refuse the deployment. A fresh gateway is rebuilt from the run's two real
// deposits (its viewing key checks them) and adopts the run's newest honest anchor.
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

  it('a client of a gateway rebuilt from the run refuses once the competing signed root is in its window: ANCHOR_COMPETING, nothing proven', async () => {
    const gw = new Gateway({ statePath: join(dir, 'state.db'), depositUa: p.wallets.gateway.address, depositUivk: p.wallets.gateway.uivk, unitZat: 1000, prices: { '/api/quote': 10n }, content: (x) => ({ served: x }), anchorUivk: p.wallets.anchor.uivk });
    for (const d of p.deposits) await gw.claim(d.txid, d.items);
    expect(await gw.root()).toBe(p.gateway.root);
    const newest = (p.anchors as A[]).reduce((b, a) => (a.height > b.height ? a : b));
    await gw.adoptAnchor(newest.txid);
    const s = serveGateway(gw);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    closers.push(() => (s.close(), gw.close()));
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    // the window reaches back to the newest honest anchor, so it holds the competing one mined after it
    const tip = (await readAnchor(p.wallets.anchor.uivk, newest.txid)).tip;
    expect(p.competing.height).toBeGreaterThanOrEqual(newest.height);
    const notes = join(dir, 'notes.json');
    writeFileSync(notes, JSON.stringify({ type: 'zec-null-402-notes', gateway: base, plans: {}, notes: [{ ...p.fixtureNote, deposit: p.deposits[1].memo.slice(5), spent: false }] }), { mode: 0o600 });
    const err = await new Z402Client(base, notes, { anchorUivk: p.wallets.anchor.uivk, anchorPubkey: p.protocol.anchorPubkey, maxAnchorAgeBlocks: tip - newest.height + 10 }).pay(`${base}/api/quote`).catch((e) => e);
    expect(err).toBeInstanceOf(AnchorRefusedError);
    expect(err.code).toBe('ANCHOR_COMPETING');
    expect(err.message).toContain(p.competing.txid.slice(0, 12));
    expect(Object.keys(gw.state.nullifiers)).toHaveLength(0);
  }, 180_000);
});
