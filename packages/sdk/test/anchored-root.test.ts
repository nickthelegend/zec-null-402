// "Prove only against anchored roots" (docs/JUDGE-2026-10-21.md, bold idea). A real gateway credits the
// real published deposit (testnet) and adopts the run's real anchor (a0992237…, read with the anchor
// address's published viewing key). Dishonest gateways are real HTTP servers in front of it that try to
// tell this client apart from others by the root it proves against. The client reads the anchor from
// lightwalletd itself; each refusal happens before a proof is made, so no nullifier is burned.
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leafFromItem, nullifierOf, Tree } from '@z402/circuits';
import { Gateway, readAnchor, serveGateway } from '@z402/gateway';
import { AnchorRefusedError, DEFAULT_MAX_ANCHOR_AGE_BLOCKS, Z402Client, type ClientOptions } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'z402-anchored-'));
const servers: Server[] = [];
const gateways: Gateway[] = [];
afterAll(() => {
  servers.forEach((s) => s.close());
  gateways.forEach((g) => g.close());
});
const listen = async (s: Server) => {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

/** A real gateway that credited the published deposit; `anchored` also adopts the published anchor. */
async function gateway(anchored: boolean) {
  const gw = new Gateway({ statePath: join(mkdtempSync(join(dir, 'gw-')), 'state.db'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': 10n }, content: (p) => ({ served: p }), anchorUivk: d.wallets.anchor.uivk });
  gateways.push(gw);
  await gw.claim(d.deposit.txid, d.deposit.items);
  if (anchored) await gw.adoptAnchor(d.anchor.txid);
  return { gw, base: await listen(serveGateway(gw)) };
}

type Challenge = { root: string; anchor: { txid: string; leaves: number; root: string; height: number } | null };
/**
 * A dishonest gateway in front of a real one. `leaves` rewrites the leaf list this client is shown,
 * `challenge` rewrites the 402 challenge. Payments are passed through; `seen` records the root of
 * every proof it receives (the thing a partitioning gateway looks at).
 */
async function dishonest(upstream: string, leaves: (l: string[]) => Promise<string[]> | string[], challenge: (c: Challenge, myLeaves: string[]) => Promise<Challenge> | Challenge) {
  const seen: string[] = [];
  const base = await listen(
    createServer(async (req, res) => {
      const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const up = async (path: string, headers: Record<string, string> = {}) => {
        const r = await fetch(upstream + path, { headers });
        return { status: r.status, body: (await r.json()) as Record<string, unknown> };
      };
      if (req.url === '/api/info') return send(200, (await up('/api/info')).body);
      const mine = await leaves(((await up('/api/leaves')).body as { leaves: string[] }).leaves);
      if (req.url === '/api/leaves') return send(200, { leaves: mine, root: (await Tree.build(mine.map(BigInt))).root.toString() });
      const header = req.headers['x-payment'];
      if (typeof header === 'string') {
        seen.push(JSON.parse(Buffer.from(header, 'base64').toString()).signals.merkle_root);
        const r = await up(req.url!, { 'x-payment': header });
        return send(r.status, r.body);
      }
      const r = await up(req.url!);
      const accepts = await Promise.all((r.body.accepts as Challenge[]).map((c) => challenge(c, mine)));
      return send(r.status, { ...r.body, accepts });
    }),
  );
  return { base, seen };
}

let notesN = 0;
/** A wallet holding the two published fixture notes at their published indices, both unspent. */
async function wallet(gatewayBase: string) {
  const notes = await Promise.all(d.fixtureNotes.map(async (n: Record<string, string>) => ({ ...n, index: Number(n.index), deposit: 'published', spent: false, nullifier: (await nullifierOf({ noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value) })).toString() })));
  const path = join(dir, `notes-${notesN++}.json`);
  writeFileSync(path, JSON.stringify({ type: 'zec-null-402-notes', gateway: gatewayBase, plans: {}, notes }), { mode: 0o600 });
  return path;
}

// The published anchor was mined on Oct 20. The window used here is its age plus 10 blocks; the default
// window (2,880 blocks) refuses it, which a test below shows.
let opts: ClientOptions;
let age = 0;
const extraLeaf = async () => (await leafFromItem({ secretHash: '4242424242', value: '10' })).toString();
const rootOf = async (l: string[]) => (await Tree.build(l.map(BigInt))).root.toString();
const unspent = (path: string) => (JSON.parse(readFileSync(path, 'utf8')).notes as { spent: boolean }[]).filter((n) => !n.spent).length;

beforeAll(async () => {
  const a = await readAnchor(d.wallets.anchor.uivk, d.anchor.txid);
  age = a.tip - a.height!;
  opts = { anchorUivk: d.wallets.anchor.uivk, maxAnchorAgeBlocks: age + 10 };
}, 60_000);

describe('the client proves only against a root it has read in an on-chain anchor', () => {
  it('an anchored root pays, and the proof carries exactly the published anchored root', async () => {
    const g = await gateway(true);
    const proxy = await dishonest(g.base, (l) => l, (c) => c);
    const c = new Z402Client(proxy.base, await wallet(proxy.base), opts);
    const r = await c.pay(`${proxy.base}/api/quote`);
    expect(r.status).toBe(200);
    expect(proxy.seen).toEqual([d.gateway.root]);
    expect(r.anchor).toMatchObject({ txid: d.anchor.txid, leaves: 22, root: d.gateway.root });
  }, 120_000);

  it('a gateway with no anchor: UNANCHORED_ROOT before any proof, nothing sent, the note stays unspent', async () => {
    const g = await gateway(false);
    const proxy = await dishonest(g.base, (l) => l, (c) => c);
    const notes = await wallet(proxy.base);
    await expect(new Z402Client(proxy.base, notes, opts).pay(`${proxy.base}/api/quote`)).rejects.toThrow(/UNANCHORED_ROOT/);
    expect(proxy.seen).toEqual([]);
    expect(Object.keys(g.gw.state.nullifiers)).toHaveLength(0);
    expect(unspent(notes)).toBe(2);
  }, 120_000);
});

describe('a gateway that serves this client its own root is detected and refused', () => {
  let g: Awaited<ReturnType<typeof gateway>>;
  beforeAll(async () => {
    g = await gateway(true);
  }, 120_000);

  it('its own leaf list and root, offered with no anchor: UNANCHORED_ROOT, the gateway never sees a proof', async () => {
    const extra = await extraLeaf();
    const proxy = await dishonest(g.base, (l) => [...l, extra], async (c, mine) => ({ ...c, root: await rootOf(mine), anchor: null }));
    await expect(new Z402Client(proxy.base, await wallet(proxy.base), opts).pay(`${proxy.base}/api/quote`)).rejects.toThrow(/UNANCHORED_ROOT/);
    expect(proxy.seen).toEqual([]);
  }, 120_000);

  it('its own root passed off as the published anchor: the anchor tx has no memo for that root (ANCHOR_MISMATCH)', async () => {
    const extra = await extraLeaf();
    const proxy = await dishonest(g.base, (l) => [...l, extra], async (c, mine) => {
      const root = await rootOf(mine);
      return { ...c, root, anchor: { ...c.anchor!, leaves: mine.length, root } };
    });
    const err = await new Z402Client(proxy.base, await wallet(proxy.base), opts).pay(`${proxy.base}/api/quote`).catch((e) => e);
    expect(err).toBeInstanceOf(AnchorRefusedError);
    expect(err.code).toBe('ANCHOR_MISMATCH');
    expect(proxy.seen).toEqual([]);
  }, 120_000);

  it('the real anchor, but a leaf inside the anchored range rewritten for this client: LEAVES_NOT_ANCHORED', async () => {
    const extra = await extraLeaf();
    const proxy = await dishonest(g.base, (l) => l.map((x, i) => (i === 5 ? extra : x)), (c) => c);
    await expect(new Z402Client(proxy.base, await wallet(proxy.base), opts).pay(`${proxy.base}/api/quote`)).rejects.toThrow(/LEAVES_NOT_ANCHORED/);
    expect(proxy.seen).toEqual([]);
  }, 120_000);

  it('leaves added after the anchor for this client only never reach the proof: it proves against the anchored root', async () => {
    const extra = await extraLeaf();
    const proxy = await dishonest(g.base, (l) => [...l, extra], (c) => c);
    const r = await new Z402Client(proxy.base, await wallet(proxy.base), opts).pay(`${proxy.base}/api/quote`);
    expect(proxy.seen).toEqual([d.gateway.root]);
    expect(r.status).toBe(200);
  }, 120_000);
});

describe('anchor freshness and history', () => {
  let g: Awaited<ReturnType<typeof gateway>>;
  beforeAll(async () => {
    g = await gateway(true);
  }, 120_000);

  it('an anchor older than the configured window: ANCHOR_TOO_OLD (and the default 2,880-block window refuses the Oct 20 anchor)', async () => {
    await expect(new Z402Client(g.base, await wallet(g.base), { ...opts, maxAnchorAgeBlocks: age - 10 }).pay(`${g.base}/api/quote`)).rejects.toThrow(/ANCHOR_TOO_OLD.*accepts at most/);
    expect(age).toBeGreaterThan(DEFAULT_MAX_ANCHOR_AGE_BLOCKS);
    await expect(new Z402Client(g.base, await wallet(g.base), { anchorUivk: d.wallets.anchor.uivk }).pay(`${g.base}/api/quote`)).rejects.toThrow(/ANCHOR_TOO_OLD/);
    expect(Object.keys(g.gw.state.nullifiers)).toHaveLength(0);
  }, 120_000);

  it('a gateway whose anchored history does not extend the anchor this client accepted before: ANCHOR_FORK; an older anchor: ANCHOR_ROLLBACK', async () => {
    const forked = await wallet(g.base);
    const f = JSON.parse(readFileSync(forked, 'utf8'));
    writeFileSync(forked, JSON.stringify({ ...f, anchor: { txid: 'f'.repeat(64), leaves: 21, root: '7', height: 4_522_000 } }), { mode: 0o600 });
    await expect(new Z402Client(g.base, forked, opts).pay(`${g.base}/api/quote`)).rejects.toThrow(/ANCHOR_FORK/);
    const newer = await wallet(g.base);
    writeFileSync(newer, JSON.stringify({ ...f, anchor: { txid: 'e'.repeat(64), leaves: 22, root: d.gateway.root, height: 99_000_000 } }), { mode: 0o600 });
    await expect(new Z402Client(g.base, newer, opts).pay(`${g.base}/api/quote`)).rejects.toThrow(/ANCHOR_ROLLBACK/);
    expect(Object.keys(g.gw.state.nullifiers)).toHaveLength(0);
  }, 120_000);

  it('without the anchor viewing key the client does not prove: Setup required', async () => {
    const saved = process.env.Z402_ANCHOR_UIVK;
    delete process.env.Z402_ANCHOR_UIVK;
    try {
      await expect(new Z402Client(g.base, await wallet(g.base)).pay(`${g.base}/api/quote`)).rejects.toThrow('Setup required: Z402_ANCHOR_UIVK');
    } finally {
      if (saved !== undefined) process.env.Z402_ANCHOR_UIVK = saved;
    }
  }, 60_000);
});
