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
  const gw = new Gateway({ statePath: join(mkdtempSync(join(tmpdir(), 'z402-atk-')), 'state.db'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': BigInt(d.priceUnits) }, content: (p) => ({ served: p }), ...extra });
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

describe('concurrent requests', () => {
  it('one payment sent twice at once is paid once', async () => {
    const g = await fresh();
    const p = await g.prove(notes[0]);
    const rs = await Promise.all([g.pay(p), g.pay(p), g.pay(p)]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(Object.keys(g.gw.state.nullifiers)).toHaveLength(1);
  }, 180_000);

  it('two proofs of the same note for two requests, sent at once, pay one call', async () => {
    const g = await fresh();
    const [a, b] = [await g.prove(notes[1]), await g.prove(notes[1])];
    const rs = await Promise.all([g.pay(a), g.pay(b)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 402]);
  }, 180_000);

  it('two claims of one deposit at once credit it once', async () => {
    const g = await fresh({}, false);
    const post = () => fetch(`${g.base}/api/deposits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: d.deposit.txid, items }) }).then((r) => r.status);
    const statuses = await Promise.all([post(), post()]);
    expect(statuses.sort()).toEqual([200, 409]);
    expect(g.gw.state.leaves).toHaveLength(22);
  }, 180_000);
});

describe('the gateway wallet and its keys', () => {
  it('POST /api/anchor spends from the gateway wallet only with the admin token', async () => {
    let sends = 0;
    const sendAnchor = async () => {
      sends++;
      throw new Error('this test never sends');
    };
    const open = await fresh({ sendAnchor }, false);
    const noToken = await fetch(`${open.base}/api/anchor`, { method: 'POST' });
    expect(noToken.status).toBe(503);
    expect(((await noToken.json()) as { error: string }).error).toMatch(/Setup required: Z402_ADMIN_TOKEN/);
    const locked = await fresh({ sendAnchor, adminToken: 'correct-horse' }, false);
    for (const auth of [undefined, 'Bearer wrong', 'correct-horse']) {
      const r = await fetch(`${locked.base}/api/anchor`, { method: 'POST', headers: auth ? { authorization: auth } : {} });
      expect(r.status, `authorization: ${auth}`).toBe(401);
    }
    expect(sends).toBe(0);
  });

  it('GET /api/info does not hand out the deposit viewing key', async () => {
    const g = await fresh({}, false);
    const info = await (await fetch(`${g.base}/api/info`)).text();
    expect(info).not.toContain(d.wallets.gateway.uivk);
    expect(JSON.parse(info)).not.toHaveProperty('depositUivk');
  });
});

describe('bounded memory', () => {
  it('outstanding challenges are capped: the oldest is dropped first', async () => {
    const g = await fresh({ maxChallenges: 3 });
    const p = await g.prove(notes[0]);
    for (let i = 0; i < 3; i++) await g.challenge();
    expect((await g.pay(p)).body.reason).toBe('UNKNOWN_CHALLENGE');
  }, 180_000);

  it('a request body over 64 KiB is refused with 413', async () => {
    const g = await fresh({}, false);
    const r = await fetch(`${g.base}/api/deposits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: 'a'.repeat(64), items: [{ secretHash: '1'.repeat(70_000), value: '1' }] }) });
    expect(r.status).toBe(413);
  });
});
