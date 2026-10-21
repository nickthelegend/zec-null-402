// The gateway's side of "prove only against anchored roots": it reads anchors on-chain with the anchor
// address's published viewing key (lightwalletd, testnet), adopts only one that matches its own leaves,
// and tells clients in every challenge which mined anchor to check and prove against.
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Gateway, parseAnchorMemo, readAnchor, serveGateway, type GatewayOptions } from '../src/index.js';

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

  it('reading anchors needs the anchor viewing key: Setup required', async () => {
    const g = await fresh({ anchorUivk: undefined }, false);
    await expect(g.gw.adoptAnchor(d.anchor.txid)).rejects.toThrow('Setup required: Z402_ANCHOR_UIVK');
  });
});
