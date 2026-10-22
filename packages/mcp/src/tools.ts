// MCP tools for an agent paying per call with prepaid shielded notes.
//   Z402_GATEWAY_URL   gateway (default http://127.0.0.1:8405)
//   Z402_NOTES_FILE    the agent's note secrets (0600; never returned by a tool)
//   Z402_WALLET        the agent's zingo data dir (deposit only)
//   Z402_MAX_DEPOSIT_ZAT  cap on one deposit (default 300000)
//   Z402_MCP_LOG       one JSON line per call
//   Z402_ANCHOR_UIVK   the anchor address's published viewing key (pay proves only against a root read
//                      on-chain with it); Z402_MAX_ANCHOR_AGE_BLOCKS (default 2880); Z402_LWD_URL;
//                      Z402_ANCHOR_WAIT_SEC (default 900): how long pay waits for the next anchor
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { intEnv, quicksend, SetupRequiredError, zingoConfig } from '@z402/gateway';
import { AnchorRefusedError, Z402Client } from '@z402/sdk';

const need = (k: string) => process.env[k] || (() => { throw new SetupRequiredError(k); })();
const client = () => new Z402Client(process.env.Z402_GATEWAY_URL ?? 'http://127.0.0.1:8405', need('Z402_NOTES_FILE'));

function log(tool: string, args: unknown, isError: boolean, result: unknown) {
  const f = process.env.Z402_MCP_LOG;
  if (f) appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), tool, args, isError, result }) + '\n');
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
      description: 'Creates `count` notes of `units` each, sends ONE shielded deposit to the gateway with memo z402:<commitment> from the agent wallet, and returns the plan id and txid. Call `claim` once it is mined. Spends real testnet funds.',
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
        const p = await c.plan(a.count, BigInt(a.units));
        let txid: string;
        try {
          [txid] = await quicksend(zingoConfig(), wallet, [{ address: p.address, amount: p.amountZat, memo: p.memo }]);
        } catch (e) {
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
    { title: 'Fetch a paid URL', description: 'GETs `url`; on a zec-null-402 402 it pays with a zero-knowledge proof of one unspent note of the price. No transaction per call. Talks only to Z402_GATEWAY_URL: a URL on any other origin is never fetched (no request is sent there and no redirect is followed), and only a challenge for the path requested is paid. Proves only against a root it has read itself in a recent on-chain anchor; if every note of the price was credited after the latest anchor, waits for the next one (up to Z402_ANCHOR_WAIT_SEC, default 900 s).', inputSchema: { url: z.string().url() } },
    (a) =>
      run('pay', a, async () => {
        const deadline = Date.now() + intEnv('Z402_ANCHOR_WAIT_SEC', 900) * 1000;
        let r;
        for (;;) {
          try {
            r = await client().pay(a.url);
            break;
          } catch (e) {
            // Only "your notes are newer than the latest anchor" is worth waiting for; nothing was proven.
            if (!(e instanceof AnchorRefusedError && e.code === 'NOTE_NOT_ANCHORED') || Date.now() > deadline) throw e;
            await new Promise((res) => setTimeout(res, 20_000));
          }
        }
        if (r.status !== 200) throw new Error(`payment refused (HTTP ${r.status}): ${JSON.stringify(r.body)}`);
        return { status: r.status, nullifier: r.nullifier, prove_ms: r.proveMs, anchor: r.anchor, data: (r.body as { data?: unknown }).data };
      }),
  );
  return server;
}
