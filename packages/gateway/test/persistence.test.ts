// Gateway state across restarts and across two gateway processes on one database. Each gateway credits
// the real published deposit (Zcash testnet, the gateway's viewing key) and is paid with real Groth16
// proofs of the two published fixture notes.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as netServer, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { provePayment, Tree, type Note } from '@z402/circuits';
import { Gateway, scanBinary, serveGateway } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const items = d.deposit.items as { secretHash: string; value: string }[];
const notes: (Note & { index: number })[] = d.fixtureNotes.map((n: Record<string, string>) => ({ noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value), index: Number(n.index) }));
const cleanup: (() => void)[] = [];
afterAll(() => cleanup.reverse().forEach((c) => c()));

const options = (statePath: string) => ({ statePath, depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': BigInt(d.priceUnits) }, content: (p: string) => ({ served: p }) });

async function start(statePath: string) {
  const gw = new Gateway(options(statePath));
  const s: Server = serveGateway(gw);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const stop = () => {
    s.close();
    gw.close();
  };
  cleanup.push(() => s.listening && stop());
  return { gw, base, stop };
}
type Ch = { payTo: string; requiredAmount: string; contextHash: string; nonce: string };
const challenge = async (base: string) => ((await (await fetch(`${base}/api/quote`)).json()) as { accepts: Ch[] }).accepts[0];
const prove = async (leaves: string[], n: Note & { index: number }, c: Ch) => {
  const p = await provePayment(n, n.index, await Tree.build(leaves.map(BigInt)), BigInt(c.payTo), BigInt(c.requiredAmount), BigInt(c.contextHash));
  return { nonce: c.nonce, proof: p.proof, signals: p.signals };
};
const pay = (base: string, p: object) => fetch(`${base}/api/quote`, { headers: { 'x-payment': Buffer.from(JSON.stringify(p)).toString('base64') } }).then(async (r) => ({ status: r.status, body: (await r.json()) as { reason?: string } }));

describe('a restart keeps the gateway state', () => {
  it('a challenge issued before a restart is still payable after it', async () => {
    const db = join(mkdtempSync(join(tmpdir(), 'z402-rs-')), 'state.db');
    const a = await start(db);
    await a.gw.claim(d.deposit.txid, items);
    const c = await challenge(a.base);
    const p = await prove(a.gw.state.leaves, notes[0], c);
    a.stop();
    const b = await start(db);
    expect((await pay(b.base, p)).status).toBe(200);
  }, 180_000);

  it('nullifiers, deposits and the root survive a restart: the spent note stays spent, the deposit stays claimed', async () => {
    const db = join(mkdtempSync(join(tmpdir(), 'z402-rs-')), 'state.db');
    const a = await start(db);
    await a.gw.claim(d.deposit.txid, items);
    expect((await pay(a.base, await prove(a.gw.state.leaves, notes[1], await challenge(a.base)))).status).toBe(200);
    const root = await a.gw.root();
    a.stop();
    const b = await start(db);
    expect(await b.gw.root()).toBe(root);
    expect(Object.keys(b.gw.state.nullifiers)).toHaveLength(1);
    expect((await pay(b.base, await prove(b.gw.state.leaves, notes[1], await challenge(b.base)))).body.reason).toBe('NULLIFIER_SPENT');
    await expect(b.gw.claim(d.deposit.txid, items)).rejects.toThrow(/already claimed/);
  }, 180_000);
});

const freePort = () =>
  new Promise<number>((r) => {
    const s = netServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => r(port));
    });
  });

describe('two gateway processes on one database', () => {
  it('one note proven twice, one proof sent to each process at once, pays one call', async () => {
    const db = join(mkdtempSync(join(tmpdir(), 'z402-2p-')), 'state.db');
    const a = await start(db);
    await a.gw.claim(d.deposit.txid, items);
    // a second, separate gateway process (src/serve.ts) on the same state
    const port = await freePort();
    const child: ChildProcess = spawn(resolve(__dirname, '../node_modules/.bin/tsx'), [resolve(__dirname, '../src/serve.ts')], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', Z402_SCAN_BIN: scanBinary(), Z402_STATE: db, Z402_DEPOSIT_UA: d.wallets.gateway.address, Z402_DEPOSIT_UIVK: d.wallets.gateway.uivk, Z402_UNIT_ZAT: String(d.unitZat), Z402_PRICE_UNITS: String(d.priceUnits), Z402_PORT: String(port) },
      stdio: 'ignore',
    });
    cleanup.push(() => child.kill());
    const other = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
      if (await fetch(`${other}/api/info`).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(((await (await fetch(`${other}/api/info`)).json()) as { leaves: number }).leaves).toBe(22);
    const leaves = a.gw.state.leaves;
    const [p1, p2] = [await prove(leaves, notes[0], await challenge(a.base)), await prove(leaves, notes[0], await challenge(other))];
    const rs = await Promise.all([pay(a.base, p1), pay(other, p2)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 402]);
    expect(rs.find((r) => r.status === 402)?.body.reason).toBe('NULLIFIER_SPENT');
    expect(Object.keys(a.gw.state.nullifiers)).toHaveLength(1);
  }, 180_000);
});

describe('state from before the SQLite store', () => {
  it('a JSON state is imported once into a new database; a JSON file given as the database is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'z402-legacy-'));
    const a = await start(join(dir, 'old.db'));
    await a.gw.claim(d.deposit.txid, items);
    expect((await pay(a.base, await prove(a.gw.state.leaves, notes[0], await challenge(a.base)))).status).toBe(200);
    const { anchors: _a, ...legacy } = a.gw.state;
    a.stop();
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...legacy, anchors: [] }));
    expect(() => new Gateway(options(join(dir, 'state.json')))).toThrow(/Setup required: Z402_STATE.*JSON state file/);
    const g = new Gateway({ ...options(join(dir, 'new.db')), legacyJsonState: join(dir, 'state.json') });
    cleanup.push(() => g.close());
    expect(g.state.leaves).toEqual(legacy.leaves);
    expect(Object.keys(g.state.nullifiers)).toEqual(Object.keys(legacy.nullifiers));
    expect(await g.root()).toBe(d.gateway.root);
  }, 180_000);
});
