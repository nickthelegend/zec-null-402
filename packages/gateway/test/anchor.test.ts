// The gateway's side of "prove only against anchored roots": it reads anchors on-chain with the anchor
// address's published viewing key (lightwalletd, testnet), adopts only one that matches its own leaves,
// and tells clients in every challenge which mined anchor to check and prove against.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { anchorMemo, anchorSigner, Gateway, newAnchorSeed, parseAnchorMemo, readAnchor, scanAnchors, scanStats, serveGateway, verifyAnchorSignature, type GatewayOptions } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const items = d.deposit.items as { secretHash: string; value: string }[];
const closers: (() => void)[] = [];
afterAll(() => closers.forEach((c) => c()));

async function fresh(extra: Partial<GatewayOptions> = {}, claim = true) {
  const gw = new Gateway({ statePath: join(mkdtempSync(join(tmpdir(), 'z402-anc-')), 'state.db'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': BigInt(d.priceUnits) }, content: (p) => ({ served: p }), anchorUivk: d.wallets.anchor.uivk, ...extra });
  if (claim) await gw.claim(d.deposit.txid, items);
  const s = serveGateway(gw);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  closers.push(() => s.close());
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const challenge = async () => ((await (await fetch(`${base}/api/quote`)).json()) as { accepts: { root: string; anchor: { txid: string; leaves: number; root: string; height: number } | null }[] }).accepts[0];
  return { gw, base, challenge };
}

describe('anchor memos', () => {
  it('only the exact z402:anchor form parses', () => {
    expect(parseAnchorMemo(d.anchor.memo)).toEqual({ leaves: 22, root: d.gateway.root, nullifiers: 22, nullifierHash: d.anchor.nullifierHash });
    for (const bad of [null, '', `${d.anchor.memo} `, d.anchor.memo.replace(':22:', ':022:'), d.anchor.memo.replace('z402:anchor', 'z402:anchr'), `z402:${d.deposit.memo}`]) expect(parseAnchorMemo(bad)).toBeNull();
  });

  it('the published anchor reads back from lightwalletd with the published anchor viewing key', async () => {
    const a = await readAnchor(d.wallets.anchor.uivk, d.anchor.txid);
    expect(a).toMatchObject({ found: true, height: expect.any(Number), anchors: [{ leaves: 22, root: d.gateway.root, nullifiers: 22, nullifierHash: d.anchor.nullifierHash }] });
    expect(a.tip - a.height!).toBeGreaterThan(0);
    // the deposit tx carries no anchor memo for this key
    expect((await readAnchor(d.wallets.anchor.uivk, d.deposit.txid)).anchors).toEqual([]);
    await expect(readAnchor(d.wallets.anchor.uivk, '--memo')).rejects.toThrow(/64 hex/);
  });
});

describe('signed anchors', () => {
  it('an anchor memo can carry an Ed25519 signature over its fields; only the signer\'s key verifies it, and no field can change', () => {
    const s = anchorSigner(newAnchorSeed());
    const m = { leaves: 22, root: d.gateway.root, nullifiers: 22, nullifierHash: d.anchor.nullifierHash };
    const memo = anchorMemo(m.leaves, m.root, m.nullifiers, m.nullifierHash, s.sign(m));
    expect(memo.length).toBeLessThanOrEqual(512);
    const parsed = parseAnchorMemo(memo)!;
    expect(parsed).toEqual({ ...m, signature: expect.stringMatching(/^[0-9a-f]{128}$/) });
    expect(verifyAnchorSignature(s.publicKey, parsed)).toBe(true);
    expect(verifyAnchorSignature(anchorSigner(newAnchorSeed()).publicKey, parsed)).toBe(false);
    for (const k of ['leaves', 'root', 'nullifiers', 'nullifierHash'] as const) {
      const bad = { ...parsed, [k]: k === 'nullifierHash' ? 'f'.repeat(64) : k === 'root' ? '7' : 23 };
      expect(verifyAnchorSignature(s.publicKey, bad), k).toBe(false);
    }
    // the Oct 20 anchor is unsigned
    expect(verifyAnchorSignature(s.publicKey, parseAnchorMemo(d.anchor.memo)!)).toBe(false);
    expect(() => anchorSigner('not a seed')).toThrow(/^Setup required: Z402_ANCHOR_SIGNING_KEY/);
  });

  it('a gateway with a signing key signs every anchor it sends, and publishes the public key on /api/info', async () => {
    const seed = newAnchorSeed();
    const memos: string[] = [];
    const g = await fresh({ anchorSigningKey: seed, sendAnchor: async (memo) => (memos.push(memo), 'a'.repeat(64)) });
    await g.gw.anchor();
    const info = (await (await fetch(`${g.base}/api/info`)).json()) as { anchorPubkey: string };
    expect(info.anchorPubkey).toBe(anchorSigner(seed).publicKey);
    expect(JSON.stringify(info)).not.toContain(seed);
    expect(verifyAnchorSignature(info.anchorPubkey, parseAnchorMemo(memos[0])!)).toBe(true);
    expect(parseAnchorMemo(memos[0])).toMatchObject({ leaves: 22, root: d.gateway.root, nullifiers: 0 });
  }, 120_000);
});

describe('every anchor sent to the anchor address in a block range', () => {
  it('scanAnchors finds the published anchor by scanning compact blocks with the published anchor key, and nothing in the blocks before it', async () => {
    const a = await readAnchor(d.wallets.anchor.uivk, d.anchor.txid);
    const around = await scanAnchors(d.wallets.anchor.uivk, { from: a.height! - 20, to: a.height! + 20 });
    expect(around.anchors).toEqual([{ txid: d.anchor.txid, height: a.height, leaves: 22, root: d.gateway.root, nullifiers: 22, nullifierHash: d.anchor.nullifierHash }]);
    expect(around.blocks).toBe(41);
    expect((await scanAnchors(d.wallets.anchor.uivk, { from: a.height! - 200, to: a.height! - 1 })).anchors).toEqual([]);
    const last = await scanAnchors(d.wallets.anchor.uivk, { last: a.tip - a.height! + 5 });
    expect(last.anchors.map((x) => x.txid)).toContain(d.anchor.txid);
    expect(last.to).toBeGreaterThanOrEqual(a.tip);
    expect(scanStats.spawns).toBeGreaterThan(0);
  }, 120_000);
});

describe('challenges name the anchor to prove against', () => {
  it('without an anchor the challenge says so (anchor: null)', async () => {
    const g = await fresh();
    expect(await g.challenge()).toMatchObject({ root: d.gateway.root, anchor: null });
  }, 120_000);

  it('a gateway whose leaves match adopts the published anchor; challenges then carry it and its root', async () => {
    const g = await fresh();
    const a = await g.gw.adoptAnchor(d.anchor.txid);
    expect(a).toMatchObject({ txid: d.anchor.txid, leaves: 22, root: d.gateway.root, height: expect.any(Number) });
    expect(await g.challenge()).toMatchObject({ root: d.gateway.root, anchor: { txid: d.anchor.txid, leaves: 22, root: d.gateway.root, height: a.height } });
    expect(g.gw.latestAnchor()?.txid).toBe(d.anchor.txid);
  }, 120_000);

  it('an anchor that does not match the gateway’s leaves, or a tx without an anchor memo, is not adopted', async () => {
    const empty = await fresh({}, false);
    await expect(empty.gw.adoptAnchor(d.anchor.txid)).rejects.toThrow(/does not match this gateway's leaves/);
    const g = await fresh();
    await expect(g.gw.adoptAnchor(d.deposit.txid)).rejects.toThrow(/no z402 anchor memo/);
    expect(g.gw.state.anchors).toEqual([]);
  }, 120_000);

  it('an anchor recorded before it was seen mined is offered to clients only after confirmAnchors reads it on-chain', async () => {
    // the Oct 20 run's state as its JSON file had it: the anchor recorded at send time, no height
    const g = await fresh();
    const dir = mkdtempSync(join(tmpdir(), 'z402-anc-legacy-'));
    const { anchor: a } = d;
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...g.gw.state, anchors: [{ txid: a.txid, leaves: a.leaves, root: a.root, nullifiers: a.nullifiers, nullifierHash: a.nullifierHash, at: a.at }] }));
    const gw = new Gateway({ ...g.gw.o, statePath: join(dir, 'state.db'), legacyJsonState: join(dir, 'state.json') });
    closers.push(() => gw.close());
    expect(gw.state.anchors).toMatchObject([{ txid: a.txid, height: null }]);
    expect(gw.latestAnchor()).toBeNull();
    expect(await gw.confirmAnchors()).toBe(1);
    expect(gw.latestAnchor()).toMatchObject({ txid: a.txid, root: d.gateway.root, height: expect.any(Number) });
  }, 120_000);

  it('reading anchors needs the anchor viewing key: Setup required', async () => {
    const g = await fresh({ anchorUivk: undefined }, false);
    await expect(g.gw.adoptAnchor(d.anchor.txid)).rejects.toThrow('Setup required: Z402_ANCHOR_UIVK');
  });
});
