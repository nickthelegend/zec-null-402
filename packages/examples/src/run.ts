// Live run on Zcash testnet; writes deployments/testnet.json. Resumable (.demo/run-state.json).
//   Z402_FUNDER_WALLET=<zingo data dir of a funded demo wallet> pnpm --filter @z402/examples run-live
//  1. the payer deposits 22 notes × 10 units (1 unit = 1,000 zat) in ONE shielded transaction
//  2. the gateway credits them only after seeing the deposit with its viewing key (claimed once)
//  3. 20 paid calls, each a fresh Groth16 proof of a different note; no transaction per call
//  4. refused: replayed proof, tampered amount, proof for another request, second claim of the deposit,
//     a claim with altered note values
//  5. the gateway anchors (leaf count, root, nullifier-set hash) in a shielded memo; re-read it with the
//     anchor address's published viewing key
//  Two notes ("fixture notes") are spent here and their secrets published, so tests in a fresh clone
//  can pay against a fresh gateway with a real chain-backed deposit.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gateway, serveGateway, scan, uivkFromUfvk, address, exportUfvk, quicksend, spendable, zingoConfig, anchorMemo, nullifierSetHash } from '@z402/gateway';
import { Z402Client } from '@z402/sdk';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEMO = resolve(ROOT, '.demo');
const W = (n: string) => resolve(DEMO, 'wallets', n);
const STATE = resolve(DEMO, 'run-state.json');
const cfg = zingoConfig();
const UNIT = 1000;
const PRICE = 10n;
const CALLS = 20;
mkdirSync(resolve(DEMO, 'wallets'), { recursive: true, mode: 0o700 });
const st: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
st.tx ??= {};
const save = () => writeFileSync(STATE, JSON.stringify(st, null, 2), { mode: 0o600 });
const say = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendOnce(label: string, from: string, to: { address: string; amount: bigint; memo?: string }[]) {
  if (st.tx[label]) return st.tx[label] as string;
  for (let i = 0; ; i++) {
    try {
      const [txid] = await quicksend(cfg, from, to);
      st.tx[label] = txid;
      save();
      say(`  sent ${label}: ${txid}`);
      return txid;
    } catch (e) {
      if (!/Insufficient balance/.test((e as Error).message) || i >= 25) throw e;
      say(`  … ${label}: notes not spendable yet, waiting a block`);
      await sleep(60_000);
    }
  }
}

async function mined(uivk: string, txid: string, label: string) {
  for (let i = 0; i < 80; i++) {
    const r = await scan(uivk, txid, 0, undefined);
    if (r.confirmations >= 1) return r;
    if (i % 3 === 0) say(`  … ${label} ${txid.slice(0, 10)} ${r.found ? 'in the mempool' : 'not seen yet'}`);
    await sleep(20_000);
  }
  throw new Error(`${label} ${txid} not mined`);
}

