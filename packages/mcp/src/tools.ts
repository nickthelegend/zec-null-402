// MCP tools for an agent paying per call with prepaid shielded notes.
//   Z402_GATEWAY_URL   gateway (default http://127.0.0.1:8405)
//   Z402_NOTES_FILE    the agent's note secrets (0600; never returned by a tool)
//   Z402_WALLET        the agent's zingo data dir (deposit only)
//   Z402_MAX_DEPOSIT_ZAT  cap on one deposit (default 300000)
//   Z402_MCP_LOG       one JSON line per call
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { quicksend, SetupRequiredError, zingoConfig } from '@z402/gateway';
import { Z402Client } from '@z402/sdk';

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
        const c = client();
        const p = await c.plan(a.count, BigInt(a.units));
        const max = BigInt(process.env.Z402_MAX_DEPOSIT_ZAT ?? 300_000);
        if (p.amountZat > max) throw new Error(`refused: deposit of ${p.amountZat} zat is above Z402_MAX_DEPOSIT_ZAT (${max})`);
        const [txid] = await quicksend(zingoConfig(), need('Z402_WALLET'), [{ address: p.address, amount: p.amountZat, memo: p.memo }]);
        return { plan: p.plan, txid, amount_zat: p.amountZat.toString(), notes: a.count };
      }),
  );

  server.registerTool(
    'claim',
    { title: 'Claim a mined deposit', description: 'Asks the gateway to credit the notes of a mined deposit (it checks the deposit with its viewing key).', inputSchema: { plan: z.string().regex(/^[0-9a-f]{64}$/), txid: z.string().regex(/^[0-9a-f]{64}$/) } },
    (a) => run('claim', a, () => client().claim(a.plan, a.txid)),
  );

  server.registerTool(
    'pay',
    { title: 'Fetch a paid URL', description: 'GETs `url`; on a zec-null-402 402 it pays with a zero-knowledge proof of one unspent note of the price. No transaction per call.', inputSchema: { url: z.string().url() } },
    (a) =>
      run('pay', a, async () => {
        const r = await client().pay(a.url);
        if (r.status !== 200) throw new Error(`payment refused (HTTP ${r.status}): ${JSON.stringify(r.body)}`);
        return { status: r.status, nullifier: r.nullifier, prove_ms: r.proveMs, data: (r.body as { data?: unknown }).data };
      }),
  );
  return server;
}
