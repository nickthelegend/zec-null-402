// Z402Client against a fresh gateway (HTTP) that credits the real published deposit (testnet).
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nullifierOf } from '@z402/circuits';
import { Gateway, serveGateway } from '@z402/gateway';
import { Z402Client } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'z402-sdk-'));
let base = '';
let close = () => {};

beforeAll(async () => {
  const gw = new Gateway({ statePath: join(dir, 'state.json'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': 10n, '/api/report': 50n }, content: (p) => ({ served: p }) });
  await gw.claim(d.deposit.txid, d.deposit.items);
  const s = serveGateway(gw);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  close = () => s.close();
  // a wallet holding the two published fixture notes, already credited at their indices
  const notes = await Promise.all(
    d.fixtureNotes.map(async (n: Record<string, string>) => ({ ...n, deposit: 'published', spent: false, nullifier: (await nullifierOf({ noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value) })).toString() })),
  );
  writeFileSync(join(dir, 'notes.json'), JSON.stringify({ type: 'zec-null-402-notes', gateway: base, plans: {}, notes }), { mode: 0o600 });
}, 120_000);
afterAll(() => close());

describe('Z402Client', () => {
  it('plan: N notes, one deposit of N × units × unitZat with a z402 commitment memo, secrets in a 0600 file', async () => {
    const c = new Z402Client(base, join(dir, 'plan.json'));
    const p = await c.plan(3, 10n);
    expect(p).toMatchObject({ address: d.wallets.gateway.address, amountZat: 30_000n });
    expect(p.memo).toBe(`z402:${p.plan}`);
    expect(statSync(join(dir, 'plan.json')).mode & 0o777).toBe(0o600);
    expect(c.status()).toMatchObject({ notes: 3, credited: 0, unspent: 0 });
  });

  it('pays two calls with proofs (no transaction), then has no note left of the price', async () => {
    const c = new Z402Client(base, join(dir, 'notes.json'));
    for (let i = 0; i < 2; i++) {
      const r = await c.pay(`${base}/api/quote`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ data: { served: '/api/quote' } });
    }
    expect(c.status()).toMatchObject({ credited: 2, unspent: 0 });
    await expect(c.pay(`${base}/api/quote`)).rejects.toThrow(/no unspent note of exactly 10 units/);
  }, 120_000);

  it('a dearer endpoint needs a note of its price', async () => {
    const c = new Z402Client(base, join(dir, 'notes.json'));
    await expect(c.pay(`${base}/api/report`)).rejects.toThrow(/exactly 50 units/);
  });
});
