// The real gateway (packages/gateway dist/serve.js) on a fresh SQLite database, driven the way a user and
// the Kippu client drive it. The published Oct 20 deposit is claimed for real: the gateway checks it on
// Zcash testnet with its viewing key. No transaction is sent. Runs once (desktop project): one deposit,
// one database.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, REPO_ROOT, run, test, URLS } from './fixtures';

const sdk = () => import(pathToFileURL(resolve(REPO_ROOT, 'packages/sdk/dist/index.js')).href);
const gw = () => import(pathToFileURL(resolve(REPO_ROOT, 'packages/gateway/dist/index.js')).href);
const adminToken = () => readFileSync(resolve(REPO_ROOT, 'e2e/.run/admin-token'), 'utf8').trim();
const G = URLS.gateway;

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('gateway (live testnet viewing-key checks)', () => {
  // The gateway is a JSON API with no favicon; Chrome asks for one whenever it shows a gateway URL.
  test.beforeEach(({ watch }) => watch.allow(/127\.0\.0\.1:840[56]\/favicon\.ico$/, 404));
  test('a fresh gateway in Chrome: /api/info shows no notes, no anchor, and no viewing key', async ({ page }, info) => {
    await page.goto(`${G}/api/info`);
    const body = JSON.parse(await page.locator('body').innerText());
    expect(body).toMatchObject({ leaves: 0, deposits: 0, spent: 0, anchors: [], latestAnchor: null, unitZat: run.unitZat, prices: { '/api/quote': run.priceUnits, '/api/report': String(Number(run.priceUnits) * 5) } });
    expect(body.depositUa).toBe(run.wallets.gateway.address);
    expect(body.anchorUa).toBe(run.wallets.anchor.address);
    expect(JSON.stringify(body)).not.toMatch(/uivk/i);
    await page.screenshot({ path: info.outputPath('gateway-info-fresh.png') });
  });

  test('GET /api/quote in Chrome: 402 with a zec-null-402 challenge, and no anchor yet', async ({ page, watch }, info) => {
    watch.allow(/\/api\/quote$/, 402);
    const res = await page.goto(`${G}/api/quote`);
    expect(res!.status()).toBe(402);
    const c = JSON.parse(await page.locator('body').innerText()).accepts[0];
    expect(c).toMatchObject({ scheme: 'zec-null-402', network: 'zcash-testnet', requiredAmount: run.priceUnits, resource: '/api/quote', anchor: null });
    expect(c.nonce).toMatch(/^[0-9a-f]{32}$/);
    await page.screenshot({ path: info.outputPath('gateway-quote-402.png') });
    const nf = await page.request.get(`${G}/api/nothing`);
    expect(nf.status()).toBe(404);
  });

  test('a claim with one note value altered is not credited (MEMO_MISMATCH, read on testnet)', async ({ request }) => {
    const items = run.deposit.items.map((i: { secretHash: string; value: string }, k: number) => (k === 0 ? { ...i, value: '1000' } : i));
    const r = await request.post(`${G}/api/deposits`, { data: { txid: run.deposit.txid, items } });
    expect(r.status()).toBe(402);
    expect((await r.json()).error).toMatch(/not credited: .*MEMO_MISMATCH/);
  });

  test('the Kippu client claims the published deposit, then refuses to prove without an anchor it can read', async ({ request }, info) => {
    const { Z402Client, AnchorRefusedError } = await sdk();
    // A notes file holding the two fixture notes of the Oct 20 deposit (their secrets are published).
    const notesPath = info.outputPath('notes.json');
    const commitment = run.deposit.memo.replace(/^z402:/, '');
    writeFileSync(
      notesPath,
      JSON.stringify({
        type: 'zec-null-402-notes',
        gateway: G,
        plans: { [commitment]: { commitment, units: String(run.deposit.items.reduce((t: number, i: { value: string }) => t + Number(i.value), 0)), items: run.deposit.items, txid: null } },
        notes: run.fixtureNotes.map((n: Record<string, string>, i: number) => ({ ...n, index: null, deposit: commitment, nullifier: run.fixtureNullifiers[i], spent: false })),
      }),
      { mode: 0o600 },
    );
    const anchorUivk = run.wallets.anchor.uivk;
    const client = new Z402Client(G, notesPath, { anchorUivk });
    // Before the claim the notes are not credited.
    await expect(client.pay(`${G}/api/quote`)).rejects.toThrow('no unspent note of exactly 10 units');
    // The claim: the gateway reads the deposit on testnet with its viewing key and credits the 22 notes.
    const claimed = await client.claim(commitment, run.deposit.txid);
    expect(claimed).toEqual({ first: 0, count: 22, root: run.gateway.root });
    expect(client.status()).toMatchObject({ notes: 2, credited: 2, unspent: 2, unspent_units: '20' });
    await expect(client.claim(commitment, run.deposit.txid)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already claimed/) });
    // No anchor key pinned: Setup required, nothing is proved or sent.
    await expect(new Z402Client(G, notesPath, { anchorUivk: undefined }).pay(`${G}/api/quote`)).rejects.toThrow(/^Setup required: Z402_ANCHOR_UIVK/);
    // This gateway has no mined anchor of its own, so the client won't prove against its root.
    const err = await client.pay(`${G}/api/quote`).catch((e: Error) => e);
    expect(err).toBeInstanceOf(AnchorRefusedError);
    expect((err as InstanceType<typeof AnchorRefusedError>).code).toBe('UNANCHORED_ROOT');
    const after = await (await request.get(`${G}/api/info`)).json();
    expect(after).toMatchObject({ leaves: 22, deposits: 1, spent: 0, root: run.gateway.root });
    expect(client.status().unspent).toBe(2);
  });

  test('X-PAYMENT that is not a proof is refused with the gateway codes', async ({ request }) => {
    const notB64 = await request.get(`${G}/api/quote`, { headers: { 'x-payment': '%%%' } });
    expect(notB64.status()).toBe(400);
    expect((await notB64.json()).error).toBe('X-PAYMENT is not base64 JSON');
    const c = (await (await request.get(`${G}/api/quote`)).json()).accepts[0];
    const junk = Buffer.from(JSON.stringify({ nonce: c.nonce, proof: {}, signals: ['01', '2'] })).toString('base64');
    const r = await request.get(`${G}/api/quote`, { headers: { 'x-payment': junk } });
    expect(r.status()).toBe(402);
    expect((await r.json()).reason).toBe('MALFORMED_SIGNALS');
    const big = await request.post(`${G}/api/deposits`, { data: { txid: run.deposit.txid, items: [], pad: 'x'.repeat(70_000) } });
    expect(big.status()).toBe(413);
  });

  test('anchoring over HTTP: Setup required without Z402_ADMIN_TOKEN; with one, the token and then the wallet are required', async ({ request }) => {
    const none = await request.post(`${G}/api/anchor`);
    expect(none.status()).toBe(503);
    expect((await none.json()).error).toBe('Setup required: Z402_ADMIN_TOKEN (anchoring over HTTP is off without it)');
    const A = URLS.gatewayAdmin;
    const noBearer = await request.post(`${A}/api/anchor`);
    expect(noBearer.status()).toBe(401);
    const wrong = await request.post(`${A}/api/anchor`, { headers: { authorization: 'Bearer not-the-token' } });
    expect(wrong.status()).toBe(401);
    const right = await request.post(`${A}/api/anchor`, { headers: { authorization: `Bearer ${adminToken()}` } });
    expect(right.status()).toBe(503);
    expect((await right.json()).error).toBe('Setup required: anchoring needs the gateway wallet');
  });

  test('the anchor the dashboard shows is the memo on-chain: read from lightwalletd with the published anchor key', async ({ page }, info) => {
    const { readAnchor } = await gw();
    const a = await readAnchor(run.wallets.anchor.uivk, run.anchor.txid);
    expect(a.found).toBe(true);
    expect(a.height).toBeGreaterThan(run.deposit.height);
    expect(a.anchors).toEqual([{ leaves: run.anchor.leaves, root: run.anchor.root, nullifiers: run.anchor.nullifiers, nullifierHash: run.anchor.nullifierHash }]);
    await page.goto(`${URLS.dashboard}/#anchor`);
    await expect(page.locator('#anchor code.memo')).toHaveText(`z402:anchor:${a.anchors[0].leaves}:${a.anchors[0].root}:${a.anchors[0].nullifiers}:${a.anchors[0].nullifierHash}`);
    await expect(page.locator('.check')).toHaveClass(/is-ok/);
    await page.locator('#anchor').screenshot({ path: info.outputPath('dash-anchor-matches-chain.png') });
  });

  test('a gateway started without its keys exits with Setup required', async () => {
    const env = { PATH: process.env.PATH ?? '', Z402_STATE: resolve(REPO_ROOT, 'e2e/.run/never.db') };
    const r = spawnSync(process.execPath, [resolve(REPO_ROOT, 'packages/gateway/dist/serve.js')], { env, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe('Setup required: Z402_DEPOSIT_UA');
  });

  test('the agent call log: the real MCP server writes one Z402_MCP_LOG line per tool call, refusals included', async ({ request }, info) => {
    const mcpSdk = resolve(REPO_ROOT, 'packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client');
    const { Client } = await import(pathToFileURL(`${mcpSdk}/index.js`).href);
    const { StdioClientTransport } = await import(pathToFileURL(`${mcpSdk}/stdio.js`).href);
    const commitment = run.deposit.memo.replace(/^z402:/, '');
    const notesPath = info.outputPath('agent-notes.json');
    const logPath = info.outputPath('agent-mcp-log.jsonl');
    writeFileSync(
      notesPath,
      JSON.stringify({
        type: 'zec-null-402-notes',
        gateway: G,
        plans: { [commitment]: { commitment, units: '220', items: run.deposit.items, txid: run.deposit.txid } },
        notes: run.fixtureNotes.map((n: Record<string, string>, i: number) => ({ ...n, index: Number(n.index), deposit: commitment, nullifier: run.fixtureNullifiers[i], spent: false })),
      }),
      { mode: 0o600 },
    );
    // No Z402_WALLET: the agent cannot spend. The anchor key is the published one.
    const env = { PATH: process.env.PATH ?? '', Z402_GATEWAY_URL: G, Z402_NOTES_FILE: notesPath, Z402_MCP_LOG: logPath, Z402_ANCHOR_UIVK: run.wallets.anchor.uivk, Z402_ANCHOR_WAIT_SEC: '0', Z402_CLAIM_WAIT_SEC: '0' };
    const mcp = new Client({ name: 'kippu-e2e', version: '0.0.0' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(REPO_ROOT, 'packages/mcp/dist/main.js')], env }));
    try {
      const tools = (await mcp.listTools()).tools.map((t: { name: string }) => t.name).sort();
      expect(tools).toEqual(['claim', 'deposit', 'pay', 'status']);
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = await mcp.callTool({ name, arguments: args });
        return { isError: !!r.isError, text: (r.content as { text: string }[])[0].text };
      };
      const status = await call('status');
      expect(status.isError).toBe(false);
      expect(JSON.parse(status.text)).toMatchObject({ wallet: { credited: 2, unspent: 2, unspent_units: '20' }, gateway: { leaves: 22, spent: 0 } });
      expect(status.text).not.toMatch(/noteSecret|nullifierSecret|uivk/);
      expect(await call('deposit', { count: 5, units: 10 })).toEqual({ isError: true, text: 'Setup required: Z402_WALLET' });
      const again = await call('claim', { plan: commitment, txid: run.deposit.txid });
      expect(again.isError).toBe(true);
      expect(again.text).toMatch(/already claimed/);
      const pay = await call('pay', { url: `${G}/api/quote` });
      expect(pay.isError).toBe(true);
      expect(pay.text).toMatch(/^refusing to pay: UNANCHORED_ROOT/);
    } finally {
      await mcp.close();
    }
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.tool, l.isError])).toEqual([['status', false], ['deposit', true], ['claim', true], ['pay', true]]);
    for (const l of lines) expect(Object.keys(l)).toEqual(['at', 'tool', 'args', 'isError', 'result']);
    expect(readFileSync(logPath, 'utf8')).not.toMatch(/noteSecret|nullifierSecret/);
    // Nothing was paid or deposited.
    expect(await (await request.get(`${G}/api/info`)).json()).toMatchObject({ deposits: 1, spent: 0 });
  });

  test('Chrome after the claim: /api/info shows the 22 credited notes and the published root, none spent', async ({ page }, info) => {
    await page.goto(`${G}/api/info`);
    const body = JSON.parse(await page.locator('body').innerText());
    expect(body).toMatchObject({ leaves: run.gateway.leaves, deposits: 1, spent: 0, root: run.gateway.root });
    const leaves = (await (await page.request.get(`${G}/api/leaves`)).json()) as { leaves: string[]; root: string };
    expect(leaves.leaves).toHaveLength(22);
    expect(leaves.root).toBe(run.gateway.root);
    await page.screenshot({ path: info.outputPath('gateway-info-claimed.png') });
  });
});
