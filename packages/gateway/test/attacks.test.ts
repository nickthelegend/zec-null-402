// Attacks found in docs/JUDGE-2026-10-21.md. Each test stands up a fresh gateway over HTTP that credits
// the real published deposit (Zcash testnet, the gateway's viewing key) and pays with real Groth16 proofs
// of the two published fixture notes.
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { provePayment, Tree, type Note } from '@z402/circuits';
import { Gateway, serveGateway, type GatewayOptions } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const items = d.deposit.items as { secretHash: string; value: string }[];
const notes: (Note & { index: number })[] = d.fixtureNotes.map((n: Record<string, string>) => ({ noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value), index: Number(n.index) }));
const closers: (() => void)[] = [];
afterAll(() => closers.forEach((c) => c()));

async function fresh(extra: Partial<GatewayOptions> = {}, claim = true) {
  const gw = new Gateway({ statePath: join(mkdtempSync(join(tmpdir(), 'z402-atk-')), 'state.json'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': BigInt(d.priceUnits) }, content: (p) => ({ served: p }), ...extra });
  if (claim) await gw.claim(d.deposit.txid, items);
  const s = serveGateway(gw);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  closers.push(() => s.close());
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const challenge = async () => ((await (await fetch(`${base}/api/quote`)).json()) as { accepts: { payTo: string; requiredAmount: string; contextHash: string; nonce: string }[] }).accepts[0];
  const prove = async (n: Note & { index: number }) => {
    const c = await challenge();
    const p = await provePayment(n, n.index, await Tree.build(gw.state.leaves.map(BigInt)), BigInt(c.payTo), BigInt(c.requiredAmount), BigInt(c.contextHash));
    return { nonce: c.nonce, proof: p.proof, signals: p.signals };
  };
  const pay = (p: object) => fetch(`${base}/api/quote`, { headers: { 'x-payment': Buffer.from(JSON.stringify(p)).toString('base64') } }).then(async (r) => ({ status: r.status, body: (await r.json()) as { reason?: string } }));
  return { gw, base, challenge, prove, pay };
}

describe('one note pays one call, however its nullifier is written', () => {
  it('a fresh proof of a spent note, its nullifier written with a leading zero or in hex, is refused', async () => {
    const g = await fresh();
    expect((await g.pay(await g.prove(notes[0]))).status).toBe(200);
    for (const [name, enc] of [['leading zero', (n: string) => `0${n}`], ['two leading zeros', (n: string) => `00${n}`], ['hex', (n: string) => `0x${BigInt(n).toString(16)}`]] as const) {
      const p = await g.prove(notes[0]);
      const r = await g.pay({ ...p, signals: { ...p.signals, nullifier: enc(p.signals.nullifier) } });
      expect(r.status, `nullifier written with ${name}`).toBe(402);
    }
    expect(Object.keys(g.gw.state.nullifiers)).toHaveLength(1);
  }, 180_000);

  it('every public signal must be canonical decimal: a re-encoded root or amount is refused even for an unspent note', async () => {
    const g = await fresh();
    const p = await g.prove(notes[1]);
    expect((await g.pay({ ...p, signals: { ...p.signals, merkle_root: `0${p.signals.merkle_root}` } })).body.reason).toBe('MALFORMED_SIGNALS');
    expect((await g.pay({ ...p, signals: { ...p.signals, nullifier: 12 } })).body.reason).toBe('MALFORMED_SIGNALS');
    expect((await g.pay(p)).status).toBe(200);
  }, 180_000);
});
