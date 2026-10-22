// Demo, live, no transaction sent: the shipped client (Z402Client) against a fresh gateway on Zcash testnet.
//   pnpm --filter @z402/examples demo
// 1. a fresh gateway credits the Oct 20 run's real deposit through its viewing key and adopts the run's
//    anchor (read on-chain with the published anchor viewing key)
// 2. the client, with the default 2,880-block window, refuses that anchor: ANCHOR_TOO_OLD
// 3. a dishonest gateway in front of it hands the client its own root with no anchor: UNANCHORED_ROOT
// 4. with the window widened explicitly to cover the Oct 20 anchor, the client pays two calls with the two
//    published fixture notes (real proofs, against the anchored root); a third call has no note left
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leafFromItem, nullifierOf, Tree } from '@z402/circuits';
import { Gateway, readAnchor, serveGateway } from '@z402/gateway';
import { AnchorRefusedError, DEFAULT_MAX_ANCHOR_AGE_BLOCKS, Z402Client } from '@z402/sdk';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const d = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'z402-demo-'));
const say = (s: string) => console.log(s);
const refusal = (e: unknown) => (e instanceof AnchorRefusedError ? e.message : `unexpected: ${(e as Error).message}`);

async function main() {
  const t0 = Date.now();
  const gw = new Gateway({ statePath: join(dir, 'state.db'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': BigInt(d.priceUnits) }, content: () => ({ quote: 'ZEC/USD' }), anchorUivk: d.wallets.anchor.uivk });
  const s = serveGateway(gw);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

  say(`1. a fresh gateway claims the Oct 20 deposit ${d.deposit.txid.slice(0, 12)}… (22 notes, ${Number(d.deposit.amountZat).toLocaleString('en-US')} zat)`);
  const c = await gw.claim(d.deposit.txid, d.deposit.items);
  say(`   its viewing key saw the deposit on testnet: ${c.count} notes credited, root ${c.root.slice(0, 14)}…`);
  const a = await gw.adoptAnchor(d.anchor.txid);
  const onchain = await readAnchor(d.wallets.anchor.uivk, d.anchor.txid);
  const age = onchain.tip - onchain.height!;
  say(`   it adopts the Oct 20 anchor ${a.txid.slice(0, 12)}… (block ${a.height}, ${age} blocks old), read with the published anchor key`);

  // a notes file with the two published fixture notes, credited at their indices and unspent here
  const notes = join(dir, 'notes.json');
  const fixture = await Promise.all(d.fixtureNotes.map(async (n: Record<string, string>) => ({ ...n, index: Number(n.index), deposit: 'published', spent: false, nullifier: (await nullifierOf({ noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value) })).toString() })));
  writeFileSync(notes, JSON.stringify({ type: 'zec-null-402-notes', gateway: base, plans: {}, notes: fixture }), { mode: 0o600 });

  say(`\n2. the client with the default window (${DEFAULT_MAX_ANCHOR_AGE_BLOCKS} blocks) pays /api/quote`);
  await new Z402Client(base, notes, { anchorUivk: d.wallets.anchor.uivk }).pay(`${base}/api/quote`).then(
    (r) => say(`   unexpected: HTTP ${r.status}`),
    (e) => say(`   ${refusal(e)}`),
  );

  say('\n3. a dishonest gateway in front of it serves this client its own leaf list and root, with no anchor');
  const extra = (await leafFromItem({ secretHash: '4242424242', value: '10' })).toString();
  const proxy = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const up = await fetch(base + req.url);
    const body = (await up.json()) as { leaves?: string[]; accepts?: object[] };
    const mine = [...((await (await fetch(`${base}/api/leaves`)).json()) as { leaves: string[] }).leaves, extra];
    const root = (await Tree.build(mine.map(BigInt))).root.toString();
    if (req.url === '/api/leaves') return send(200, { leaves: mine, root });
    if (body.accepts) return send(up.status, { ...body, accepts: body.accepts.map((x) => ({ ...x, root, anchor: null })) });
    return send(up.status, body);
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const pbase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  await new Z402Client(pbase, notes, { anchorUivk: d.wallets.anchor.uivk, maxAnchorAgeBlocks: age + 10 }).pay(`${pbase}/api/quote`).then(
    (r) => say(`   unexpected: HTTP ${r.status}`),
    (e) => say(`   ${refusal(e)}  (no proof was made, nothing sent)`),
  );
  proxy.close();

  say(`\n4. replaying the Oct 20 anchor: the window is widened explicitly to its age + 10 blocks (maxAnchorAgeBlocks: ${age + 10}); the default refused it above`);
  const client = new Z402Client(base, notes, { anchorUivk: d.wallets.anchor.uivk, maxAnchorAgeBlocks: age + 10 });
  for (let i = 0; i < 2; i++) {
    const r = await client.pay(`${base}/api/quote`);
    say(`   GET /api/quote → 402 → proof ${r.proveMs} ms → HTTP ${r.status}, nullifier ${r.nullifier?.slice(0, 12)}…, against anchor ${r.anchor?.txid.slice(0, 12)}… (${r.anchor?.leaves} leaves)`);
  }
  say(`   the gateway burned ${Object.keys(gw.state.nullifiers).length} nullifiers; no transaction was sent for either call`);
  await client.pay(`${base}/api/quote`).then(
    (r) => say(`   unexpected: HTTP ${r.status}`),
    (e) => say(`   a third call: ${(e as Error).message}`),
  );
  s.close();
  gw.close();
  say(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${(e as Error).message}`);
    process.exit(1);
  },
);
