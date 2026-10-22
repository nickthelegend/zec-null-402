// Demo, live reads of Zcash testnet, no transaction sent: the shipped client (Z402Client) against fresh
// gateways rebuilt from the two published runs.
//   pnpm --filter @z402/examples demo
// 1. a fresh gateway credits the Oct 20 run's real deposit through its viewing key and adopts the run's
//    anchor (read on-chain with the published anchor viewing key)
// 2. a live client, with the default 2,880-block window, refuses that anchor: ANCHOR_TOO_OLD
// 3. a dishonest gateway in front of it hands the client its own root with no anchor: UNANCHORED_ROOT
// 4. a replay of the Oct 20 run as the chain stood 10 blocks after its anchor (replayAtHeight, default
//    window, a fixed scan range): two calls pay with the published fixture notes; a third has no note left.
//    That run predates signed anchors (its anchor is unsigned).
// 5. the Oct 22 pass-2 run (signed anchors): a gateway rebuilt from its deposits; a live pinned-key client
//    refuses it (its competing anchor, or the age of its anchors); replayed at block 4,529,604 it pays
//    against the newest signed anchor under the default window; replayed at the record's end it refuses
//    ANCHOR_COMPETING. No gateway of the current protocol is running live for a clone to pay.
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
const p2 = JSON.parse(readFileSync(resolve(ROOT, 'deployments/testnet-pass2.json'), 'utf8'));
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

  say(`\n2. a live client with the default window (${DEFAULT_MAX_ANCHOR_AGE_BLOCKS} blocks) pays /api/quote`);
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
  const replay = { anchorUivk: d.wallets.anchor.uivk, replayAtHeight: a.height! + 10 };
  await new Z402Client(pbase, notes, replay).pay(`${pbase}/api/quote`).then(
    (r) => say(`   unexpected: HTTP ${r.status}`),
    (e) => say(`   ${refusal(e)}  (no proof was made, nothing sent)`),
  );
  proxy.close();

  say(`\n4. a replay of the Oct 20 run as of block ${replay.replayAtHeight} (10 blocks after its anchor), default window: the scan range is fixed, so this does not slow down as the chain grows. Its anchor is unsigned (that run predates signed anchors)`);
  const client = new Z402Client(base, notes, replay);
  for (let i = 0; i < 2; i++) {
    const r = await client.pay(`${base}/api/quote`);
    say(`   GET /api/quote → 402 → proof ${r.proveMs} ms → HTTP ${r.status}, nullifier ${r.nullifier?.slice(0, 12)}…, against anchor ${r.anchor?.txid.slice(0, 12)}… (${r.anchor?.leaves} leaves)`);
  }
  say(`   the gateway burned ${Object.keys(gw.state.nullifiers).length} nullifiers; no transaction was sent for either call`);
  await client.pay(`${base}/api/quote`).then(
    (r) => say(`   unexpected: HTTP ${r.status}`),
    (e) => say(`   a third call: ${(e as Error).message}`),
  );

  say(`\n5. the Oct 22 pass-2 run (current protocol, signed anchors, key ${p2.protocol.anchorPubkey.slice(0, 12)}… pinned from the record): a fresh gateway credits its two deposits and adopts its four anchors`);
  const g2 = new Gateway({ statePath: join(dir, 'pass2.db'), depositUa: p2.wallets.gateway.address, depositUivk: p2.wallets.gateway.uivk, unitZat: 1000, prices: { '/api/quote': 10n }, content: () => ({ quote: 'ZEC/USD' }), anchorUivk: p2.wallets.anchor.uivk });
  for (const x of p2.deposits) await g2.claim(x.txid, x.items);
  for (const x of p2.anchors) await g2.adoptAnchor(x.txid);
  const s2 = serveGateway(g2);
  await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
  say(`   ${(await g2.root()) === p2.gateway.root ? 'root matches the record' : 'ROOT DIFFERS FROM THE RECORD'}; newest anchor ${g2.latestAnchor()?.txid.slice(0, 12)}… at block ${g2.latestAnchor()?.height}`);
  const notes2 = () => {
    const f = join(dir, `pass2-notes-${Date.now()}.json`);
    writeFileSync(f, JSON.stringify({ type: 'zec-null-402-notes', gateway: base2, plans: {}, notes: [{ ...p2.fixtureNote, deposit: p2.deposits[1].memo.slice(5), spent: false }] }), { mode: 0o600 });
    return f;
  };
  const pinned = { anchorUivk: p2.wallets.anchor.uivk, anchorPubkey: p2.protocol.anchorPubkey };
  say('   a live client (current tip, default window):');
  await new Z402Client(base2, notes2(), pinned).pay(`${base2}/api/quote`).then(
    (r) => say(`   unexpected: HTTP ${r.status}`),
    (e) => say(`   ${refusal(e)}`),
  );
  const at = p2.competing.height - 2;
  say(`   replayed as of block ${at} (after the newest honest anchor, before the competing one), default window:`);
  const r2 = await new Z402Client(base2, notes2(), { ...pinned, replayAtHeight: at }).pay(`${base2}/api/quote`);
  say(`   GET /api/quote → 402 → proof ${r2.proveMs} ms → HTTP ${r2.status}, nullifier ${r2.nullifier?.slice(0, 12)}…, against signed anchor ${r2.anchor?.txid.slice(0, 12)}… (${r2.anchor?.leaves} leaves, block ${r2.anchor?.height})`);
  say(`   replayed as of block ${p2.tipAtEnd} (the record's end, after the competing anchor at ${p2.competing.height}):`);
  await new Z402Client(base2, notes2(), { ...pinned, replayAtHeight: p2.tipAtEnd }).pay(`${base2}/api/quote`).then(
    (r) => say(`   unexpected: HTTP ${r.status}`),
    (e) => say(`   ${refusal(e)}`),
  );
  say('   no gateway of the current protocol is anchoring live for a clone to pay; the live signed-anchor payments are the ones recorded in deployments/testnet-pass2.json');
  s2.close();
  g2.close();
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
