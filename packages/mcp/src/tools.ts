// MCP tools for an agent paying per call with prepaid shielded notes.
//   Z402_GATEWAY_URL   gateway (default http://127.0.0.1:8405)
//   Z402_NOTES_FILE    the agent's note secrets (0600; never returned by a tool)
//   Z402_WALLET        the agent's zingo data dir (deposit only)
//   Z402_MAX_DEPOSIT_ZAT  cap on one deposit (default 300000)
//   Z402_MAX_TOTAL_DEPOSIT_ZAT  optional cap on all deposits this notes file has sent, together
//   Z402_MCP_LOG       one JSON line per call (0600: it links deposits to calls)
//   Z402_ANCHOR_UIVK   the anchor address's published viewing key (pay proves only against a root read
//                      on-chain with it); Z402_MAX_ANCHOR_AGE_BLOCKS (default 2880); Z402_LWD_URL;
//                      Z402_ANCHOR_WAIT_SEC (default 900): how long pay waits for the next anchor,
//                      asking again every Z402_ANCHOR_POLL_SEC (default 20)
//   Z402_CLAIM_WAIT_SEC   how long claim waits for the deposit to be mined (default 900)
//   Z402_ANCHOR_PUBKEY    the gateway's anchor signing key (64 hex), pinned from its deployment record:
//                         pay then needs anchors signed by it and ignores other memos on the anchor address
//   Z402_REPLAY_AT_HEIGHT replays a published run as the chain stood at this height (fixed scan range);
//                         blank for a live gateway
import { closeSync, fchmodSync, openSync, writeSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { intEnv, quicksend, SetupRequiredError, zingoConfig } from '@z402/gateway';
import { AnchorRefusedError, Z402Client } from '@z402/sdk';

const WAIT_FOR_ANCHOR = new Set(['NOTE_NOT_ANCHORED', 'ANCHOR_TOO_OLD', 'ANCHOR_NOT_CONFIRMED']);
const need = (k: string) => process.env[k] || (() => { throw new SetupRequiredError(k); })();
// One client per gateway and notes file, so its scan of the anchor address is reused between calls.
let cached: { key: string; c: Z402Client } | null = null;
const client = () => {
  const key = `${process.env.Z402_GATEWAY_URL ?? 'http://127.0.0.1:8405'}\n${need('Z402_NOTES_FILE')}`;
  if (cached?.key !== key) cached = { key, c: new Z402Client(process.env.Z402_GATEWAY_URL ?? 'http://127.0.0.1:8405', need('Z402_NOTES_FILE')) };
  return cached.c;
};

/**
 * The call log ties each deposit (plan, txid) to the nullifiers and times of later calls: exactly the
 * linkage the protocol hides from the gateway. It is created 0600, and an existing log is made 0600.
 */
function log(tool: string, args: unknown, isError: boolean, result: unknown) {
  const f = process.env.Z402_MCP_LOG;
  if (!f) return;
  const fd = openSync(f, 'a', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify({ at: new Date().toISOString(), tool, args, isError, result }) + '\n');
  } finally {
    closeSync(fd);
  }
}
async function run(tool: string, args: unknown, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    log(tool, args, false, result);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }] };
  } catch (e) {
    const text = (e as Error).message;
    log(tool, args, true, text);
    return { isError: true, content: [{ type: 'text' as const, text }] };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'zec-null-402', version: '0.1.0' });

  server.registerTool(
    'status',
    { title: 'Prepaid notes', description: 'How many notes the agent holds, credited and unspent, and the gateway’s tree size, spent count and anchors. Never returns note secrets. Read-only.', annotations: { readOnlyHint: true } },
    () => run('status', {}, async () => ({ wallet: client().status(), gateway: await client().info() })),
  );

  server.registerTool(
    'deposit',
    {
      title: 'Prepay notes with one shielded deposit',
      description: 'Creates `count` notes of `units` each, sends ONE shielded deposit to the gateway with memo z402:<commitment> from the agent wallet, and returns the plan id and txid. Call `claim` once it is mined. Spends real testnet funds. Refused above Z402_MAX_DEPOSIT_ZAT for one deposit, or above Z402_MAX_TOTAL_DEPOSIT_ZAT for all of them together.',
      inputSchema: { count: z.number().int().min(1).max(64), units: z.number().int().positive() },
    },
    (a) =>
      run('deposit', a, async () => {
        // The wallet and the cap are checked before notes are created. The wallet's balance is checked only
        // by zingo-cli when it sends; if it refuses (nothing was sent), the unfunded plan is dropped.
        const wallet = need('Z402_WALLET');
        const c = client();
        const info = await c.info();
        const max = BigInt(intEnv('Z402_MAX_DEPOSIT_ZAT', 300_000, { min: 1 }));
        const total = BigInt(a.count) * BigInt(a.units) * BigInt(info.unitZat);
        if (total > max) throw new Error(`refused: deposit of ${total} zat is above Z402_MAX_DEPOSIT_ZAT (${max})`);
        // optional budget over every deposit this notes file has sent or is sending (0 or unset: none). It is
        // checked and reserved inside the plan's notes-file lock, so two deposits at once cannot both pass it.
        const budget = BigInt(intEnv('Z402_MAX_TOTAL_DEPOSIT_ZAT', 0));
        const p = await c.plan(a.count, BigInt(a.units), budget > 0n ? { maxTotalZat: budget, budgetName: 'Z402_MAX_TOTAL_DEPOSIT_ZAT' } : {});
        let txid: string;
        try {
          [txid] = await quicksend(zingoConfig(), wallet, [{ address: p.address, amount: p.amountZat, memo: p.memo }]);
        } catch (e) {
          // Only a send the wallet refused for lack of funds certainly sent nothing; any other failure keeps
          // the plan (and its share of the budget), since the transaction may have gone out.
          if (/Insufficient balance/.test((e as Error).message)) await c.dropPlan(p.plan);
          throw e;
        }
        // Saved at once: if this tool's answer is lost, the notes file still ties the funds to the plan.
        await c.recordDeposit(p.plan, txid);
        return { plan: p.plan, txid, amount_zat: p.amountZat.toString(), notes: a.count };
      }),
  );

  server.registerTool(
    'claim',
    {
      title: 'Claim a deposit',
      description: 'Asks the gateway to credit the notes of a deposit (it checks the deposit with its viewing key). If the deposit is not mined yet, waits for it (up to Z402_CLAIM_WAIT_SEC, default 900 s) instead of failing.',
      inputSchema: { plan: z.string().regex(/^[0-9a-f]{64}$/), txid: z.string().regex(/^[0-9a-f]{64}$/) },
    },
    (a) =>
      run('claim', a, async () => {
        const deadline = Date.now() + intEnv('Z402_CLAIM_WAIT_SEC', 900) * 1000;
        for (;;) {
          try {
            return await client().claim(a.plan, a.txid);
          } catch (e) {
            // 425: the gateway saw no mined deposit yet. Anything else is a real refusal.
            if ((e as { status?: number }).status !== 425 || Date.now() > deadline) throw e;
            await new Promise((r) => setTimeout(r, 20_000));
          }
        }
      }),
  );

  server.registerTool(
    'pay',
    { title: 'Fetch a paid URL', description: 'GETs `url`; on a zec-null-402 402 it pays with a zero-knowledge proof of one unspent note of the price. No transaction per call. Talks only to Z402_GATEWAY_URL: a URL on any other origin is never fetched (no request is sent there and no redirect is followed), and only a challenge for the path requested is paid. Proves only against a root it has read itself in a recent on-chain anchor; if every note of the price was credited after the latest anchor, or the anchor is too old or not yet confirmed, waits for the gateway’s next one (up to Z402_ANCHOR_WAIT_SEC, default 900 s).', inputSchema: { url: z.string().url() } },
    (a) =>
      run('pay', a, async () => {
        const deadline = Date.now() + intEnv('Z402_ANCHOR_WAIT_SEC', 900) * 1000;
        const poll = intEnv('Z402_ANCHOR_POLL_SEC', 20, { min: 1 }) * 1000;
        let r;
        for (;;) {
          try {
            r = await client().pay(a.url);
            break;
          } catch (e) {
            // Worth waiting for, because the gateway's next anchor fixes them (nothing was proven): notes newer
            // than the latest anchor, an anchor too old for the window, or one not yet confirmed.
            if (!(e instanceof AnchorRefusedError && WAIT_FOR_ANCHOR.has(e.code)) || Date.now() + poll > deadline) throw e;
            await new Promise((res) => setTimeout(res, poll));
          }
        }
        if (r.status !== 200) throw new Error(`payment refused (HTTP ${r.status}): ${JSON.stringify(r.body)}`);
        return { status: r.status, nullifier: r.nullifier, prove_ms: r.proveMs, anchor: r.anchor, data: (r.body as { data?: unknown }).data };
      }),
  );
  return server;
}
