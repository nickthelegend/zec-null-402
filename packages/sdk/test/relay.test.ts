// A relay attack on the client, with a real gateway that credited the real published deposit (testnet) and
// a real attacker server in front of it. The attacker answers the agent's request with a challenge it
// fetched from the gateway for its own request, then redeems the agent's proof at the gateway.
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nullifierOf } from '@z402/circuits';
import { Gateway, serveGateway } from '@z402/gateway';
import { Z402Client } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'z402-relay-'));
let gw: Gateway;
let base = '';
let relay = '';
const redeemed: number[] = [];
const servers: Server[] = [];
const listen = async (s: Server) => {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  gw = new Gateway({ statePath: join(dir, 'state.json'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': 10n }, content: (p) => ({ served: p }) });
  await gw.claim(d.deposit.txid, d.deposit.items);
  base = await listen(serveGateway(gw));
  // The attacker: /free costs the agent nothing it can see, and passes /api/info and /api/leaves through.
  relay = await listen(
    createServer(async (req, res) => {
      const send = (status: number, body: string) => res.writeHead(status, { 'content-type': 'application/json' }).end(body);
      if (req.url === '/api/info' || req.url === '/api/leaves') return send(200, await (await fetch(base + req.url)).text());
      const header = req.headers['x-payment'];
      if (typeof header !== 'string') return send(402, await (await fetch(`${base}/api/quote`)).text());
      const r = await fetch(`${base}/api/quote`, { headers: { 'x-payment': header } });
      redeemed.push(r.status);
      return send(200, JSON.stringify({ free: true }));
    }),
  );
  const notes = await Promise.all(d.fixtureNotes.map(async (n: Record<string, string>) => ({ ...n, deposit: 'published', spent: false, nullifier: (await nullifierOf({ noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value) })).toString() })));
  writeFileSync(join(dir, 'notes.json'), JSON.stringify({ type: 'zec-null-402-notes', gateway: base, plans: {}, notes }), { mode: 0o600 });
}, 120_000);
afterAll(() => servers.forEach((s) => s.close()));

describe('the client pays only its own gateway, for the request it made', () => {
  it('a challenge relayed by another origin is refused before any proof is made', async () => {
    const c = new Z402Client(base, join(dir, 'notes.json'));
    await expect(c.pay(`${relay}/free`)).rejects.toThrow(/refusing to pay/);
    expect(redeemed).toEqual([]);
    expect(Object.keys(gw.state.nullifiers)).toHaveLength(0);
    expect(c.status()).toMatchObject({ credited: 2, unspent: 2 });
  }, 120_000);

  it('a challenge for another resource is refused even from the configured origin', async () => {
    const c = new Z402Client(relay, join(dir, 'notes.json'));
    await expect(c.pay(`${relay}/free`)).rejects.toThrow(/refusing to pay.*\/api\/quote.*\/free/);
    expect(redeemed).toEqual([]);
    expect(Object.keys(gw.state.nullifiers)).toHaveLength(0);
  }, 120_000);

  it('its own gateway is still paid', async () => {
    const c = new Z402Client(base, join(dir, 'notes.json'));
    expect((await c.pay(`${base}/api/quote`)).status).toBe(200);
    expect(Object.keys(gw.state.nullifiers)).toHaveLength(1);
  }, 120_000);
});
