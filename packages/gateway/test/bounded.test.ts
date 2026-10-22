// Work per request is bounded: an unpaid request does not load the whole database, one challenge buys at
// most three proof checks, scans of claimed deposits run at most four at a time, and a claim must be JSON
// (a web page cannot post one as text/plain without a CORS preflight). Real gateways over HTTP; the claims
// are checked on testnet by the real scan binary.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Gateway, serveGateway, type GatewayOptions } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const items = d.deposit.items as { secretHash: string; value: string }[];
const closers: (() => void)[] = [];
afterAll(() => closers.forEach((c) => c()));

async function fresh(extra: Partial<GatewayOptions> = {}, claim = true) {
  const gw = new Gateway({ statePath: join(mkdtempSync(join(tmpdir(), 'z402-bounded-')), 'state.db'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': BigInt(d.priceUnits) }, content: (p) => ({ served: p }), ...extra });
  if (claim) await gw.claim(d.deposit.txid, items);
  const s = serveGateway(gw);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  closers.push(() => (s.close(), gw.close()));
  return { gw, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function timed(url: string) {
  const ms: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    await (await fetch(url)).text();
    ms.push(performance.now() - t);
  }
  return median(ms);
}

describe('bounded work per request', () => {
  it('a 402 and /api/info cost the same with 200,000 spent nullifiers as with none', async () => {
    const { gw, base } = await fresh();
    const empty = { quote: await timed(`${base}/api/quote`), info: await timed(`${base}/api/info`) };
    const ins = gw.db.prepare('INSERT INTO nullifiers VALUES (?, ?, ?)');
    gw.db.exec('BEGIN');
    for (let i = 0; i < 200_000; i++) ins.run(String(10n ** 30n + BigInt(i)), '2026-10-22T00:00:00.000Z', '/api/quote');
    gw.db.exec('COMMIT');
    const full = { quote: await timed(`${base}/api/quote`), info: await timed(`${base}/api/info`) };
    expect(((await (await fetch(`${base}/api/info`)).json()) as { spent: number }).spent).toBe(200_000);
    expect(full.quote, `402: ${empty.quote.toFixed(1)} ms empty, ${full.quote.toFixed(1)} ms full`).toBeLessThan(empty.quote + 25);
    expect(full.info, `/api/info: ${empty.info.toFixed(1)} ms empty, ${full.info.toFixed(1)} ms full`).toBeLessThan(empty.info + 25);
  }, 180_000);

  it('one challenge buys at most three proof checks: then it is gone (UNKNOWN_CHALLENGE)', async () => {
    const { base } = await fresh();
    const c = ((await (await fetch(`${base}/api/quote`)).json()) as { accepts: { payTo: string; requiredAmount: string; contextHash: string; nonce: string }[] }).accepts[0];
    // well-formed, bound to the challenge, the known root, an unspent nullifier, and no valid proof
    const p = { nonce: c.nonce, proof: { pi_a: ['1', '2', '1'], pi_b: [['1', '2'], ['3', '4'], ['1', '0']], pi_c: ['1', '2', '1'], protocol: 'groth16', curve: 'bn128' }, signals: { nullifier: '123456789', merkle_root: d.gateway.root, pay_to: c.payTo, required_amount: c.requiredAmount, context_hash: c.contextHash } };
    const reasons: string[] = [];
    for (let i = 0; i < 6; i++) reasons.push(((await (await fetch(`${base}/api/quote`, { headers: { 'x-payment': Buffer.from(JSON.stringify(p)).toString('base64') } })).json()) as { reason: string }).reason);
    expect(reasons).toEqual(['BAD_PROOF', 'BAD_PROOF', 'BAD_PROOF', 'UNKNOWN_CHALLENGE', 'UNKNOWN_CHALLENGE', 'UNKNOWN_CHALLENGE']);
  }, 180_000);

  it('at most four deposit scans run at once; the rest get 503 with Retry-After, and no scanner is started for them', async () => {
    const { base } = await fresh({}, false);
    const post = () => fetch(`${base}/api/deposits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: randomBytes(32).toString('hex'), items: items.slice(0, 1) }) }).then(async (r) => ({ status: r.status, retry: r.headers.get('retry-after'), body: (await r.json()) as { error: string } }));
    const rs = await Promise.all(Array.from({ length: 50 }, post));
    const busy = rs.filter((r) => r.status === 503);
    expect(rs.length - busy.length).toBeLessThanOrEqual(4);
    expect(busy.length).toBeGreaterThanOrEqual(46);
    for (const b of busy) {
      expect(b.retry).toMatch(/^\d+$/);
      expect(b.body.error).toMatch(/busy/);
    }
    for (const r of rs.filter((x) => x.status !== 503)) expect(r.status).toBe(402);
  }, 180_000);

  it('a claim or an anchor request that is not application/json is refused with 415 before anything runs', async () => {
    const { base } = await fresh({ adminToken: 'correct-horse', sendAnchor: async () => { throw new Error('never sent'); } }, false);
    const text = await fetch(`${base}/api/deposits`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ txid: d.deposit.txid, items }) });
    expect(text.status).toBe(415);
    const none = await fetch(`${base}/api/deposits`, { method: 'POST', body: JSON.stringify({ txid: d.deposit.txid, items }) });
    expect(none.status).toBe(415);
    const anchor = await fetch(`${base}/api/anchor`, { method: 'POST', headers: { authorization: 'Bearer correct-horse', 'content-type': 'text/plain' } });
    expect(anchor.status).toBe(415);
    expect(((await (await fetch(`${base}/api/info`)).json()) as { deposits: number }).deposits).toBe(0);
  }, 180_000);
});
