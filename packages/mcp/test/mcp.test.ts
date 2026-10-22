// Real MCP client ↔ z402-mcp (stdio) ↔ a fresh gateway over HTTP that credited the real published
// deposit (testnet) ↔ real proofs.
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nullifierOf } from '@z402/circuits';
import { Gateway, readAnchor, scanBinary, serveGateway } from '@z402/gateway';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'z402-mcp-'));
let base = '';
let client: Client;
let close = () => {};
let gw: Gateway;
let anchorEnv: Record<string, string> = {};
const call = async (name: string, args: Record<string, unknown> = {}, c = client) => {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: r.isError, text: r.content[0].text };
};
const connect = async (extra: Record<string, string>) => {
  const c = new Client({ name: 't', version: '0' });
  await c.connect(new StdioClientTransport({ command: resolve(__dirname, '../node_modules/.bin/tsx'), args: [resolve(__dirname, '../src/main.ts')], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', Z402_SCAN_BIN: scanBinary(), ...extra } }));
  return c;
};

beforeAll(async () => {
  gw = new Gateway({ statePath: join(dir, 'state.db'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': 10n }, content: (p) => ({ served: p }), anchorUivk: d.wallets.anchor.uivk });
  // the client proves only against an anchored root: the run's real anchor (Oct 20), replayed as the chain
  // stood 10 blocks after it (a fixed scan range) with the default window
  const a = await readAnchor(d.wallets.anchor.uivk, d.anchor.txid);
  anchorEnv = { Z402_ANCHOR_UIVK: d.wallets.anchor.uivk, Z402_REPLAY_AT_HEIGHT: String(a.height! + 10) };
  const s = serveGateway(gw);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  close = () => (s.close(), gw.close());
  const items = d.deposit.items as { secretHash: string; value: string }[];
  const { commitmentOf } = await import('@z402/circuits');
  const plan = commitmentOf(items);
  const fixture = await Promise.all(d.fixtureNotes.map(async (n: Record<string, string>) => ({ ...n, index: null, deposit: plan, spent: false, nullifier: (await nullifierOf({ noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value) })).toString() })));
  writeFileSync(join(dir, 'notes.json'), JSON.stringify({ type: 'zec-null-402-notes', gateway: base, plans: { [plan]: { commitment: plan, units: '220', items, txid: null } }, notes: fixture }), { mode: 0o600 });
  client = await connect({ Z402_GATEWAY_URL: base, Z402_NOTES_FILE: join(dir, 'notes.json'), ...anchorEnv });
}, 120_000);
afterAll(async () => {
  await client?.close();
  close();
});

describe('z402-mcp', () => {
  it('lists status, deposit, claim, pay', async () => {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['claim', 'deposit', 'pay', 'status']);
  });

  it('claim credits the real deposit (testnet viewing-key check); a second claim is refused', async () => {
    const plan = Object.keys(JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf8')).plans)[0];
    const r = await call('claim', { plan, txid: d.deposit.txid });
    expect(r.isError, r.text).toBeFalsy();
    expect(JSON.parse(r.text)).toMatchObject({ first: 0, count: 22, root: d.gateway.root });
    const again = await call('claim', { plan, txid: d.deposit.txid });
    expect(again).toMatchObject({ isError: true });
    expect(again.text).toMatch(/already claimed/);
    await gw.adoptAnchor(d.anchor.txid);
  });

  it('pay with a proof against the anchored root (none without the anchor key); status never shows a secret', async () => {
    // the client indexed its notes in plan order; the two fixture notes sit at their published indices
    const f = JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf8'));
    f.notes.forEach((n: { index: number | null }, i: number) => (n.index = Number(d.fixtureNotes[i].index)));
    writeFileSync(join(dir, 'notes.json'), JSON.stringify(f), { mode: 0o600 });
    // without the anchor viewing key the tool does not prove
    const keyless = await connect({ Z402_GATEWAY_URL: base, Z402_NOTES_FILE: join(dir, 'notes.json') });
    try {
      expect(await call('pay', { url: `${base}/api/quote` }, keyless)).toMatchObject({ isError: true, text: expect.stringMatching(/^Setup required: Z402_ANCHOR_UIVK/) });
    } finally {
      await keyless.close();
    }
    const r = await call('pay', { url: `${base}/api/quote` });
    expect(r.isError, r.text).toBeFalsy();
    expect(JSON.parse(r.text)).toMatchObject({ status: 200, data: { served: '/api/quote' } });
    const s = await call('status');
    expect(JSON.parse(s.text).gateway).toMatchObject({ leaves: 22, spent: 1, latestAnchor: { txid: d.anchor.txid } });
    for (const n of d.fixtureNotes) expect(s.text).not.toContain(n.noteSecret);
  });

  it('pay waits for a fresh anchor when the newest one is too old for the window (ANCHOR_TOO_OLD), then reports it', async () => {
    // the default 2,880-block window refuses the Oct 20 anchor; pay keeps asking until Z402_ANCHOR_WAIT_SEC runs out
    const challenges = () => gw.challengesIssued;
    const before = challenges();
    const c = await connect({ Z402_GATEWAY_URL: base, Z402_NOTES_FILE: join(dir, 'notes.json'), Z402_ANCHOR_UIVK: d.wallets.anchor.uivk, Z402_ANCHOR_WAIT_SEC: '8', Z402_ANCHOR_POLL_SEC: '1' });
    try {
      const t0 = Date.now();
      const r = await call('pay', { url: `${base}/api/quote` }, c);
      expect(r).toMatchObject({ isError: true, text: expect.stringMatching(/ANCHOR_TOO_OLD/) });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1000); // at least one poll of 1 s; it never sleeps past the 8 s deadline
      expect(challenges() - before).toBeGreaterThanOrEqual(2); // asked again (the old tool gave up after one)
    } finally {
      await c.close();
    }
    expect(Object.keys(gw.state.nullifiers)).toHaveLength(1);
  });

  it('deposit without a wallet: Setup required', async () => {
    const r = await call('deposit', { count: 2, units: 10 });
    expect(r).toMatchObject({ isError: true, text: 'Setup required: Z402_WALLET' });
  });

  it('Z402_MAX_TOTAL_DEPOSIT_ZAT caps what one notes file deposits in all (the per-deposit cap alone let an agent drain its wallet)', async () => {
    // notes.json already holds the claimed 220,000 zat deposit; 2 x 10 units more would make 240,000
    const plans = () => Object.keys(JSON.parse(readFileSync(join(dir, 'notes.json'), 'utf8')).plans).length;
    const before = plans();
    const c = await connect({ Z402_GATEWAY_URL: base, Z402_NOTES_FILE: join(dir, 'notes.json'), Z402_WALLET: mkdtempSync(join(tmpdir(), 'z402-mcp-nowallet-')), Z402_ZINGO_CLI: join(dir, 'no-zingo-cli-here'), Z402_MAX_DEPOSIT_ZAT: '40000', Z402_MAX_TOTAL_DEPOSIT_ZAT: '230000', ...anchorEnv });
    try {
      expect(await call('deposit', { count: 2, units: 10 }, c)).toEqual({ isError: true, text: 'refused: deposits from this notes file would total 240000 zat, above Z402_MAX_TOTAL_DEPOSIT_ZAT (230000); 220000 zat already deposited or being sent' });
      expect(plans()).toBe(before);
    } finally {
      await c.close();
    }
  });

  it('Z402_MAX_TOTAL_DEPOSIT_ZAT holds for two deposits at once: the budget is reserved with the plan, so only one is sent', async () => {
    // a local stand-in for zingo-cli (not an external API): it records each send, takes 2 s, and prints a txids line
    const sends = join(dir, 'sends.log');
    const cli = join(dir, 'slow-zingo-cli.sh');
    writeFileSync(cli, `#!/bin/sh\necho send >> '${sends}'\nsleep 2\necho '{"txids": ["'$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n')'"]}'\n`);
    chmodSync(cli, 0o755);
    const notes = join(dir, 'budget-notes.json');
    const c = await connect({ Z402_GATEWAY_URL: base, Z402_NOTES_FILE: notes, Z402_WALLET: mkdtempSync(join(tmpdir(), 'z402-mcp-slowwallet-')), Z402_ZINGO_CLI: cli, Z402_MAX_DEPOSIT_ZAT: '40000', Z402_MAX_TOTAL_DEPOSIT_ZAT: '20000', ...anchorEnv });
    try {
      const [a, b] = await Promise.all([call('deposit', { count: 2, units: 10 }, c), call('deposit', { count: 2, units: 10 }, c)]);
      const ok = [a, b].filter((r) => !r.isError);
      const refused = [a, b].filter((r) => r.isError);
      expect(ok, JSON.stringify([a, b])).toHaveLength(1);
      expect(JSON.parse(ok[0].text)).toMatchObject({ amount_zat: '20000', txid: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(refused[0].text).toMatch(/^refused: deposits from this notes file would total 40000 zat, above Z402_MAX_TOTAL_DEPOSIT_ZAT \(20000\)/);
      expect(readFileSync(sends, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(Object.keys(JSON.parse(readFileSync(notes, 'utf8')).plans)).toHaveLength(1);
    } finally {
      await c.close();
    }
  }, 60_000);

  it('the call log (Z402_MCP_LOG) is private (0600): it links deposit txids to the nullifiers of later calls', async () => {
    const fresh = join(dir, 'calls.log');
    const old = join(dir, 'calls-old.log');
    writeFileSync(old, '', { mode: 0o644 });
    chmodSync(old, 0o644);
    for (const log of [fresh, old]) {
      const c = await connect({ Z402_GATEWAY_URL: base, Z402_NOTES_FILE: join(dir, 'notes.json'), Z402_MCP_LOG: log, ...anchorEnv });
      try {
        expect((await call('status', {}, c)).isError).toBeFalsy();
      } finally {
        await c.close();
      }
      expect(statSync(log).mode & 0o777, log).toBe(0o600);
      expect(readFileSync(log, 'utf8')).toContain('"tool":"status"');
    }
  });

  it('a malformed cap or wait setting is Setup required, never NaN (no endless wait, no unchecked cap)', async () => {
    const dirW = mkdtempSync(join(tmpdir(), 'z402-mcp-nowallet-'));
    const c = await connect({ Z402_GATEWAY_URL: base, Z402_NOTES_FILE: join(dir, 'cfg-notes.json'), Z402_WALLET: dirW, Z402_MAX_DEPOSIT_ZAT: '40,000', Z402_CLAIM_WAIT_SEC: 'soon', Z402_ANCHOR_WAIT_SEC: '-1', ...anchorEnv });
    try {
      expect(await call('deposit', { count: 1, units: 10 }, c)).toMatchObject({ isError: true, text: expect.stringMatching(/^Setup required: Z402_MAX_DEPOSIT_ZAT/) });
      expect(await call('claim', { plan: 'a'.repeat(64), txid: 'b'.repeat(64) }, c)).toMatchObject({ isError: true, text: expect.stringMatching(/^Setup required: Z402_CLAIM_WAIT_SEC/) });
      expect(await call('pay', { url: `${base}/api/quote` }, c)).toMatchObject({ isError: true, text: expect.stringMatching(/^Setup required: Z402_ANCHOR_WAIT_SEC/) });
    } finally {
      await c.close();
    }
  });
});
