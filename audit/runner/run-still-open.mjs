#!/usr/bin/env node
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const deploymentsTestnet = JSON.parse(fs.readFileSync(path.join(root, 'deployments/testnet.json'), 'utf8'));

// Exit cleanly and kill any children
function cleanup(stackStarted) {
  if (stackStarted) {
    try {
      execSync('./e2e/stack.sh stop', { cwd: root, stdio: 'inherit' });
    } catch {}
  }
}

async function main() {
  console.log('=== Running still-open audit rows ===\n');

  // -------------------------------------------------------------
  // 1. API-DEPOSITS-503-MAX-SCANS
  // -------------------------------------------------------------
  console.log('1. Testing API-DEPOSITS-503-MAX-SCANS...');
  let stackStarted = false;
  try {
    try { execSync('./e2e/stack.sh stop', { cwd: root, stdio: 'ignore' }); } catch {}
    execSync('./e2e/stack.sh', { cwd: root, stdio: 'inherit' });
    stackStarted = true;

    const item503 = {
      id: 'API-DEPOSITS-503-MAX-SCANS',
      url: 'http://127.0.0.1:8405/api/info',
      width: 1280,
      height: 800,
      outDir: 'full',
      allowStatuses: [503, 402],
      assert: [
        `Promise.all(Array.from({ length: 40 }, (_, i) => {
          const fakeTx = '00'.repeat(31) + i.toString(16).padStart(2, '0');
          return fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: fakeTx, items: [{ secretHash: '123', value: '10' }] }) })
            .then(async r => ({ status: r.status, retry: r.headers.get('retry-after'), body: await r.json().catch(() => ({})) }));
        })).then(rs => {
          const busy = rs.filter(r => r.status === 503);
          if (busy.length === 0) return 'expected at least one 503 from max scans concurrency, got none';
          for (const b of busy) {
            if (!/busy: .* deposit checks are running/.test(b.body.error)) return 'expected busy in error message: ' + b.body.error;
            if (b.retry !== '5') return 'expected retry-after: 5';
          }
          return true;
        })`,
      ],
      evaluateActual: `(async () => {
        const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => {
          const fakeTx = '00'.repeat(31) + i.toString(16).padStart(2, '0');
          return fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: fakeTx, items: [{ secretHash: '123', value: '10' }] }) })
            .then(async r => ({ status: r.status, retry: r.headers.get('retry-after'), error: (await r.json().catch(() => ({}))).error }));
        }));
        const busy = rs.filter(r => r.status === 503);
        return 'HTTP 503 with JSON error "' + busy[0]?.error + '" and header "retry-after: ' + busy[0]?.retry + '"';
      })()`,
    };

    const capProc = spawn('node', [path.join(root, 'audit/runner/capture.mjs'), JSON.stringify(item503)], {
      cwd: root,
      stdio: 'inherit',
    });

    const capCode = await new Promise((res) => capProc.on('exit', res));
    if (capCode !== 0) {
      throw new Error(`API-DEPOSITS-503-MAX-SCANS capture failed with exit code ${capCode}`);
    }

    const ev503JsonPath = path.join(root, 'audit/evidence/full/API-DEPOSITS-503-MAX-SCANS.json');
    const ev503 = JSON.parse(fs.readFileSync(ev503JsonPath, 'utf8'));
    if (!ev503.ok) {
      throw new Error(`API-DEPOSITS-503-MAX-SCANS reported ok: false in evidence: ${JSON.stringify(ev503.failures)}`);
    }
    console.log('✓ API-DEPOSITS-503-MAX-SCANS: PASS\n');
  } finally {
    cleanup(stackStarted);
  }

  // -------------------------------------------------------------
  // 2. MCP rows setup
  // -------------------------------------------------------------
  console.log('2. Setting up fresh Gateway for MCP rows...');
  const { Gateway, serveGateway, scanBinary } = await import(path.join(root, 'packages/gateway/dist/index.js'));
  const { commitmentOf } = await import(path.join(root, 'packages/circuits/dist/index.js'));
  const { Client } = await import(path.join(root, 'packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'));
  const { StdioClientTransport } = await import(path.join(root, 'packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'));

  const mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z402-audit-mcp-'));
  const gw = new Gateway({
    statePath: path.join(mcpDir, 'state.db'),
    depositUa: deploymentsTestnet.wallets.gateway.address,
    depositUivk: deploymentsTestnet.wallets.gateway.uivk,
    unitZat: deploymentsTestnet.unitZat,
    prices: { '/api/quote': 10n },
    content: (p) => ({ served: p }),
    anchorUivk: deploymentsTestnet.wallets.anchor.uivk,
  });
  const server = serveGateway(gw);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const gwPort = server.address().port;
  const gwUrl = `http://127.0.0.1:${gwPort}`;

  const items = deploymentsTestnet.deposit.items;
  const plan = commitmentOf(items);
  const notesFile = path.join(mcpDir, 'notes.json');
  fs.writeFileSync(notesFile, JSON.stringify({
    type: 'zec-null-402-notes',
    gateway: gwUrl,
    plans: { [plan]: { commitment: plan, units: '220', items, txid: null, amountZat: '220000' } },
    notes: [],
  }), { mode: 0o600 });

  try {
    // -------------------------------------------------------------
    // MCP-CLAIM-SUCCESS
    // -------------------------------------------------------------
    console.log('Testing MCP-CLAIM-SUCCESS...');
    const clientClaim = new Client({ name: 'audit-client', version: '1.0.0' });
    await clientClaim.connect(new StdioClientTransport({
      command: 'node',
      args: [path.join(root, 'packages/mcp/dist/main.js')],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        Z402_SCAN_BIN: scanBinary(),
        Z402_GATEWAY_URL: gwUrl,
        Z402_NOTES_FILE: notesFile,
      },
    }));

    const claimRes = await clientClaim.callTool({ name: 'claim', arguments: { plan, txid: deploymentsTestnet.deposit.txid } });
    console.log('claimRes:', JSON.stringify(claimRes));
    if (claimRes.isError) throw new Error(`MCP-CLAIM-SUCCESS failed: ${JSON.stringify(claimRes)}`);
    const claimParsed = JSON.parse(claimRes.content[0].text);
    const expectedRoot = '4498787375493044641629502448109918628546215513903653918575713697752952913389';
    if (claimParsed.first !== 0 || claimParsed.count !== 22 || claimParsed.root !== expectedRoot) {
      throw new Error(`MCP-CLAIM-SUCCESS unexpected payload: ${JSON.stringify(claimParsed)}`);
    }
    const evClaimSuccessPath = path.join(root, 'audit/evidence/full/MCP-CLAIM-SUCCESS.json');
    fs.writeFileSync(evClaimSuccessPath, JSON.stringify({ isError: false, result: claimParsed }, null, 2));
    console.log('✓ MCP-CLAIM-SUCCESS: PASS\n');

    // -------------------------------------------------------------
    // MCP-CLAIM-409-ALREADY-CLAIMED
    // -------------------------------------------------------------
    console.log('Testing MCP-CLAIM-409-ALREADY-CLAIMED...');
    const claim409Res = await clientClaim.callTool({ name: 'claim', arguments: { plan, txid: deploymentsTestnet.deposit.txid } });
    console.log('claim409Res:', JSON.stringify(claim409Res));
    if (!claim409Res.isError || !/already claimed/.test(claim409Res.content?.[0]?.text || '')) {
      throw new Error(`MCP-CLAIM-409-ALREADY-CLAIMED failed: ${JSON.stringify(claim409Res)}`);
    }
    await clientClaim.close();
    const evClaim409Path = path.join(root, 'audit/evidence/full/MCP-CLAIM-409-ALREADY-CLAIMED.json');
    fs.writeFileSync(evClaim409Path, JSON.stringify(claim409Res, null, 2));
    console.log('✓ MCP-CLAIM-409-ALREADY-CLAIMED: PASS\n');

    // -------------------------------------------------------------
    // MCP-DEPOSIT-SETUP-REQUIRED-WALLET
    // -------------------------------------------------------------
    console.log('Testing MCP-DEPOSIT-SETUP-REQUIRED-WALLET...');
    const clientNoWallet = new Client({ name: 'audit-client', version: '1.0.0' });
    await clientNoWallet.connect(new StdioClientTransport({
      command: 'node',
      args: [path.join(root, 'packages/mcp/dist/main.js')],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        Z402_SCAN_BIN: scanBinary(),
        Z402_GATEWAY_URL: gwUrl,
        Z402_NOTES_FILE: notesFile,
      },
    }));

    const noWalletRes = await clientNoWallet.callTool({ name: 'deposit', arguments: { count: 2, units: 10 } });
    console.log('noWalletRes:', JSON.stringify(noWalletRes));
    if (!noWalletRes.isError || noWalletRes.content?.[0]?.text !== 'Setup required: Z402_WALLET') {
      throw new Error(`MCP-DEPOSIT-SETUP-REQUIRED-WALLET failed: ${JSON.stringify(noWalletRes)}`);
    }
    await clientNoWallet.close();
    const evNoWalletPath = path.join(root, 'audit/evidence/full/MCP-DEPOSIT-SETUP-REQUIRED-WALLET.json');
    fs.writeFileSync(evNoWalletPath, JSON.stringify(noWalletRes, null, 2));
    console.log('✓ MCP-DEPOSIT-SETUP-REQUIRED-WALLET: PASS\n');

    // -------------------------------------------------------------
    // MCP-DEPOSIT-REFUSED-MAX-CAP
    // -------------------------------------------------------------
    console.log('Testing MCP-DEPOSIT-REFUSED-MAX-CAP...');
    const emptyWalletDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z402-audit-empty-wallet-'));
    const clientMaxCap = new Client({ name: 'audit-client', version: '1.0.0' });
    await clientMaxCap.connect(new StdioClientTransport({
      command: 'node',
      args: [path.join(root, 'packages/mcp/dist/main.js')],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        Z402_SCAN_BIN: scanBinary(),
        Z402_GATEWAY_URL: gwUrl,
        Z402_NOTES_FILE: notesFile,
        Z402_WALLET: emptyWalletDir,
        Z402_MAX_DEPOSIT_ZAT: '1000',
      },
    }));

    const maxCapRes = await clientMaxCap.callTool({ name: 'deposit', arguments: { count: 2, units: 10 } });
    console.log('maxCapRes:', JSON.stringify(maxCapRes));
    if (!maxCapRes.isError || !/refused: deposit of .* zat is above Z402_MAX_DEPOSIT_ZAT/.test(maxCapRes.content?.[0]?.text || '')) {
      throw new Error(`MCP-DEPOSIT-REFUSED-MAX-CAP failed: ${JSON.stringify(maxCapRes)}`);
    }
    await clientMaxCap.close();
    const evMaxCapPath = path.join(root, 'audit/evidence/full/MCP-DEPOSIT-REFUSED-MAX-CAP.json');
    fs.writeFileSync(evMaxCapPath, JSON.stringify(maxCapRes, null, 2));
    console.log('✓ MCP-DEPOSIT-REFUSED-MAX-CAP: PASS\n');

    // -------------------------------------------------------------
    // MCP-DEPOSIT-REFUSED-TOTAL-BUDGET
    // -------------------------------------------------------------
    console.log('Testing MCP-DEPOSIT-REFUSED-TOTAL-BUDGET...');
    const clientBudget = new Client({ name: 'audit-client', version: '1.0.0' });
    await clientBudget.connect(new StdioClientTransport({
      command: 'node',
      args: [path.join(root, 'packages/mcp/dist/main.js')],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        Z402_SCAN_BIN: scanBinary(),
        Z402_GATEWAY_URL: gwUrl,
        Z402_NOTES_FILE: notesFile,
        Z402_WALLET: emptyWalletDir,
        Z402_MAX_DEPOSIT_ZAT: '40000',
        Z402_MAX_TOTAL_DEPOSIT_ZAT: '230000',
      },
    }));

    const budgetRes = await clientBudget.callTool({ name: 'deposit', arguments: { count: 2, units: 10 } });
    console.log('budgetRes:', JSON.stringify(budgetRes));
    if (!budgetRes.isError || !/refused: deposits from this notes file would total .* zat, above Z402_MAX_TOTAL_DEPOSIT_ZAT/.test(budgetRes.content?.[0]?.text || '')) {
      throw new Error(`MCP-DEPOSIT-REFUSED-TOTAL-BUDGET failed: ${JSON.stringify(budgetRes)}`);
    }
    await clientBudget.close();
    const evBudgetPath = path.join(root, 'audit/evidence/full/MCP-DEPOSIT-REFUSED-TOTAL-BUDGET.json');
    fs.writeFileSync(evBudgetPath, JSON.stringify(budgetRes, null, 2));
    console.log('✓ MCP-DEPOSIT-REFUSED-TOTAL-BUDGET: PASS\n');
  } finally {
    server.close();
    gw.close();
    fs.rmSync(mcpDir, { recursive: true, force: true });
  }

  console.log('All 6 still-open rows executed successfully and PASSED!');
}

main().catch((err) => {
  console.error('Error running still-open audit rows:', err);
  process.exit(1);
});
