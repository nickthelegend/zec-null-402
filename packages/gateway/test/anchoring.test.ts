// Anchoring liveness and serialization. Clients pay only against a recent mined anchor, so a gateway that
// stops anchoring stops being payable. Each gateway here is real: it credits the real published deposit
// (testnet viewing key), reads the run's anchor and the chain tip from lightwalletd, and anchors through a
// sendAnchor callback that records what it is asked to send (no transaction leaves this test).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { anchorMemo, Gateway, nullifierSetHash, type GatewayOptions } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const items = d.deposit.items as { secretHash: string; value: string }[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gateways: Gateway[] = [];
afterAll(() => gateways.forEach((g) => g.close()));

/** Records every send; `fail` sends throw first; each send takes `ms`. Tracks how many run at once. */
function recorder(o: { fail?: number; ms?: number } = {}) {
  const r = { memos: [] as string[], attempts: 0, live: 0, max: 0, fail: o.fail ?? 0 };
  const sendAnchor = async (memo: string) => {
    r.attempts++;
    r.live++;
    r.max = Math.max(r.max, r.live);
    try {
      await sleep(o.ms ?? 50);
      if (r.fail > 0) {
        r.fail--;
        throw new Error('zingo-cli quicksend failed: caused by: Insufficient balance (have 0, need 20000 including fee)');
      }
      r.memos.push(memo);
      return randomBytes(32).toString('hex');
    } finally {
      r.live--;
    }
  };
  return { r, sendAnchor };
}

const base = (extra: Partial<GatewayOptions>): GatewayOptions => ({ statePath: join(mkdtempSync(join(tmpdir(), 'z402-anchoring-')), 'state.db'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': BigInt(d.priceUnits) }, content: (p) => ({ served: p }), anchorUivk: d.wallets.anchor.uivk, ...extra });

/** A gateway holding exactly the Oct 20 run's end state (22 leaves, the 22 published nullifiers) and its mined anchor. */
async function oct20(extra: Partial<GatewayOptions>) {
  const fresh = new Gateway(base({}));
  gateways.push(fresh);
  await fresh.claim(d.deposit.txid, items);
  const nullifiers = [...(d.calls as { nullifier: string }[]).map((c) => c.nullifier), ...d.fixtureNullifiers];
  const dir = mkdtempSync(join(tmpdir(), 'z402-anchoring-oct20-'));
  const a = d.anchor;
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...fresh.state, nullifiers: Object.fromEntries(nullifiers.map((n: string) => [n, { at: a.at, resource: '/api/quote' }])), anchors: [{ txid: a.txid, leaves: a.leaves, root: a.root, nullifiers: a.nullifiers, nullifierHash: a.nullifierHash, at: a.at }] }));
  const gw = new Gateway({ ...base(extra), statePath: join(dir, 'state.db'), legacyJsonState: join(dir, 'state.json') });
  gateways.push(gw);
  expect(await gw.confirmAnchors()).toBe(1);
  expect(nullifierSetHash(Object.keys(gw.state.nullifiers))).toBe(a.nullifierHash);
  return gw;
}

describe('one anchor in flight at a time', () => {
  it('three anchor() calls at once: never two sends at once, at most one follow-up, every send recorded', async () => {
    const { r, sendAnchor } = recorder({ ms: 200 });
    const gw = new Gateway(base({ sendAnchor }));
    gateways.push(gw);
    await gw.claim(d.deposit.txid, items);
    const as = await Promise.all([gw.anchor(), gw.anchor(), gw.anchor()]);
    expect(r.max).toBe(1);
    expect(r.attempts).toBeGreaterThanOrEqual(1);
    expect(r.attempts).toBeLessThanOrEqual(2);
    expect(gw.state.anchors).toHaveLength(r.attempts);
    for (const a of as) expect(a).toMatchObject({ leaves: 22, root: d.gateway.root, nullifiers: 0 });
  }, 120_000);

  it('a sent anchor that cannot be recorded is reported with its txid, so it can be adopted', async () => {
    const txid = randomBytes(32).toString('hex');
    const gw = new Gateway(base({ sendAnchor: async () => txid }));
    gateways.push(gw);
    await gw.claim(d.deposit.txid, items);
    await gw.anchor();
    // the same txid again: the anchors table refuses it, and the error names the tx that went out
    await expect(gw.anchor()).rejects.toThrow(new RegExp(`anchor tx ${txid} was sent but not recorded.*adoptAnchor`));
  }, 120_000);
});

describe('the gateway keeps anchoring on its own', () => {
  it('an anchor older than Z402_ANCHOR_EVERY_BLOCKS is refreshed within one check, with the same state', async () => {
    const { r, sendAnchor } = recorder();
    const gw = await oct20({ sendAnchor, autoAnchor: true, anchorCheckMs: 100 });
    expect(await gw.anchorDue()).toMatch(/blocks old/);
    gw.startAnchoring();
    for (let i = 0; i < 100 && r.memos.length === 0; i++) await sleep(100);
    expect(r.memos).toEqual([anchorMemo(22, d.gateway.root, 22, d.anchor.nullifierHash)]);
    await sleep(500);
    expect(r.max).toBe(1);
    // the new anchor is pending (not mined): no second one while it waits
    expect(r.attempts).toBe(1);
  }, 120_000);

  it('a fresh anchor that covers the state: nothing is sent', async () => {
    const { r, sendAnchor } = recorder();
    const gw = await oct20({ sendAnchor, autoAnchor: true, anchorCheckMs: 100, anchorEveryBlocks: 10_000_000 });
    expect(await gw.anchorDue()).toBeNull();
    gw.startAnchoring();
    await sleep(800);
    expect(r.attempts).toBe(0);
  }, 120_000);

  it('a failed anchor send (after a credited deposit) is retried with backoff until it goes out, one at a time', async () => {
    const { r, sendAnchor } = recorder({ fail: 2 });
    const gw = new Gateway(base({ sendAnchor, autoAnchor: true, anchorRetryMs: 100 }));
    gateways.push(gw);
    await gw.claim(d.deposit.txid, items);
    for (let i = 0; i < 100 && r.memos.length === 0; i++) await sleep(100);
    expect(r.attempts).toBe(3);
    expect(r.max).toBe(1);
    expect(r.memos).toEqual([anchorMemo(22, d.gateway.root, 0, nullifierSetHash([]))]);
    expect(gw.state.anchors).toHaveLength(1);
  }, 120_000);

  it('paid calls since the last anchor make it due: the spent count is anchored too', async () => {
    const { sendAnchor } = recorder();
    const gw = await oct20({ sendAnchor, anchorEveryBlocks: 10_000_000 });
    gw.db.prepare('DELETE FROM nullifiers WHERE nullifier = ?').run(d.fixtureNullifiers[0]);
    expect(await gw.anchorDue()).toMatch(/spent count changed/);
  }, 120_000);
});
