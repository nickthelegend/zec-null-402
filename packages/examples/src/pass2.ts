// Live run of the current protocol on Zcash testnet (pass 2: signed anchored roots); writes
// deployments/testnet-pass2.json (no secrets except the one unspent note it publishes as a test fixture).
// Resumable (.demo/pass2/state.json): run it again and it re-checks and rewrites the record without new
// transactions. Demo wallets only (.demo/wallets, made by run-live); the gateway wallet funds the payer.
//   pnpm --filter @z402/examples pass2
//  1. the gateway wallet funds the payer (two notes, so two deposits need no wait for change)
//  2. a fresh gateway (new SQLite database, Z402_AUTO_ANCHOR on, a new anchor signing key) and a client with
//     the default 2,880-block window that pins that key
//  3. deposit 1: 3 notes x 10 units in one shielded tx; claim; the gateway's auto-anchor is mined; the
//     client pays 3 calls (deposit-to-first-call latency measured)
//  4. deposit 2: 3 more notes; claim; anchored
//  5. a dishonest proxy names the first anchor (3 leaves) to a client whose note is leaf 3: the client
//     proves against the newest anchor in its window instead (the old client refused NOTE_NOT_ANCHORED,
//     which told the gateway where the note was)
//  6. the operator turns dishonest: a second anchor for 6 leaves with a different last leaf (a root made for
//     one client), signed with the gateway's key, sent to the anchor address; a client scanning the window
//     refuses ANCHOR_COMPETING. After this the deployment is caught for as long as that anchor is in a window.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leafFromItem, Tree } from '@z402/circuits';
import { anchorMemo, anchorSigner, Gateway, newAnchorSeed, nullifierSetHash, quicksend, readAnchor, scan, scanAnchors, serveGateway, zingoConfig } from '@z402/gateway';
import { AnchorRefusedError, Z402Client } from '@z402/sdk';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEMO = resolve(ROOT, '.demo');
const P2 = resolve(DEMO, 'pass2');
const W = (n: string) => resolve(DEMO, 'wallets', n);
const STATE = resolve(P2, 'state.json');
const KEY = resolve(P2, 'anchor-signing-key');
const cfg = zingoConfig();
const say = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(resolve(DEMO, 'run-state.json'))) {
  console.error('Setup required: .demo/run-state.json (the demo wallets from run-live)');
  process.exit(2);
}
if (process.env.Z402_MAX_ANCHOR_AGE_BLOCKS) {
  console.error('unset Z402_MAX_ANCHOR_AGE_BLOCKS: this run uses the default window');
  process.exit(2);
}
const demo = JSON.parse(readFileSync(resolve(DEMO, 'run-state.json'), 'utf8')) as { addr: Record<string, string>; uivk: Record<string, string> };
mkdirSync(P2, { recursive: true, mode: 0o700 });
const st: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
st.tx ??= {};
st.t ??= {};
const save = () => writeFileSync(STATE, JSON.stringify(st, null, 2), { mode: 0o600 });
if (!existsSync(KEY)) writeFileSync(KEY, newAnchorSeed(), { mode: 0o600 });
const seed = readFileSync(KEY, 'utf8').trim();
const signer = anchorSigner(seed);

/** One quicksend per label, resumable; waits while the wallet's notes are not spendable yet. */
async function sendOnce(label: string, wallet: string, to: { address: string; amount: bigint; memo?: string }[]): Promise<string> {
  if (st.tx[label]) return st.tx[label];
  for (let i = 0; ; i++) {
    try {
      const [txid] = await quicksend(cfg, wallet, to);
      st.tx[label] = txid;
      save();
      say(`sent ${label}: ${txid}`);
      return txid;
    } catch (e) {
      if (!/Insufficient balance/.test((e as Error).message) || i >= 30) throw e;
      say(`  ${label}: notes not spendable yet, waiting a block`);
      await sleep(60_000);
    }
  }
}

