// The notes file holds note secrets; losing a write after a deposit was sent loses those funds. Here a
// real gateway credits the real published deposit (testnet viewing-key scan, which takes seconds) while
// other calls change the same notes file: in this process through a second client, and from another
// process. Then two payments run at once against the run's real anchor and must spend two different notes.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitmentOf, nullifierOf } from '@z402/circuits';
import { Gateway, readAnchor, serveGateway } from '@z402/gateway';
import { Z402Client, type ClientOptions } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'z402-lock-'));
const items = d.deposit.items as { secretHash: string; value: string }[];
const plan = commitmentOf(items);
const closers: (() => void)[] = [];
afterAll(() => closers.forEach((c) => c()));

async function start(anchored: boolean) {
  const gw = new Gateway({ statePath: join(mkdtempSync(join(dir, 'gw-')), 'state.db'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': 10n }, content: (p) => ({ served: p }), anchorUivk: d.wallets.anchor.uivk });
  if (anchored) {
    await gw.claim(d.deposit.txid, items);
    await gw.adoptAnchor(d.anchor.txid);
  }
  const s = serveGateway(gw);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  closers.push(() => (s.close(), gw.close()));
  return { gw, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}
const fixture = (indexed: boolean) => Promise.all(d.fixtureNotes.map(async (n: Record<string, string>) => ({ ...n, index: indexed ? Number(n.index) : null, deposit: plan, spent: false, nullifier: (await nullifierOf({ noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value) })).toString() })));
const file = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as { plans: Record<string, { txid: string | null }>; notes: { index: number | null; spent: boolean; nullifier: string; deposit: string }[] };

let opts: ClientOptions;
beforeAll(async () => {
  const a = await readAnchor(d.wallets.anchor.uivk, d.anchor.txid);
  opts = { anchorUivk: d.wallets.anchor.uivk, maxAnchorAgeBlocks: a.tip - a.height! + 10 };
}, 60_000);

describe('the notes file under concurrent calls', () => {
  it('plans made while a claim is in flight (here and in another process) are all kept, and the claim still lands', async () => {
    const { base } = await start(false);
    const path = join(dir, 'claim-vs-plan.json');
    writeFileSync(path, JSON.stringify({ type: 'zec-null-402-notes', gateway: base, plans: { [plan]: { commitment: plan, units: '220', items, txid: null } }, notes: await fixture(false) }), { mode: 0o600 });
    // Another process plans 3 deposits on the same file while this one claims.
    const script = join(dir, 'other-process.mts');
    writeFileSync(script, `import { Z402Client } from ${JSON.stringify(resolve(__dirname, '../src/index.ts'))};\nconst c = new Z402Client(${JSON.stringify(base)}, ${JSON.stringify(path)});\nfor (let i = 0; i < 3; i++) await c.plan(1, 10n);\n`);
    const child = spawn(resolve(__dirname, '../node_modules/.bin/tsx'), [script], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, stdio: ['ignore', 'ignore', 'pipe'] });
    closers.push(() => child.kill());
    let childErr = '';
    child.stderr.on('data', (b) => (childErr += b));
    const childDone = new Promise<number | null>((r) => child.on('close', r));
    const claimer = new Z402Client(base, path, opts);
    const planner = new Z402Client(base, path, opts);
    const [claimed, mine] = await Promise.all([claimer.claim(plan, d.deposit.txid), (async () => [await planner.plan(2, 10n), await planner.plan(1, 20n)])()]);
    expect(await childDone, childErr).toBe(0);
    expect(claimed).toMatchObject({ first: 0, count: 22 });
    const f = file(path);
    expect(Object.keys(f.plans)).toEqual(expect.arrayContaining([plan, mine[0].plan, mine[1].plan]));
    expect(Object.keys(f.plans)).toHaveLength(1 + 2 + 3);
    expect(f.plans[plan].txid).toBe(d.deposit.txid);
    expect(f.notes).toHaveLength(2 + 3 + 3);
    expect(f.notes.filter((n) => n.deposit === plan).map((n) => n.index)).toEqual([0, 1]);
  }, 180_000);

  it('recordDeposit keeps the txid of a sent deposit on its plan', async () => {
    const path = join(dir, 'record.json');
    writeFileSync(path, JSON.stringify({ type: 'zec-null-402-notes', gateway: 'http://127.0.0.1:1', plans: { [plan]: { commitment: plan, units: '220', items, txid: null } }, notes: [] }), { mode: 0o600 });
    const c = new Z402Client('http://127.0.0.1:1', path);
    await c.recordDeposit(plan, d.deposit.txid);
    expect(file(path).plans[plan].txid).toBe(d.deposit.txid);
    await expect(c.recordDeposit('f'.repeat(64), d.deposit.txid)).rejects.toThrow(/no deposit plan/);
  });

  it('two payments at once spend two different notes, and both are recorded as spent', async () => {
    const { gw, base } = await start(true);
    const path = join(dir, 'pay-pay.json');
    writeFileSync(path, JSON.stringify({ type: 'zec-null-402-notes', gateway: base, plans: {}, notes: await fixture(true) }), { mode: 0o600 });
    const [a, b] = [new Z402Client(base, path, opts), new Z402Client(base, path, opts)];
    const rs = await Promise.all([a.pay(`${base}/api/quote`), b.pay(`${base}/api/quote`)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(new Set(rs.map((r) => r.nullifier)).size).toBe(2);
    expect(Object.keys(gw.state.nullifiers)).toHaveLength(2);
    expect(file(path).notes.map((n) => n.spent)).toEqual([true, true]);
    expect(file(path).notes.some((n) => 'pending' in n)).toBe(false);
    expect(existsSync(`${path}.lock`)).toBe(false);
  }, 180_000);

  it('a lock left behind by a process that exited is taken over; one held by a live process makes the change wait', async () => {
    const path = join(dir, 'stale.json');
    writeFileSync(path, JSON.stringify({ type: 'zec-null-402-notes', gateway: 'http://127.0.0.1:1', plans: { [plan]: { commitment: plan, units: '220', items, txid: null } }, notes: [] }), { mode: 0o600 });
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    writeFileSync(`${path}.lock`, dead);
    const c = new Z402Client('http://127.0.0.1:1', path);
    await c.recordDeposit(plan, d.deposit.txid);
    expect(file(path).plans[plan].txid).toBe(d.deposit.txid);
    // a live holder (this test process stands in for another one): the change waits until it lets go
    writeFileSync(`${path}.lock`, String(process.ppid));
    let done = false;
    const p = c.recordDeposit(plan, 'e'.repeat(64)).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    unlinkSync(`${path}.lock`);
    await p;
    expect(file(path).plans[plan].txid).toBe('e'.repeat(64));
  });
});
