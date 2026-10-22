// Real MCP client ↔ z402-mcp (stdio) ↔ a fresh gateway over HTTP that credited the real published
// deposit (testnet) ↔ real proofs.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  // the client proves only against an anchored root: the run's real anchor (Oct 20) and a window that still covers it
  const a = await readAnchor(d.wallets.anchor.uivk, d.anchor.txid);
  anchorEnv = { Z402_ANCHOR_UIVK: d.wallets.anchor.uivk, Z402_MAX_ANCHOR_AGE_BLOCKS: String(a.tip - a.height! + 10) };
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

  it('deposit without a wallet: Setup required', async () => {
    const r = await call('deposit', { count: 2, units: 10 });
    expect(r).toMatchObject({ isError: true, text: 'Setup required: Z402_WALLET' });
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