async function mined(uivk: string, txid: string, label: string): Promise<number> {
  for (let i = 0; i < 90; i++) {
    const r = await scan(uivk, txid, 0, undefined);
    if (r.confirmations >= 1) return r.height!;
    if (i % 3 === 0) say(`  ${label} ${txid.slice(0, 10)}… ${r.found ? 'in the mempool' : 'not seen yet'}`);
    await sleep(20_000);
  }
  throw new Error(`${label} ${txid} not mined after 30 minutes`);
}

/** Pays until HTTP 200, waiting while the client refuses for a reason the gateway's next anchor fixes. */
async function payWhenAnchored(c: Z402Client, url: string, label: string) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await c.pay(url);
      if (r.status !== 200) throw new Error(`${label}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
      return r;
    } catch (e) {
      if (!(e instanceof AnchorRefusedError) || !['NOTE_NOT_ANCHORED', 'UNANCHORED_ROOT', 'ANCHOR_NOT_CONFIRMED'].includes(e.code)) throw e;
      if (i % 3 === 0) say(`  ${label}: ${e.code}, waiting for the gateway's anchor to be mined`);
      await sleep(20_000);
    }
  }
  throw new Error(`${label}: no payable anchor after 40 minutes`);
}

async function main() {
  const gwWallet = W('gateway');
  // 1. funding: two 60,000 zat notes for the payer, from the gateway's demo wallet
  const fund = await sendOnce('fund', gwWallet, [
    { address: demo.addr.payer, amount: 60_000n },
    { address: demo.addr.payer, amount: 60_000n },
  ]);
  await mined(demo.uivk.payer, fund, 'fund');

  // 2. a fresh gateway and a default-window client that pins the gateway's anchor key
  const gw = new Gateway({
    statePath: resolve(P2, 'gateway.db'),
    depositUa: demo.addr.gateway,
    depositUivk: demo.uivk.gateway,
    unitZat: 1000,
    prices: { '/api/quote': 10n },
    content: (path) => ({ path, servedAt: new Date().toISOString(), note: 'paid with a zero-knowledge proof of a prepaid shielded note' }),
    anchorUa: demo.addr.anchor,
    anchorUivk: demo.uivk.anchor,
    anchorSigningKey: seed,
    autoAnchor: true,
    anchorCheckMs: 60_000,
    anchorRetryMs: 60_000,
    anchorRetries: 30,
    sendAnchor: async (memo) => {
      const t = Date.now();
      const [txid] = await quicksend(cfg, gwWallet, [{ address: demo.addr.anchor, amount: 10_000n, memo }]);
      (st.anchorSends ??= []).push({ txid, sentAt: new Date(t).toISOString(), sendMs: Date.now() - t });
      save();
      return txid;
    },
  });
  const server = serveGateway(gw);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // once the dishonest anchor is out, the honest gateway is not run again: a new anchor of its own would
  // change the record
  if (!st.competing?.txid) gw.startAnchoring();
  const notes = resolve(P2, 'notes.json');
  const client = new Z402Client(base, notes, { anchorUivk: demo.uivk.anchor, anchorPubkey: signer.publicKey });
  say(`gateway ${base}, anchor key ${signer.publicKey.slice(0, 16)}…, client window ${client.maxAnchorAgeBlocks} blocks`);

  // 3. deposit 1 → claim → anchor mined → 3 paid calls
  const deposit = async (label: string, count: number) => {
    if (!st[label]) {
      const p = await client.plan(count, 10n);
      st[label] = { plan: p.plan, amountZat: p.amountZat.toString(), memo: p.memo, address: p.address };
      save();
    }
    const d = st[label];
    const txid = await sendOnce(label, W('payer'), [{ address: d.address, amount: BigInt(d.amountZat), memo: d.memo }]);
    await client.recordDeposit(d.plan, txid);
    st.t[`${label}Sent`] ??= Date.now();
    d.height ??= await mined(demo.uivk.gateway, txid, label);
    st.t[`${label}Mined`] ??= Date.now();
    save();
    if (!d.claimed) {
      d.claimed = await client.claim(d.plan, txid);
      st.t[`${label}Claimed`] = Date.now();
      save();
    }
    say(`${label}: ${txid.slice(0, 12)}… at block ${d.height}, ${d.claimed.count} notes credited from leaf ${d.claimed.first}`);
    return txid;
  };
  const dep1 = await deposit('deposit1', 3);
  st.calls ??= [];
  const pay = async (c: Z402Client, url: string, label: string) => {
    const r = await payWhenAnchored(c, url, label);
    const call = { n: st.calls.length + 1, label, status: r.status, nullifier: r.nullifier, proveMs: r.proveMs, anchor: r.anchor, at: new Date().toISOString() };
    st.calls.push(call);
    save();
    say(`${label}: HTTP ${r.status}, proof ${r.proveMs} ms, against anchor ${r.anchor?.txid.slice(0, 12)}… (${r.anchor?.leaves} leaves, block ${r.anchor?.height})`);
    return call;
  };
  while (st.calls.filter((c: { label: string }) => c.label.startsWith('call')).length < 3) {
    const n = st.calls.length + 1;
    await pay(client, `${base}/api/quote`, `call ${n}`);
    if (n === 1) st.t.firstPaid ??= Date.now();
    save();
  }

  // 4. deposit 2 → claim → anchored (6 leaves)
  const dep2 = await deposit('deposit2', 3);
  for (let i = 0; !(gw.latestAnchor()?.leaves === 6); i++) {
    if (i > 120) throw new Error('no mined anchor for 6 leaves after 40 minutes');
    if (i % 3 === 0) say(`  waiting for a mined anchor of 6 leaves (latest: ${gw.latestAnchor()?.leaves ?? 'none'})`);
    await gw.confirmAnchors();
    await sleep(20_000);
  }

  // 5. a proxy names the first anchor (3 leaves); the client proves against the newest one it found itself
  if (!st.probe) {
    const first = gw.state.anchors.find((a) => a.height !== null && a.leaves === 3)!;
    const proxy: Server = createServer(async (req, res) => {
      const up = await fetch(base + req.url, { headers: typeof req.headers['x-payment'] === 'string' ? { 'x-payment': req.headers['x-payment'] } : {} });
      const body = (await up.json()) as { accepts?: { anchor: unknown; root: string }[] };
      if (body.accepts) body.accepts = body.accepts.map((c) => ({ ...c, root: first.root, anchor: { txid: first.txid, leaves: first.leaves, root: first.root, height: first.height } }));
      res.writeHead(up.status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const pbase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const f = JSON.parse(readFileSync(notes, 'utf8'));
    const leaf3 = f.notes.find((n: { index: number | null; spent: boolean }) => n.index === 3 && !n.spent);
    // a notes file holding only the note at leaf 3, so the proof is for a note newer than the named anchor
    const probeNotes = resolve(P2, 'probe-notes.json');
    writeFileSync(probeNotes, JSON.stringify({ type: 'zec-null-402-notes', gateway: pbase, plans: {}, notes: [leaf3] }), { mode: 0o600 });
    const pc = new Z402Client(pbase, probeNotes, { anchorUivk: demo.uivk.anchor, anchorPubkey: signer.publicKey });
    const r = await pc.pay(`${pbase}/api/quote`);
    proxy.close();
    st.probe = { named: { txid: first.txid, leaves: first.leaves, height: first.height }, used: r.anchor, status: r.status, nullifier: r.nullifier, noteIndex: 3 };
    // the same note is spent in the main notes file too
    const g = JSON.parse(readFileSync(notes, 'utf8'));
    g.notes.find((n: { index: number | null }) => n.index === 3).spent = true;
    writeFileSync(notes, JSON.stringify(g, null, 2), { mode: 0o600 });
    save();
    say(`probe: the proxy named anchor ${first.txid.slice(0, 12)}… (3 leaves); the client paid (HTTP ${r.status}) against ${r.anchor?.txid.slice(0, 12)}… (${r.anchor?.leaves} leaves)`);
  }
  if (!st.calls.some((c: { label: string }) => c.label === 'call after deposit 2')) await pay(client, `${base}/api/quote`, 'call after deposit 2');

  // anchor the end state (spent count), then stop the honest gateway's anchoring before the dishonest step
  gw.stopAnchoring();
  for (let i = 0; !st.competing?.txid; i++) {
    const due = await gw.anchorDue().catch(() => 'unknown');
    const pending = gw.state.anchors.some((a) => a.height === null);
    if (!due && !pending) break;
    if (i > 120) throw new Error('the honest end-state anchor was not mined after 40 minutes');
    if (due && !pending && i % 6 === 0) gw.anchorWithRetry(`end state: ${due}`);
    if (i % 3 === 0) say(`  waiting for the honest end-state anchor (${due ?? 'pending'})`);
    await gw.confirmAnchors();
    await sleep(20_000);
  }
  const honest = gw.state.anchors;
  server.close();

  // 6. the operator anchors a second root for 6 leaves (last leaf swapped), signed with its key
  const leaves = gw.state.leaves;
  if (!st.competing) {
    const other = [...leaves.slice(0, 5), (await leafFromItem({ secretHash: BigInt(`0x${newAnchorSeed()}`).toString().slice(0, 70), value: '10' })).toString()];
    const root = (await Tree.build(other.map(BigInt))).root.toString();
    const m = { leaves: 6, root, nullifiers: 0, nullifierHash: nullifierSetHash([]) };
    st.competing = { ...m, memo: anchorMemo(m.leaves, m.root, m.nullifiers, m.nullifierHash, signer.sign(m)) };
    save();
  }
  const ctx = await sendOnce('competing', gwWallet, [{ address: demo.addr.anchor, amount: 10_000n, memo: st.competing.memo }]);
  st.competing.txid = ctx;
  st.competing.height ??= await mined(demo.uivk.anchor, ctx, 'competing anchor');
  save();

  // A client's view of the chain is its lightwalletd's. The first check ran seconds after the competing
  // anchor was mined and paid (its scan did not include that block yet; the payment burned leaf 5's
  // nullifier on this gateway). Kept in the record; the check below waits until a scan shows the anchor.
  if (st.competingRefusal?.code === 'PAID' && !st.competingFirstCheck) st.competingFirstCheck = { ...st.competingRefusal, note: 'checked seconds after the competing anchor was mined; the client scan did not include it yet' };
  for (let i = 0; !(await scanAnchors(demo.uivk.anchor, { last: 50 })).anchors.some((a) => a.txid === ctx); i++) {
    if (i > 60) throw new Error('lightwalletd never served the block of the competing anchor');
    await sleep(10_000);
  }
  // a client of the (otherwise honest-looking) gateway now refuses: the window holds two signed roots for 6 leaves
  const g2 = new Gateway({ statePath: resolve(P2, 'gateway.db'), depositUa: demo.addr.gateway, depositUivk: demo.uivk.gateway, unitZat: 1000, prices: { '/api/quote': 10n }, content: () => ({}), anchorUivk: demo.uivk.anchor, anchorSigningKey: seed });
  const s2 = serveGateway(g2);
  await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
  const left = resolve(P2, 'competing-check-notes.json');
  const f = JSON.parse(readFileSync(notes, 'utf8'));
  writeFileSync(left, JSON.stringify({ ...f, gateway: b2, anchor: undefined }), { mode: 0o600 });
  const fresh = new Z402Client(b2, left, { anchorUivk: demo.uivk.anchor, anchorPubkey: signer.publicKey });
  const refused = await fresh.pay(`${b2}/api/quote`).then(
    (r) => ({ code: 'PAID', message: `HTTP ${r.status}` }),
    (e) => ({ code: e instanceof AnchorRefusedError ? e.code : 'ERROR', message: (e as Error).message }),
  );
  s2.close();
  g2.close();
  st.competingRefusal = refused;
  save();
  say(`after the competing anchor: ${refused.code}: ${refused.message}`);

  // record
  const tip = (await readAnchor(demo.uivk.anchor, ctx)).tip;
  const depItems = (k: string) => JSON.parse(readFileSync(notes, 'utf8')).plans[st[k].plan].items;
  const calls = st.calls.map((c: Record<string, unknown>) => ({ ...c, anchor: c.anchor }));
  const ms = (a: string, b: string) => st.t[b] - st.t[a];
  writeFileSync(
    resolve(ROOT, 'deployments/testnet-pass2.json'),
    JSON.stringify(
      {
        network: 'zcash-testnet',
        ranAt: new Date().toISOString(),
        note: 'Pass 2: the current protocol live (anchored roots, signed anchors, the default 2,880-block client window). Demo wallets as in testnet.json; no note secrets here. The competing anchor at the end is the operator turning dishonest on purpose: clients refuse this deployment while it is in their window.',
        protocol: { anchorPubkey: signer.publicKey, clientWindowBlocks: client.maxAnchorAgeBlocks, autoAnchor: true, anchorCheckSec: 60 },
        wallets: { payer: { address: demo.addr.payer }, gateway: { address: demo.addr.gateway, uivk: demo.uivk.gateway }, anchor: { address: demo.addr.anchor, uivk: demo.uivk.anchor } },
        txs: { fund, deposit1: dep1, deposit2: dep2, anchors: honest.map((a) => a.txid), competing: ctx },
        deposits: [
          { txid: dep1, memo: st.deposit1.memo, amountZat: st.deposit1.amountZat, height: st.deposit1.height, items: depItems('deposit1'), claimed: st.deposit1.claimed },
          { txid: dep2, memo: st.deposit2.memo, amountZat: st.deposit2.amountZat, height: st.deposit2.height, items: depItems('deposit2'), claimed: st.deposit2.claimed },
        ],
        anchors: honest.map((a) => ({ ...a, memo: anchorMemo(a.leaves, a.root, a.nullifiers, a.nullifierHash, signer.sign(a)) })),
        anchorSends: st.anchorSends,
        calls,
        probe: st.probe,
        competing: st.competing,
        competingFirstCheck: st.competingFirstCheck ?? null,
        competingRefusal: st.competingRefusal,
        // the one note left unspent (leaf 5), published like the Oct 20 fixture notes, so tests in a fresh
        // clone can show a client paying with it before the competing-anchor check, and refusing after
        fixtureNote: (({ noteSecret, nullifierSecret, value, index, nullifier }) => ({ noteSecret, nullifierSecret, value, index, nullifier }))(JSON.parse(readFileSync(notes, 'utf8')).notes.find((n: { index: number | null; spent: boolean }) => n.index === 5 && !n.spent)),
        latency: {
          depositSentToMinedMs: ms('deposit1Sent', 'deposit1Mined'),
          depositSentToClaimedMs: ms('deposit1Sent', 'deposit1Claimed'),
          depositSentToFirstPaidCallMs: ms('deposit1Sent', 'firstPaid'),
          claimedToFirstPaidCallMs: ms('deposit1Claimed', 'firstPaid'),
          proofMs: calls.map((c: { proveMs: number }) => c.proveMs),
        },
        gateway: { leaves: leaves.length, root: await gw.root(), spent: Object.keys(gw.state.nullifiers).length },
        tipAtEnd: tip,
      },
      null,
      2,
    ) + '\n',
  );
  gw.close();
  say('wrote deployments/testnet-pass2.json');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${(e as Error).message}`);
    process.exit(1);
  },
);