async function main() {
  st.addr ??= {};
  st.uivk ??= {};
  for (const n of ['payer', 'gateway', 'anchor']) {
    st.addr[n] ??= await address(cfg, W(n));
    st.uivk[n] ??= await uivkFromUfvk(await exportUfvk(cfg, W(n)));
    save();
  }
  say(`payer ${st.addr.payer.slice(0, 16)}…  gateway ${st.addr.gateway.slice(0, 16)}…  anchor ${st.addr.anchor.slice(0, 16)}…`);
  if (!st.tx.fund) {
    const funder = process.env.Z402_FUNDER_WALLET;
    if (!funder) throw new Error('Setup required: Z402_FUNDER_WALLET');
    say(`funder spendable ${await spendable(cfg, funder)} zat`);
    await sendOnce('fund', funder, [{ address: st.addr.payer, amount: 300_000n }, { address: st.addr.gateway, amount: 60_000n }]);
  }
  await mined(st.uivk.payer, st.tx.fund, 'fund');

  const gw = new Gateway({
    statePath: resolve(DEMO, 'gateway-state.json'),
    depositUa: st.addr.gateway,
    depositUivk: st.uivk.gateway,
    unitZat: UNIT,
    prices: { '/api/quote': PRICE },
    content: () => ({ quote: 'ZEC/USD', note: 'paid with a proof' }),
    anchorUa: st.addr.anchor,
    sendAnchor: async (memo) => sendOnce(`anchor:${memo.slice(0, 40)}`, W('gateway'), [{ address: st.addr.anchor, amount: 10_000n, memo }]),
  });
  const server = serveGateway(gw);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new Z402Client(base, resolve(DEMO, 'payer-notes.json'));

  // 1-2: one deposit for 22 notes
  if (!st.plan) {
    st.plan = await client.plan(CALLS + 2, PRICE);
    st.plan.amountZat = st.plan.amountZat.toString();
    save();
  }
  const deposit = await sendOnce('deposit', W('payer'), [{ address: st.plan.address, amount: BigInt(st.plan.amountZat), memo: st.plan.memo }]);
  await mined(st.uivk.gateway, deposit, 'deposit');
  if (!st.claimed) {
    st.claimed = await client.claim(st.plan.plan, deposit);
    save();
  }
  say(`claimed: ${st.claimed.count} notes credited from ${deposit.slice(0, 10)}…, root ${String(st.claimed.root).slice(0, 12)}…`);

  // 4a: the same deposit cannot be claimed twice; altered values are not credited
  const notes = JSON.parse(readFileSync(resolve(DEMO, 'payer-notes.json'), 'utf8'));
  const items = notes.plans[st.plan.plan].items as { secretHash: string; value: string }[];
  const refusals: Record<string, string> = {};
  const tryClaim = async (label: string, its: unknown) => {
    const r = await fetch(`${base}/api/deposits`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: deposit, items: its }) });
    refusals[label] = `HTTP ${r.status}: ${((await r.json()) as { error: string }).error}`;
    say(`refused ${label}: ${refusals[label]}`);
  };
  await tryClaim('second claim of the deposit', items);
  const fresh = new Gateway({ statePath: resolve(DEMO, 'scratch-gateway.json'), depositUa: st.addr.gateway, depositUivk: st.uivk.gateway, unitZat: UNIT, prices: {}, content: () => null });
  try {
    await fresh.claim(deposit, items.map((i, k) => (k === 0 ? { ...i, value: '1000' } : i)));
    throw new Error('altered values were credited');
  } catch (e) {
    refusals['claim with an altered note value (fresh gateway)'] = (e as Error).message;
    say(`refused claim with altered values: ${(e as Error).message}`);
  }

  // 3: 20 paid calls
  const calls = (st.calls ??= []) as { n: number; status: number; nullifier: string; proveMs: number }[];
  while (calls.length < CALLS) {
    const r = await client.pay(`${base}/api/quote`);
    calls.push({ n: calls.length + 1, status: r.status, nullifier: r.nullifier!, proveMs: r.proveMs });
    save();
    say(`call ${calls.length}: HTTP ${r.status}, nullifier ${r.nullifier?.slice(0, 12)}…, proof ${r.proveMs} ms`);
    if (r.status !== 200) throw new Error(`call ${calls.length} failed: ${JSON.stringify(r.body)}`);
  }

  // 4b: replay, tampered amount, proof for another request (with the two fixture notes)
  const { provePayment, Tree } = await import('@z402/circuits');
  const ch = async () => ((await (await fetch(`${base}/api/quote`)).json()) as { accepts: { payTo: string; requiredAmount: string; contextHash: string; nonce: string }[] }).accepts[0];
  const f = JSON.parse(readFileSync(resolve(DEMO, 'payer-notes.json'), 'utf8'));
  const fixture = f.notes.filter((n: { spent: boolean; index: number | null }) => !n.spent && n.index !== null).slice(0, 2);
  if (st.attacks === undefined) {
    const tree = await Tree.build(gw.state.leaves.map(BigInt));
    const note = (n: { noteSecret: string; nullifierSecret: string; value: string }) => ({ noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value) });
    const send = (p: object) => fetch(`${base}/api/quote`, { headers: { 'x-payment': Buffer.from(JSON.stringify(p)).toString('base64') } }).then(async (r) => ({ status: r.status, body: (await r.json()) as { reason?: string } }));
    const c1 = await ch();
    const p1 = await provePayment(note(fixture[0]), fixture[0].index, tree, BigInt(c1.payTo), BigInt(c1.requiredAmount), BigInt(c1.contextHash));
    const okPay = await send({ nonce: c1.nonce, ...p1 });
    const c2 = await ch();
    const replay = await send({ nonce: c2.nonce, proof: p1.proof, signals: { ...p1.signals, context_hash: c2.contextHash } });
    const c3 = await ch();
    const p3 = await provePayment(note(fixture[1]), fixture[1].index, tree, BigInt(c3.payTo), BigInt(c3.requiredAmount), BigInt(c3.contextHash));
    const tampered = await send({ nonce: c3.nonce, proof: p3.proof, signals: { ...p3.signals, required_amount: '1' } });
    const c3b = await ch();
    const p3b = await provePayment(note(fixture[1]), fixture[1].index, tree, BigInt(c3b.payTo), BigInt(c3b.requiredAmount), BigInt(c3b.contextHash));
    const tamperedNullifier = await send({ nonce: c3b.nonce, proof: p3b.proof, signals: { ...p3b.signals, nullifier: (BigInt(p3b.signals.nullifier) + 1n).toString() } });
    const c4 = await ch();
    const otherReq = await send({ nonce: c4.nonce, ...p3 });
    const c5 = await ch();
    const sameNoteRightReq = await provePayment(note(fixture[1]), fixture[1].index, tree, BigInt(c5.payTo), BigInt(c5.requiredAmount), BigInt(c5.contextHash));
    const okPay2 = await send({ nonce: c5.nonce, ...sameNoteRightReq });
    const c6 = await ch();
    const replayExact = await send({ nonce: c6.nonce, ...sameNoteRightReq, signals: { ...sameNoteRightReq.signals, context_hash: c6.contextHash } });
    st.attacks = {
      fixturePay1: okPay.status,
      replayWithNewContext: replay.body.reason,
      tamperedAmount: tampered.body.reason,
      tamperedNullifier: tamperedNullifier.body.reason,
      proofForAnotherRequest: otherReq.body.reason,
      fixturePay2: okPay2.status,
      replayOfSecondNote: replayExact.body.reason,
    };
    save();
  }
  say(`attacks: ${JSON.stringify(st.attacks)}`);

  // 5: anchor
  st.anchor ??= await gw.anchor();
  save();
  await mined(st.uivk.anchor, st.anchor.txid, 'anchor');
  const memo = anchorMemo(st.anchor.leaves, st.anchor.root, st.anchor.nullifiers, st.anchor.nullifierHash);
  const seen = await scan(st.uivk.anchor, st.anchor.txid, 1, memo);
  const recomputed = nullifierSetHash(Object.keys(gw.state.nullifiers)) === st.anchor.nullifierHash && (await gw.root()) === st.anchor.root;
  say(`anchor ${st.anchor.txid}: memo seen ${seen.ok}; matches the gateway's root and nullifier set ${recomputed}`);
  server.close();

  const depositSeen = await scan(st.uivk.gateway, deposit, BigInt(st.plan.amountZat), st.plan.memo);
  writeFileSync(
    resolve(ROOT, 'deployments/testnet.json'),
    JSON.stringify(
      {
        network: 'zcash-testnet',
        ranAt: new Date().toISOString(),
        note: 'Demo-only testnet wallets; incoming viewing keys published on purpose. The two fixture notes were spent in this run; their secrets are published so tests can pay against a fresh gateway.',
        unitZat: UNIT,
        priceUnits: PRICE.toString(),
        wallets: { payer: { address: st.addr.payer }, gateway: { address: st.addr.gateway, uivk: st.uivk.gateway }, anchor: { address: st.addr.anchor, uivk: st.uivk.anchor } },
        txs: { fund: st.tx.fund, deposit, anchor: st.anchor.txid },
        deposit: { txid: deposit, memo: st.plan.memo, amountZat: st.plan.amountZat, height: depositSeen.height, items, seenByGatewayKey: depositSeen.ok },
        claimed: st.claimed,
        calls,
        attacks: st.attacks,
        refusals,
        fixtureNotes: fixture.map((n: Record<string, unknown>) => ({ noteSecret: n.noteSecret, nullifierSecret: n.nullifierSecret, value: n.value, index: n.index })),
        gateway: { leaves: gw.state.leaves.length, root: await gw.root(), spent: Object.keys(gw.state.nullifiers).length, verificationKeySha256: '8e7fa586933c0bcf3a1f794d4e6ef20c688491314c45ee78a17facc04d7cd0e3' },
        anchor: { ...st.anchor, memo, memoSeen: seen.ok, matchesGatewayState: recomputed },
      },
      null,
      2,
    ) + '\n',
  );
  say('wrote deployments/testnet.json');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`FAILED: ${(e as Error).message}`);
    process.exit(1);
  },
);
