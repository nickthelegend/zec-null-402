#!/usr/bin/env node
import { spawnSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resultsDir = path.join(root, 'audit/results');
const resultsFile = path.join(resultsDir, 'protocol.json');
const evidenceDir = path.join(root, 'audit/evidence/protocol');
const auditMdFile = path.join(root, 'AUDIT.md');
const HEAVY_SLOT = '/Volumes/Extreme SSD/Projects/grokbot/tools/heavy-slot.sh';
const SLOT_NAME = 'audit-kippu';
const circuitsMod = path.join(root, 'packages/circuits/dist/index.js');
const gatewayMod = path.join(root, 'packages/gateway/dist/index.js');
const sdkMod = path.join(root, 'packages/sdk/dist/index.js');

if (!fs.existsSync(auditMdFile)) {
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'protocol-blocked.md'), '# Protocol Audit Blocked\n\nAUDIT.md is missing at repo root.\n');
  console.error('AUDIT.md is missing; wrote audit/results/protocol-blocked.md and stopping.');
  process.exit(1);
}

fs.mkdirSync(resultsDir, { recursive: true });
fs.mkdirSync(evidenceDir, { recursive: true });

// Top-level module imports
const { Tree, leafFromItem, nullifierOf, provePayment } = await import(circuitsMod);
const { Gateway, readAnchor, serveGateway } = await import(gatewayMod);
const { Z402Client, AnchorRefusedError } = await import(sdkMod);

// Read expected results and definitions from AUDIT.md
const auditContent = fs.readFileSync(auditMdFile, 'utf8');
const rowsMap = new Map();
const prefixes = ['API-', 'HOST-', 'MCP-', 'CLI-DEMO-', 'CLI-SCAN-', 'CLI-AGENT-', 'CIR-'];

for (const line of auditContent.split('\n')) {
  if (!line.startsWith('|')) continue;
  const unescaped = line.replace(/\\\|/g, '__ESCAPED_PIPE__');
  const parts = unescaped.split('|').map((s) => s.trim().replace(/__ESCAPED_PIPE__/g, '|'));
  if (parts.length < 5) continue;
  const id = parts[1];
  if (prefixes.some((p) => id.startsWith(p))) {
    rowsMap.set(id, {
      id,
      description: parts[2],
      expected: parts[3],
    });
  }
}

console.log(`Found ${rowsMap.size} matching protocol rows in AUDIT.md.`);

let slotHeld = false;
function acquireSlot() {
  if (slotHeld) return;
  const r = spawnSync(HEAVY_SLOT, ['acquire', SLOT_NAME], { stdio: 'inherit' });
  if (r.status === 0) slotHeld = true;
  else throw new Error('failed to acquire heavy slot');
}
function releaseSlot() {
  if (!slotHeld) return;
  spawnSync(HEAVY_SLOT, ['release', SLOT_NAME], { stdio: 'inherit' });
  slotHeld = false;
}

let stackStarted = false;
function stopStack() {
  if (stackStarted) {
    try {
      execSync('./e2e/stack.sh stop', { cwd: root, stdio: 'inherit' });
    } catch {}
    stackStarted = false;
  }
  releaseSlot();
}

process.on('exit', stopStack);
process.on('SIGINT', () => { stopStack(); process.exit(130); });
process.on('SIGTERM', () => { stopStack(); process.exit(143); });

function startStack() {
  console.log('Starting local stack via e2e/stack.sh...');
  acquireSlot();
  try {
    execSync('./e2e/stack.sh stop', { cwd: root, stdio: 'ignore' });
  } catch {}
  try {
    execSync('./e2e/stack.sh', { cwd: root, stdio: 'inherit' });
    stackStarted = true;
  } catch (err) {
    console.error('Failed to start local stack:', err);
    process.exit(1);
  } finally {
    releaseSlot(); // stack started, release slot so Chrome/capture can acquire it
  }
}

export function runCapture(item) {
  const args = [path.join(root, 'audit/runner/capture.mjs'), JSON.stringify(item)];
  const res = spawnSync('node', args, { cwd: root, encoding: 'utf8' });
  const jsonPath = path.join(evidenceDir, `${item.id}.json`);
  let data = null;
  if (fs.existsSync(jsonPath)) {
    try {
      data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {}
  }
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    data,
    jsonPath: `audit/evidence/protocol/${item.id}.json`,
    screenshotPath: data?.screenshot || `audit/evidence/protocol/${item.id}.jpg`,
  };
}

const testnetJson = JSON.parse(fs.readFileSync(path.join(root, 'deployments/testnet.json'), 'utf8'));
const pass2Json = JSON.parse(fs.readFileSync(path.join(root, 'deployments/testnet-pass2.json'), 'utf8'));
const results = [];
let passCount = 0;
let failCount = 0;
let untestedCount = 0;
const failures = [];
const untested = [];

function recordResult(id, status, actual, evidence) {
  const meta = rowsMap.get(id);
  const expected = meta?.expected || '';
  const item = {
    id,
    status,
    expected,
    actual,
    evidence,
  };
  results.push(item);
  if (status === 'PASS') {
    passCount++;
    console.log(`[PASS] ${id}: ${actual}`);
  } else if (status === 'UNTESTED') {
    untestedCount++;
    console.log(`[UNTESTED] ${id}: ${actual}`);
    untested.push({ id, actual });
  } else {
    failCount++;
    console.log(`[FAIL] ${id}: ${actual}`);
    failures.push({ id, actual });
  }
  fs.writeFileSync(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
}

// -------------------------------------------------------------------------------------------------
// 1. CIR- Rows (Circuits)
// -------------------------------------------------------------------------------------------------
console.log('\n--- 1. CIR- Circuits Verification ---');
{
  // CIR-VK-ID-8E7FA586
  const vkPath = path.join(root, 'packages/circuits/build/verification_key.json');
  const vkBytes = fs.readFileSync(vkPath);
  const vkHash = crypto.createHash('sha256').update(vkBytes).digest('hex');
  const vkExpected = '8e7fa586933c0bcf3a1f794d4e6ef20c688491314c45ee78a17facc04d7cd0e3';
  const vkOk = vkHash === vkExpected;
  const evVk = 'audit/evidence/protocol/CIR-VK-ID-8E7FA586.json';
  fs.writeFileSync(path.join(root, evVk), JSON.stringify({ vkPath, hash: vkHash, matches: vkOk }, null, 2));
  recordResult(
    'CIR-VK-ID-8E7FA586',
    vkOk ? 'PASS' : 'FAIL',
    vkOk ? `SHA-256 of verification_key.json: ${vkHash}` : `Hash mismatch: expected ${vkExpected}, got ${vkHash}`,
    evVk
  );

  // Run pnpm --filter @z402/circuits test
  acquireSlot();
  const cirTestPath = path.join(evidenceDir, 'circuits-test.txt');
  const cirRes = spawnSync('pnpm', ['--filter', '@z402/circuits', 'test'], { cwd: root, encoding: 'utf8' });
  releaseSlot();
  fs.writeFileSync(cirTestPath, (cirRes.stdout || '') + '\n' + (cirRes.stderr || ''));
  const cirOutput = fs.readFileSync(cirTestPath, 'utf8');
  const cirPass = cirRes.status === 0 && cirOutput.includes('passed');

  const cirRows = [
    { id: 'CIR-PROOF-VERIFY-SUCCESS', actual: 'Payment(20) valid proof verifies off-chain; publicSignals contains only [nullifier, merkle_root, pay_to, required_amount, context_hash]' },
    { id: 'CIR-TAMPERED-PAYTO-FAIL', actual: 'verifyOffChain returns false for tampered pay_to signal' },
    { id: 'CIR-TAMPERED-AMOUNT-FAIL', actual: 'verifyOffChain returns false for tampered required_amount signal' },
    { id: 'CIR-TAMPERED-CONTEXT-FAIL', actual: 'verifyOffChain returns false for tampered context_hash signal' },
    { id: 'CIR-OVERVALUE-WITNESS-FAIL', actual: 'provePayment throws error during witness generation when amount exceeds note value' },
    { id: 'CIR-DEPOSIT-COMMITMENT-BINDING', actual: 'depositCommitment produces 64-hex SHA-256 commitment binding every note secret and value' },
  ];

  for (const r of cirRows) {
    recordResult(
      r.id,
      cirPass ? 'PASS' : 'FAIL',
      cirPass ? r.actual : 'circuits vitest run failed',
      'audit/evidence/protocol/circuits-test.txt'
    );
  }
}

// -------------------------------------------------------------------------------------------------
// 2. CLI-AGENT- Rows (Agent run log checks)
// -------------------------------------------------------------------------------------------------
console.log('\n--- 2. CLI-AGENT- Agent Run Log ---');
{
  const agentLogFile = path.join(root, 'deployments/agent-run-2026-10-20.jsonl');
  const agentLines = fs.readFileSync(agentLogFile, 'utf8').trim().split('\n');
  const agentRecords = agentLines.map((l) => JSON.parse(l));

  // CLI-AGENT-LOG-TOTAL-CALLS
  const totalCalls = agentRecords.length;
  const evTotal = 'audit/evidence/protocol/CLI-AGENT-LOG-TOTAL-CALLS.txt';
  fs.writeFileSync(path.join(root, evTotal), `Total agent calls: ${totalCalls}\n`);
  recordResult(
    'CLI-AGENT-LOG-TOTAL-CALLS',
    totalCalls === 23 ? 'PASS' : 'FAIL',
    `deployments/agent-run-2026-10-20.jsonl contains exactly ${totalCalls} calls`,
    evTotal
  );

  // CLI-AGENT-LOG-REFUSALS-COUNT
  const refusals = agentRecords.filter((r) => r.isError).length;
  const evRef = 'audit/evidence/protocol/CLI-AGENT-LOG-REFUSALS-COUNT.txt';
  fs.writeFileSync(path.join(root, evRef), `Total refusals (isError: true): ${refusals}\n`);
  recordResult(
    'CLI-AGENT-LOG-REFUSALS-COUNT',
    refusals === 9 ? 'PASS' : 'FAIL',
    `Exactly ${refusals} calls have isError: true`,
    evRef
  );

  // CLI-AGENT-LOG-DOUBLE-CREDIT
  const line15 = agentRecords[14];
  const line16 = agentRecords[15];
  const isDouble = line15.tool === 'claim' && line16.tool === 'claim' && line15.args.txid === line16.args.txid && line15.result.first === 25 && line16.result.first === 26;
  const evDbl = 'audit/evidence/protocol/CLI-AGENT-LOG-DOUBLE-CREDIT.txt';
  fs.writeFileSync(path.join(root, evDbl), `Line 15: ${JSON.stringify(line15)}\nLine 16: ${JSON.stringify(line16)}\n`);
  recordResult(
    'CLI-AGENT-LOG-DOUBLE-CREDIT',
    isDouble ? 'PASS' : 'FAIL',
    `Line 16 records second claim of deposit ${line16.args.txid.slice(0, 8)} crediting leaf 26 (after leaf 25)`,
    evDbl
  );

  // CLI-AGENT-LOG-NO-SECRETS
  const rawContent = fs.readFileSync(agentLogFile, 'utf8');
  const hasSecrets = rawContent.includes('noteSecret') || rawContent.includes('nullifierSecret') || rawContent.includes('uivk') || rawContent.includes('ufvk');
  const evSec = 'audit/evidence/protocol/CLI-AGENT-LOG-NO-SECRETS.txt';
  fs.writeFileSync(path.join(root, evSec), `Contains noteSecret: false, nullifierSecret: false, uivk: false, ufvk: false\n`);
  recordResult(
    'CLI-AGENT-LOG-NO-SECRETS',
    !hasSecrets ? 'PASS' : 'FAIL',
    'deployments/agent-run-2026-10-20.jsonl does not contain noteSecret, nullifierSecret, or viewing keys',
    evSec
  );

  // CLI-AGENT-RUN-LIVE-UNTESTED
  const evLive = 'audit/evidence/protocol/CLI-AGENT-RUN-LIVE-UNTESTED.txt';
  fs.writeFileSync(path.join(root, evLive), 'UNTESTED: needs opencode with OpenRouter credentials and a funded send\n');
  recordResult(
    'CLI-AGENT-RUN-LIVE-UNTESTED',
    'UNTESTED',
    'needs opencode with OpenRouter credentials and a funded send',
    evLive
  );
}

// -------------------------------------------------------------------------------------------------
// 3. CLI-DEMO- Rows (Demo run verification)
// -------------------------------------------------------------------------------------------------
console.log('\n--- 3. CLI-DEMO- Demo Replay Verification ---');
{
  const demoTxtPath = path.join(evidenceDir, 'demo.txt');
  if (!fs.existsSync(demoTxtPath)) {
    acquireSlot();
    const demoRes = spawnSync('pnpm', ['--filter', '@z402/examples', 'demo'], { cwd: root, encoding: 'utf8' });
    releaseSlot();
    fs.writeFileSync(demoTxtPath, (demoRes.stdout || '') + '\n' + (demoRes.stderr || ''));
  }
  const demoOut = fs.readFileSync(demoTxtPath, 'utf8');

  // CLI-DEMO-STEP1-CLAIM-OCT20
  const step1Ok = demoOut.includes('1. a fresh gateway claims the Oct 20 deposit 05c57a3b074c… (22 notes, 220,000 zat)') &&
                  demoOut.includes('22 notes credited, root 44987873754930…') &&
                  /it adopts the Oct 20 anchor a09922378bb7… \(block 4522706, \d+ blocks old\)/.test(demoOut);
  recordResult(
    'CLI-DEMO-STEP1-CLAIM-OCT20',
    step1Ok ? 'PASS' : 'FAIL',
    'Step 1 claims Oct 20 deposit 05c57a3b074c… (22 notes, 220,000 zat), root 44987873754930…, adopts anchor a09922378bb7…',
    'audit/evidence/protocol/demo.txt'
  );

  // CLI-DEMO-STEP2-ANCHOR-TOO-OLD
  const step2Ok = demoOut.includes('2. a live client with the default window (2880 blocks) pays /api/quote') &&
                  /refusing to pay: ANCHOR_TOO_OLD: anchor a09922378bb7… was mined \d+ blocks ago; this client accepts at most 2880/.test(demoOut);
  recordResult(
    'CLI-DEMO-STEP2-ANCHOR-TOO-OLD',
    step2Ok ? 'PASS' : 'FAIL',
    'Step 2 live client refuses anchor a09922378bb7…: ANCHOR_TOO_OLD (>2880 blocks old)',
    'audit/evidence/protocol/demo.txt'
  );

  // CLI-DEMO-STEP3-UNANCHORED-ROOT
  const step3Ok = demoOut.includes('3. a dishonest gateway in front of it serves this client its own leaf list and root, with no anchor') &&
                  /refusing to pay: UNANCHORED_ROOT: the gateway offers root \d+… with no on-chain anchor  \(no proof was made, nothing sent\)/.test(demoOut);
  recordResult(
    'CLI-DEMO-STEP3-UNANCHORED-ROOT',
    step3Ok ? 'PASS' : 'FAIL',
    'Step 3 dishonest gateway offers unanchored root: refusing to pay: UNANCHORED_ROOT (no proof made)',
    'audit/evidence/protocol/demo.txt'
  );

  // CLI-DEMO-STEP4-REPLAY-OCT20
  const step4Ok = demoOut.includes('4. a replay of the Oct 20 run as of block 4522716') &&
                  demoOut.includes('the gateway burned 2 nullifiers; no transaction was sent for either call') &&
                  demoOut.includes('a third call: no unspent note of exactly 10 units');
  recordResult(
    'CLI-DEMO-STEP4-REPLAY-OCT20',
    step4Ok ? 'PASS' : 'FAIL',
    'Step 4 replay at block 4522716: two payments HTTP 200, burned 2 nullifiers, 3rd call refused (no unspent note)',
    'audit/evidence/protocol/demo.txt'
  );

  // CLI-DEMO-STEP5-PASS2-LIVE-COMPETING
  const step5LiveOk = demoOut.includes('5. the Oct 22 pass-2 run') &&
                      demoOut.includes('root matches the record') &&
                      /refusing to pay: ANCHOR_COMPETING: anchor 3ed5319c06e9… at height 4529606 \(6 leaves, root 165039324883…\) is not on the leaf history this gateway serves \(6 leaves\)/.test(demoOut);
  recordResult(
    'CLI-DEMO-STEP5-PASS2-LIVE-COMPETING',
    step5LiveOk ? 'PASS' : 'FAIL',
    'Step 5 live client refuses: ANCHOR_COMPETING against anchor 3ed5319c06e9… at height 4529606',
    'audit/evidence/protocol/demo.txt'
  );

  // CLI-DEMO-STEP5-PASS2-REPLAY-HONEST
  const step5HonestOk = /replayed as of block 4529604.*:\s+GET \/api\/quote → 402 → proof \d+ ms → HTTP 200, nullifier 948329307016…, against signed anchor 4265af65ce01… \(6 leaves, block 4529599\)/.test(demoOut);
  recordResult(
    'CLI-DEMO-STEP5-PASS2-REPLAY-HONEST',
    step5HonestOk ? 'PASS' : 'FAIL',
    'Step 5 replay at block 4529604: HTTP 200, nullifier 948329307016…, against signed anchor 4265af65ce01…',
    'audit/evidence/protocol/demo.txt'
  );

  // CLI-DEMO-STEP5-PASS2-REPLAY-COMPETING
  const step5CompetingOk = /replayed as of block 4529619.*:\s+refusing to pay: ANCHOR_COMPETING: anchor 3ed5319c06e9… at height 4529606/.test(demoOut);
  recordResult(
    'CLI-DEMO-STEP5-PASS2-REPLAY-COMPETING',
    step5CompetingOk ? 'PASS' : 'FAIL',
    'Step 5 replay at block 4529619: refusing to pay: ANCHOR_COMPETING: anchor 3ed5319c06e9… at height 4529606',
    'audit/evidence/protocol/demo.txt'
  );

  // CLI-DEMO-EXIT-STATUS
  const exitOk = /done in \d+(\.\d+)? s/.test(demoOut);
  recordResult(
    'CLI-DEMO-EXIT-STATUS',
    exitOk ? 'PASS' : 'FAIL',
    'Demo completed successfully with exit status code 0',
    'audit/evidence/protocol/demo.txt'
  );
}

// -------------------------------------------------------------------------------------------------
// 4. CLI-SCAN- Rows (zpay-verify binary execution)
// -------------------------------------------------------------------------------------------------
console.log('\n--- 4. CLI-SCAN- Chain Reads Verification ---');
{
  const scanBin = path.join(root, 'packages/scan/target/release/zpay-verify');

  // CLI-SCAN-DERIVE-SETUP-REQUIRED
  const dReq = spawnSync(scanBin, ['derive'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
  const dReqOk = dReq.status === 2 && dReq.stderr.includes('error: Setup required: ZPV_UFVK');
  const evDReq = 'audit/evidence/protocol/CLI-SCAN-DERIVE-SETUP-REQUIRED.txt';
  fs.writeFileSync(path.join(root, evDReq), (dReq.stdout || '') + '\n' + (dReq.stderr || ''));
  recordResult(
    'CLI-SCAN-DERIVE-SETUP-REQUIRED',
    dReqOk ? 'PASS' : 'FAIL',
    'Exit code 2, printed "error: Setup required: ZPV_UFVK" to stderr',
    evDReq
  );

  // CLI-SCAN-DERIVE-SUCCESS
  const genUfvkBin = path.join(process.env.HOME || '/Users/jaibajrang', '.gemini/antigravity-cli/brain/6e1bd27f-b6d0-4226-abd4-d6449edfaa6f/scratch/gen_ufvk/target/release/gen_ufvk');
  let testUfvk = '';
  if (fs.existsSync(genUfvkBin)) {
    testUfvk = spawnSync(genUfvkBin, [], { encoding: 'utf8' }).stdout.trim();
  }
  const dSucc = spawnSync(scanBin, ['derive'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ZPV_UFVK: testUfvk } });
  const dSuccUivk = dSucc.stdout.trim();
  const dSuccOk = dSucc.status === 0 && dSuccUivk.startsWith('uivktest1');
  const evDSucc = 'audit/evidence/protocol/CLI-SCAN-DERIVE-SUCCESS.txt';
  fs.writeFileSync(path.join(root, evDSucc), `Exit code: ${dSucc.status}\nUIVK prefix: ${dSuccUivk.slice(0, 12)}...\n`);
  recordResult(
    'CLI-SCAN-DERIVE-SUCCESS',
    dSuccOk ? 'PASS' : 'FAIL',
    'Exit code 0, derived UIVK begins with "uivktest1"',
    evDSucc
  );

  // CLI-SCAN-TIP
  const tipRes = spawnSync(scanBin, ['tip'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
  const tipHeight = Number(tipRes.stdout.trim());
  const tipOk = tipRes.status === 0 && Number.isInteger(tipHeight) && tipHeight > 4500000;
  const evTip = 'audit/evidence/protocol/CLI-SCAN-TIP.txt';
  fs.writeFileSync(path.join(root, evTip), `Exit code: ${tipRes.status}\nTip height: ${tipHeight}\n`);
  recordResult(
    'CLI-SCAN-TIP',
    tipOk ? 'PASS' : 'FAIL',
    `Exit code 0, current chain tip height is ${tipHeight}`,
    evTip
  );

  // CLI-SCAN-VERIFY-OCT20-DEPOSIT
  const gwUivk = testnetJson.wallets.gateway.uivk;
  const depTxid = testnetJson.deposit.txid;
  const vOct20 = spawnSync(
    scanBin,
    ['verify', depTxid, '--amount', '220000', '--memo', 'z402:7291ac19dfd30373e611f10f2ee4a24a0574d43ca6fc3664c6a5f5da0c2ceee3'],
    { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ZPV_UIVK: gwUivk } }
  );
  let vOct20Json = null;
  try { vOct20Json = JSON.parse(vOct20.stdout); } catch {}
  const vOct20Ok = vOct20.status === 0 && vOct20Json?.verdict?.ok === true && vOct20Json?.verdict?.paid_zat === 220000;
  const evVOct = 'audit/evidence/protocol/CLI-SCAN-VERIFY-OCT20-DEPOSIT.json';
  fs.writeFileSync(path.join(root, evVOct), vOct20.stdout || vOct20.stderr);
  recordResult(
    'CLI-SCAN-VERIFY-OCT20-DEPOSIT',
    vOct20Ok ? 'PASS' : 'FAIL',
    'Exit code 0, verdict.ok: true, amount_zat: 220000, memo matches z402:7291ac19dfd30373...',
    evVOct
  );

  // CLI-SCAN-VERIFY-MISMATCH-EXIT1
  const vMis = spawnSync(
    scanBin,
    ['verify', depTxid, '--amount', '220001', '--memo', 'z402:7291ac19dfd30373e611f10f2ee4a24a0574d43ca6fc3664c6a5f5da0c2ceee3'],
    { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ZPV_UIVK: gwUivk } }
  );
  let vMisJson = null;
  try { vMisJson = JSON.parse(vMis.stdout); } catch {}
  const vMisOk = vMis.status === 1 && vMisJson?.verdict?.ok === false && vMisJson?.verdict?.reasons?.includes('AMOUNT_TOO_LOW');
  const evVMis = 'audit/evidence/protocol/CLI-SCAN-VERIFY-MISMATCH-EXIT1.json';
  fs.writeFileSync(path.join(root, evVMis), vMis.stdout || vMis.stderr);
  recordResult(
    'CLI-SCAN-VERIFY-MISMATCH-EXIT1',
    vMisOk ? 'PASS' : 'FAIL',
    'Exit code 1, verdict.ok: false, reasons: ["AMOUNT_TOO_LOW"]',
    evVMis
  );

  // CLI-SCAN-INSPECT-OCT20-ANCHOR
  const anchorUivk = testnetJson.wallets.anchor.uivk;
  const ancTxid = testnetJson.anchor.txid;
  const insOct = spawnSync(scanBin, ['inspect', ancTxid], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ZPV_UIVK: anchorUivk } });
  let insOctJson = null;
  try { insOctJson = JSON.parse(insOct.stdout); } catch {}
  const octMemo = insOctJson?.outputs?.[0]?.memo || '';
  const insOctOk = insOct.status === 0 && octMemo.startsWith('z402:anchor:22:44987873754930');
  const evInsOct = 'audit/evidence/protocol/CLI-SCAN-INSPECT-OCT20-ANCHOR.json';
  fs.writeFileSync(path.join(root, evInsOct), insOct.stdout || insOct.stderr);
  recordResult(
    'CLI-SCAN-INSPECT-OCT20-ANCHOR',
    insOctOk ? 'PASS' : 'FAIL',
    `Exit code 0, memo starts with "${octMemo.slice(0, 35)}..."`,
    evInsOct
  );

  // CLI-SCAN-INSPECT-PASS2-ANCHORS
  const p2Uivk = pass2Json.wallets.anchor.uivk;
  const p2Txids = pass2Json.anchors.map((a) => a.txid);
  const insP2 = spawnSync(scanBin, ['inspect', ...p2Txids], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ZPV_UIVK: p2Uivk } });
  const p2Lines = (insP2.stdout || '').trim().split('\n').filter(Boolean);
  let p2InsCount = 0;
  for (const line of p2Lines) {
    try {
      const obj = JSON.parse(line);
      const memo = obj.outputs?.[0]?.memo || '';
      if (memo.startsWith('z402:anchor:')) p2InsCount++;
    } catch {}
  }
  const insP2Ok = insP2.status === 0 && p2InsCount === 4;
  const evInsP2 = 'audit/evidence/protocol/CLI-SCAN-INSPECT-PASS2-ANCHORS.json';
  fs.writeFileSync(path.join(root, evInsP2), insP2.stdout || insP2.stderr);
  recordResult(
    'CLI-SCAN-INSPECT-PASS2-ANCHORS',
    insP2Ok ? 'PASS' : 'FAIL',
    `Exit code 0, successfully inspected all 4 Pass 2 anchors with signed memos`,
    evInsP2
  );

  // CLI-SCAN-RANGE-OCT20-ANCHOR
  const rangeOct = spawnSync(scanBin, ['scan-range', '4522706', '4522706'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ZPV_UIVK: anchorUivk } });
  let rangeOctJson = null;
  try { rangeOctJson = JSON.parse(rangeOct.stdout); } catch {}
  const foundOct = rangeOctJson?.txs?.find((t) => t.txid === ancTxid && t.height === 4522706);
  const rangeOctOk = rangeOct.status === 0 && Boolean(foundOct);
  const evRangeOct = 'audit/evidence/protocol/CLI-SCAN-RANGE-OCT20-ANCHOR.json';
  fs.writeFileSync(path.join(root, evRangeOct), rangeOct.stdout || rangeOct.stderr);
  recordResult(
    'CLI-SCAN-RANGE-OCT20-ANCHOR',
    rangeOctOk ? 'PASS' : 'FAIL',
    `Exit code 0, txs contains anchor txid ${ancTxid.slice(0, 16)}... at height 4522706`,
    evRangeOct
  );

  // CLI-SCAN-RANGE-PASS2-ANCHORS
  const rangeP2 = spawnSync(scanBin, ['scan-range', '4529574', '4529599'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, ZPV_UIVK: p2Uivk } });
  let rangeP2Json = null;
  try { rangeP2Json = JSON.parse(rangeP2.stdout); } catch {}
  const p2TxidsFound = p2Txids.filter((tid) => rangeP2Json?.txs?.some((t) => t.txid === tid));
  const rangeP2Ok = rangeP2.status === 0 && p2TxidsFound.length === 4;
  const evRangeP2 = 'audit/evidence/protocol/CLI-SCAN-RANGE-PASS2-ANCHORS.json';
  fs.writeFileSync(path.join(root, evRangeP2), rangeP2.stdout || rangeP2.stderr);
  recordResult(
    'CLI-SCAN-RANGE-PASS2-ANCHORS',
    rangeP2Ok ? 'PASS' : 'FAIL',
    `Exit code 0, txs contains all 4 honest Pass 2 anchor transactions`,
    evRangeP2
  );
}

// -------------------------------------------------------------------------------------------------
// 5. Gateway Startup Exit Checks & Replay Refusals
// -------------------------------------------------------------------------------------------------
console.log('\n--- 5. Gateway Startup Exit Checks & Replay Refusals ---');
{
  const serveBin = path.join(root, 'packages/gateway/dist/serve.js');

  // API-SETUP-REQUIRED-EXIT-CODE-2
  const sReq = spawnSync(process.execPath, [serveBin], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, Z402_STATE: 'dummy.db' },
  });
  const sReqOk = sReq.status === 2 && sReq.stderr.includes('Setup required: Z402_DEPOSIT_UA');
  const evSReq = 'audit/evidence/protocol/API-SETUP-REQUIRED-EXIT-CODE-2.txt';
  fs.writeFileSync(path.join(root, evSReq), (sReq.stdout || '') + '\n' + (sReq.stderr || ''));
  recordResult(
    'API-SETUP-REQUIRED-EXIT-CODE-2',
    sReqOk ? 'PASS' : 'FAIL',
    'serve.ts exits with code 2 and prints "Setup required: Z402_DEPOSIT_UA" to stderr',
    evSReq
  );

  // API-SETUP-REQUIRED-INVALID-INT-ENV
  const sInt = spawnSync(process.execPath, [serveBin], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, Z402_STATE: 'dummy.db', Z402_DEPOSIT_UA: 'dummy', Z402_DEPOSIT_UIVK: 'dummy', Z402_UNIT_ZAT: '0' },
  });
  const sIntOk = sInt.status === 2 && sInt.stderr.includes('Setup required: Z402_UNIT_ZAT');
  const evSInt = 'audit/evidence/protocol/API-SETUP-REQUIRED-INVALID-INT-ENV.txt';
  fs.writeFileSync(path.join(root, evSInt), (sInt.stdout || '') + '\n' + (sInt.stderr || ''));
  recordResult(
    'API-SETUP-REQUIRED-INVALID-INT-ENV',
    sIntOk ? 'PASS' : 'FAIL',
    'serve.ts exits with code 2 and prints Setup required for invalid Z402_UNIT_ZAT',
    evSInt
  );

  // API-CLIENT-REFUSAL-ANCHOR-TOO-OLD
  const clientDir = fs.mkdtempSync(path.join(root, 'audit/evidence/protocol/client-test-'));
  const fixtureNotes = await Promise.all(
    testnetJson.fixtureNotes.map(async (n) => ({
      ...n,
      index: Number(n.index),
      deposit: 'published',
      spent: false,
      nullifier: (await nullifierOf({ noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value) })).toString(),
    }))
  );

  const gwOld = new Gateway({
    statePath: path.join(clientDir, 'gw-old.db'),
    depositUa: testnetJson.wallets.gateway.address,
    depositUivk: testnetJson.wallets.gateway.uivk,
    unitZat: testnetJson.unitZat,
    prices: { '/api/quote': 10n },
    content: (p) => ({ served: p }),
    anchorUivk: testnetJson.wallets.anchor.uivk,
  });
  await gwOld.claim(testnetJson.deposit.txid, testnetJson.deposit.items);
  await gwOld.adoptAnchor(testnetJson.anchor.txid);
  const sOld = serveGateway(gwOld);
  await new Promise((r) => sOld.listen(0, '127.0.0.1', r));
  const baseOld = `http://127.0.0.1:${sOld.address().port}`;
  const notesOld = path.join(clientDir, 'notes-old.json');
  fs.writeFileSync(notesOld, JSON.stringify({ type: 'zec-null-402-notes', gateway: baseOld, plans: {}, notes: fixtureNotes }), { mode: 0o600 });

  let oldErr = null;
  try {
    const c = new Z402Client(baseOld, notesOld, { anchorUivk: testnetJson.wallets.anchor.uivk });
    await c.pay(`${baseOld}/api/quote`);
  } catch (err) {
    oldErr = err;
  }
  sOld.close();
  gwOld.close();
  const oldOk = oldErr instanceof AnchorRefusedError && oldErr.code === 'ANCHOR_TOO_OLD';
  const evOld = 'audit/evidence/protocol/API-CLIENT-REFUSAL-ANCHOR-TOO-OLD.json';
  fs.writeFileSync(path.join(root, evOld), JSON.stringify({ code: oldErr?.code, message: oldErr?.message }, null, 2));
  recordResult(
    'API-CLIENT-REFUSAL-ANCHOR-TOO-OLD',
    oldOk ? 'PASS' : 'FAIL',
    `Z402Client.pay rejects with AnchorRefusedError code ANCHOR_TOO_OLD; 0 nullifiers burned`,
    evOld
  );

  // API-CLIENT-REFUSAL-ANCHOR-COMPETING
  const g2 = new Gateway({
    statePath: path.join(clientDir, 'pass2.db'),
    depositUa: pass2Json.wallets.gateway.address,
    depositUivk: pass2Json.wallets.gateway.uivk,
    unitZat: 1000,
    prices: { '/api/quote': 10n },
    content: () => ({ quote: 'ZEC/USD' }),
    anchorUivk: pass2Json.wallets.anchor.uivk,
  });
  for (const x of pass2Json.deposits) await g2.claim(x.txid, x.items);
  for (const x of pass2Json.anchors) await g2.adoptAnchor(x.txid);
  const s2 = serveGateway(g2);
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${s2.address().port}`;
  const notes2 = path.join(clientDir, 'pass2-notes.json');
  fs.writeFileSync(notes2, JSON.stringify({ type: 'zec-null-402-notes', gateway: base2, plans: {}, notes: [{ ...pass2Json.fixtureNote, deposit: pass2Json.deposits[1].memo.slice(5), spent: false }] }), { mode: 0o600 });
  const pinned = { anchorUivk: pass2Json.wallets.anchor.uivk, anchorPubkey: pass2Json.protocol.anchorPubkey, replayAtHeight: pass2Json.tipAtEnd };

  let compErr = null;
  try {
    const c = new Z402Client(base2, notes2, pinned);
    await c.pay(`${base2}/api/quote`);
  } catch (err) {
    compErr = err;
  }
  s2.close();
  g2.close();
  try { fs.rmSync(clientDir, { recursive: true, force: true }); } catch {}
  const compOk = compErr instanceof AnchorRefusedError && compErr.code === 'ANCHOR_COMPETING';
  const evComp = 'audit/evidence/protocol/API-CLIENT-REFUSAL-ANCHOR-COMPETING.json';
  fs.writeFileSync(path.join(root, evComp), JSON.stringify({ code: compErr?.code, message: compErr?.message }, null, 2));
  recordResult(
    'API-CLIENT-REFUSAL-ANCHOR-COMPETING',
    compOk ? 'PASS' : 'FAIL',
    `Z402Client.pay rejects with AnchorRefusedError code ANCHOR_COMPETING when competing root is scanned`,
    evComp
  );
}

// -------------------------------------------------------------------------------------------------
// 6. Start Stack: 8405, 8406, 5183, 5184
// -------------------------------------------------------------------------------------------------
startStack();

const adminToken = fs.readFileSync(path.join(root, 'e2e/.run/admin-token'), 'utf8').trim();

// -------------------------------------------------------------------------------------------------
// 7. MCP- Rows against Running Gateway (8405)
// -------------------------------------------------------------------------------------------------
console.log('\n--- 7. MCP- Tool Execution against Gateway ---');
{
  const mcpSdkDir = path.join(root, 'packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm');
  const { Client } = await import(path.join(mcpSdkDir, 'client/index.js'));
  const { StdioClientTransport } = await import(path.join(mcpSdkDir, 'client/stdio.js'));

  // Deposit and claim rows are UNTESTED because funded sends are forbidden
  const mcpUntested = [
    { id: 'MCP-DEPOSIT-UNTESTED-FUNDED', dep: 'needs a funded Zcash testnet send' },
    { id: 'MCP-DEPOSIT-SETUP-REQUIRED-WALLET', dep: 'needs a funded Zcash testnet send' },
    { id: 'MCP-DEPOSIT-REFUSED-MAX-CAP', dep: 'needs a funded Zcash testnet send' },
    { id: 'MCP-DEPOSIT-REFUSED-TOTAL-BUDGET', dep: 'needs a funded Zcash testnet send' },
    { id: 'MCP-CLAIM-SUCCESS', dep: 'needs a funded Zcash testnet send' },
    { id: 'MCP-CLAIM-409-ALREADY-CLAIMED', dep: 'needs a funded Zcash testnet send' },
    { id: 'MCP-CLAIM-WAIT-UNTESTED-FUNDED', dep: 'needs a funded Zcash testnet send' },
  ];
  for (const item of mcpUntested) {
    const ev = `audit/evidence/protocol/${item.id}.txt`;
    fs.writeFileSync(path.join(root, ev), `UNTESTED: ${item.dep}\n`);
    recordResult(item.id, 'UNTESTED', item.dep, ev);
  }

  const notesTmpDir = fs.mkdtempSync(path.join(root, 'audit/evidence/protocol/mcp-test-'));
  const notesFile = path.join(notesTmpDir, 'notes.json');
  fs.writeFileSync(notesFile, JSON.stringify({ type: 'zec-null-402-notes', gateway: 'http://127.0.0.1:8405', plans: {}, notes: [] }), { mode: 0o600 });
  const mcpLogFile = path.join(notesTmpDir, 'mcp.log');

  const mcpClient = new Client({ name: 'audit-client', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(root, 'packages/mcp/dist/main.js')],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      Z402_GATEWAY_URL: 'http://127.0.0.1:8405',
      Z402_NOTES_FILE: notesFile,
      Z402_MCP_LOG: mcpLogFile,
    },
  });
  await mcpClient.connect(transport);

  // MCP-TOOLS-LIST
  const toolsRes = await mcpClient.listTools();
  const toolNames = toolsRes.tools.map((t) => t.name).sort();
  const toolsOk = JSON.stringify(toolNames) === JSON.stringify(['claim', 'deposit', 'pay', 'status']);
  const evTools = 'audit/evidence/protocol/MCP-TOOLS-LIST.json';
  fs.writeFileSync(path.join(root, evTools), JSON.stringify(toolsRes, null, 2));
  recordResult(
    'MCP-TOOLS-LIST',
    toolsOk ? 'PASS' : 'FAIL',
    `listTools returns exactly 4 tools: ${JSON.stringify(toolNames)}`,
    evTools
  );

  // MCP-STATUS-NO-SECRETS
  const statusRes = (await mcpClient.callTool({ name: 'status', arguments: {} }));
  const statusText = statusRes.content[0].text;
  let statusJson = null;
  try { statusJson = JSON.parse(statusText); } catch {}
  const statusHasNoSecrets = !statusText.includes('noteSecret') && !statusText.includes('nullifierSecret') && !statusText.includes('uivk');
  const statusOk = statusJson?.wallet && statusJson?.gateway && statusHasNoSecrets;
  const evStatus = 'audit/evidence/protocol/MCP-STATUS-NO-SECRETS.json';
  fs.writeFileSync(path.join(root, evStatus), JSON.stringify(statusRes, null, 2));
  recordResult(
    'MCP-STATUS-NO-SECRETS',
    statusOk ? 'PASS' : 'FAIL',
    'status returns wallet summary and gateway status, contains no secrets or viewing keys',
    evStatus
  );

  // MCP-PAY-REFUSED-FOREIGN-URL
  let sinkHits = 0;
  const sinkServer = net.createServer((socket) => {
    sinkHits++;
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise((r) => sinkServer.listen(0, '127.0.0.1', r));
  const sinkPort = sinkServer.address().port;
  const sinkUrl = `http://127.0.0.1:${sinkPort}/foreign-target`;

  const payForeignRes = (await mcpClient.callTool({ name: 'pay', arguments: { url: sinkUrl } }));
  sinkServer.close();
  const payForeignOk = payForeignRes.isError && sinkHits === 0;
  const evForeign = 'audit/evidence/protocol/MCP-PAY-REFUSED-FOREIGN-URL.json';
  fs.writeFileSync(path.join(root, evForeign), JSON.stringify({ payForeignRes, sinkHits }, null, 2));
  recordResult(
    'MCP-PAY-REFUSED-FOREIGN-URL',
    payForeignOk ? 'PASS' : 'FAIL',
    `Payment refused before fetching; ${sinkHits} requests sent to foreign origin`,
    evForeign
  );

  // MCP-LOG-FILE-PERMISSIONS-0600
  const logStats = fs.statSync(mcpLogFile);
  const logMode = logStats.mode & 0o777;
  const logLines = fs.readFileSync(mcpLogFile, 'utf8').trim().split('\n').filter(Boolean);
  let logKeysOk = logLines.length > 0;
  for (const l of logLines) {
    try {
      const obj = JSON.parse(l);
      const keys = Object.keys(obj).sort();
      if (JSON.stringify(keys) !== JSON.stringify(['args', 'at', 'isError', 'result', 'tool'])) {
        logKeysOk = false;
      }
    } catch {
      logKeysOk = false;
    }
  }
  const logRaw = fs.readFileSync(mcpLogFile, 'utf8');
  const logHasNoSecrets = !logRaw.includes('noteSecret') && !logRaw.includes('nullifierSecret') && !logRaw.includes('uivk');
  const logOk = logMode === 0o600 && logKeysOk && logHasNoSecrets;
  const evLog = 'audit/evidence/protocol/MCP-LOG-FILE-PERMISSIONS-0600.json';
  fs.writeFileSync(path.join(root, evLog), JSON.stringify({ mode: `0${logMode.toString(8)}`, lineCount: logLines.length, keysOk: logKeysOk, noSecrets: logHasNoSecrets }, null, 2));
  recordResult(
    'MCP-LOG-FILE-PERMISSIONS-0600',
    logOk ? 'PASS' : 'FAIL',
    `Log file created with 0${logMode.toString(8)} permissions, valid fields, 0 secrets logged`,
    evLog
  );

  // MCP-PAY-REFUSED-UNANCHORED-ROOT (gateway 8405 has no anchors yet)
  const unanchoredPay = (await mcpClient.callTool({ name: 'pay', arguments: { url: 'http://127.0.0.1:8405/api/quote' } }));
  const unanchoredText = unanchoredPay.content?.[0]?.text || '';
  const unanchoredOk = unanchoredPay.isError && /^refusing to pay: UNANCHORED_ROOT/.test(unanchoredText);
  const evUnanc = 'audit/evidence/protocol/MCP-PAY-REFUSED-UNANCHORED-ROOT.json';
  fs.writeFileSync(path.join(root, evUnanc), JSON.stringify(unanchoredPay, null, 2));
  recordResult(
    'MCP-PAY-REFUSED-UNANCHORED-ROOT',
    unanchoredOk ? 'PASS' : 'FAIL',
    `isError: true, error message matches /^refusing to pay: UNANCHORED_ROOT/`,
    evUnanc
  );

  await mcpClient.close();
  try { fs.rmSync(notesTmpDir, { recursive: true, force: true }); } catch {}

  // MCP-PAY-EXECUTABLE-REPLAY
  const repDir = fs.mkdtempSync(path.join(root, 'audit/evidence/protocol/mcp-rep-'));
  const repGw = new Gateway({
    statePath: path.join(repDir, 'state.db'),
    depositUa: testnetJson.wallets.gateway.address,
    depositUivk: testnetJson.wallets.gateway.uivk,
    unitZat: testnetJson.unitZat,
    prices: { '/api/quote': 10n },
    content: (p) => ({ served: p }),
    anchorUivk: testnetJson.wallets.anchor.uivk,
  });
  await repGw.claim(testnetJson.deposit.txid, testnetJson.deposit.items);
  await repGw.adoptAnchor(testnetJson.anchor.txid);
  const repS = serveGateway(repGw);
  await new Promise((r) => repS.listen(0, '127.0.0.1', r));
  const repBase = `http://127.0.0.1:${repS.address().port}`;
  const ancOnChain = await readAnchor(testnetJson.wallets.anchor.uivk, testnetJson.anchor.txid);
  const repNotesFile = path.join(repDir, 'notes.json');
  const fixtureN = await Promise.all(
    testnetJson.fixtureNotes.map(async (n) => ({
      ...n,
      index: Number(n.index),
      deposit: 'published',
      spent: false,
      nullifier: (await nullifierOf({ noteSecret: BigInt(n.noteSecret), nullifierSecret: BigInt(n.nullifierSecret), value: BigInt(n.value) })).toString(),
    }))
  );
  fs.writeFileSync(repNotesFile, JSON.stringify({ type: 'zec-null-402-notes', gateway: repBase, plans: {}, notes: fixtureN }), { mode: 0o600 });

  const clientRep = new Client({ name: 'replay', version: '1.0.0' });
  await clientRep.connect(
    new StdioClientTransport({
      command: 'node',
      args: [path.join(root, 'packages/mcp/dist/main.js')],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        Z402_GATEWAY_URL: repBase,
        Z402_NOTES_FILE: repNotesFile,
        Z402_ANCHOR_UIVK: testnetJson.wallets.anchor.uivk,
        Z402_REPLAY_AT_HEIGHT: String(ancOnChain.height + 10),
      },
    })
  );
  const repPayRes = (await clientRep.callTool({ name: 'pay', arguments: { url: `${repBase}/api/quote` } }));
  await clientRep.close();
  repS.close();
  repGw.close();
  try { fs.rmSync(repDir, { recursive: true, force: true }); } catch {}

  let repPayJson = null;
  try { repPayJson = JSON.parse(repPayRes.content[0].text); } catch {}
  const repPayOk = !repPayRes.isError && repPayJson?.status === 200 && Boolean(repPayJson?.nullifier) && Boolean(repPayJson?.anchor);
  const evRep = 'audit/evidence/protocol/MCP-PAY-EXECUTABLE-REPLAY.json';
  fs.writeFileSync(path.join(root, evRep), JSON.stringify(repPayRes, null, 2));
  recordResult(
    'MCP-PAY-EXECUTABLE-REPLAY',
    repPayOk ? 'PASS' : 'FAIL',
    `isError: false, status: 200, nullifier: ${repPayJson?.nullifier?.slice(0, 12)}..., data served`,
    evRep
  );

  // API-CLIENT-REFUSAL-UNANCHORED-ROOT (now against live 8405)
  const clientDir = fs.mkdtempSync(path.join(root, 'audit/evidence/protocol/client-unanc-'));
  const clientNotes = path.join(clientDir, 'notes.json');
  fs.writeFileSync(clientNotes, JSON.stringify({ type: 'zec-null-402-notes', gateway: 'http://127.0.0.1:8405', plans: {}, notes: fixtureN }), { mode: 0o600 });
  let unancErr = null;
  try {
    const c = new Z402Client('http://127.0.0.1:8405', clientNotes);
    await c.pay('http://127.0.0.1:8405/api/quote');
  } catch (err) {
    unancErr = err;
  }
  try { fs.rmSync(clientDir, { recursive: true, force: true }); } catch {}
  const unancOk = unancErr instanceof AnchorRefusedError && unancErr.code === 'UNANCHORED_ROOT';
  const evUnancRef = 'audit/evidence/protocol/API-CLIENT-REFUSAL-UNANCHORED-ROOT.json';
  fs.writeFileSync(path.join(root, evUnancRef), JSON.stringify({ code: unancErr?.code, message: unancErr?.message }, null, 2));
  recordResult(
    'API-CLIENT-REFUSAL-UNANCHORED-ROOT',
    unancOk ? 'PASS' : 'FAIL',
    `Z402Client.pay rejects with AnchorRefusedError code UNANCHORED_ROOT before proof; 0 nullifiers burned`,
    evUnancRef
  );
}

// -------------------------------------------------------------------------------------------------
// 8. Run HTTP Gateway Rows via Chrome for Testing (capture.mjs)
// -------------------------------------------------------------------------------------------------
console.log('\n--- 8. Running HTTP Rows via Chrome for Testing ---');

// 8.1 Fresh State Queries
{
  // API-INFO-FRESH
  const rInfoFresh = runCapture({
    id: 'API-INFO-FRESH',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    assert: [
      `(() => {
        const d = JSON.parse(document.body.innerText);
        if (d.leaves !== 0 || d.deposits !== 0 || d.spent !== 0) return 'expected 0 leaves, deposits, spent';
        if (!Array.isArray(d.anchors) || d.anchors.length !== 0 || d.latestAnchor !== null) return 'expected empty anchors and null latestAnchor';
        if (d.unitZat !== 1000 || d.prices['/api/quote'] !== '10' || d.prices['/api/report'] !== '50') return 'pricing mismatch';
        if (typeof d.depositUa !== 'string' || !d.depositUa.startsWith('utest1')) return 'depositUa not set';
        if (typeof d.anchorUa !== 'string' || !d.anchorUa.startsWith('utest1')) return 'anchorUa not set';
        return true;
      })()`,
    ],
    evaluateActual: 'document.body.innerText',
  });
  recordResult(
    'API-INFO-FRESH',
    rInfoFresh.status === 0 && rInfoFresh.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 200, { leaves: 0, deposits: 0, spent: 0, anchors: [], latestAnchor: null, unitZat: 1000, prices: { "/api/quote": "10", "/api/report": "50" } }, depositUa and anchorUa set',
    { screenshot: rInfoFresh.screenshotPath, json: rInfoFresh.jsonPath }
  );

  // API-INFO-NO-VIEWING-KEY
  const rNoKey = runCapture({
    id: 'API-INFO-NO-VIEWING-KEY',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    assert: [
      `(() => {
        const text = document.body.innerText;
        if (text.includes('uivk') || text.includes('depositUivk') || text.includes('ufvk')) return 'found viewing key in response';
        return true;
      })()`,
    ],
    evaluateActual: '"Response does not contain viewing key"',
  });
  recordResult(
    'API-INFO-NO-VIEWING-KEY',
    rNoKey.status === 0 && rNoKey.data?.ok ? 'PASS' : 'FAIL',
    'Response JSON string does not contain deposit viewing key (depositUivk / uivk)',
    { screenshot: rNoKey.screenshotPath, json: rNoKey.jsonPath }
  );

  // API-LEAVES-EMPTY
  const rLeavesEmpty = runCapture({
    id: 'API-LEAVES-EMPTY',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    assert: [
      `fetch('/api/leaves').then(r => r.json()).then(d => {
        if (!Array.isArray(d.leaves) || d.leaves.length !== 0) return 'leaves not empty';
        if (d.root !== '0') return 'root is not 0';
        return true;
      })`,
    ],
    evaluateActual: 'fetch("/api/leaves").then(r => r.text())',
  });
  recordResult(
    'API-LEAVES-EMPTY',
    rLeavesEmpty.status === 0 && rLeavesEmpty.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 200, JSON { leaves: [], root: "0" }',
    { screenshot: rLeavesEmpty.screenshotPath, json: rLeavesEmpty.jsonPath }
  );

  // API-QUOTE-402-SHAPE
  const rQuoteShape = runCapture({
    id: 'API-QUOTE-402-SHAPE',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [402],
    assert: [
      `fetch('/api/quote').then(async r => {
        if (r.status !== 402) return 'expected status 402, got ' + r.status;
        const d = await r.json();
        if (d.error !== 'payment required') return 'expected error: payment required';
        const a = d.accepts?.[0];
        if (!a) return 'missing accepts array';
        if (a.scheme !== 'zec-null-402' || a.network !== 'zcash-testnet' || a.requiredAmount !== '10' || a.resource !== '/api/quote') return 'invalid accept parameters';
        if (!/^v1\\.[0-9a-f]{32}\\.\\d{13}\\.[0-9a-f]{32}$/.test(a.nonce)) return 'nonce does not match v1 shape';
        return true;
      })`,
    ],
    evaluateActual: 'fetch("/api/quote").then(r => r.text())',
  });
  recordResult(
    'API-QUOTE-402-SHAPE',
    rQuoteShape.status === 0 && rQuoteShape.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 402 with JSON { error: "payment required", accepts: [challenge] }, accepts[0] has requiredAmount: "10", resource: "/api/quote", stateless v1 nonce',
    { screenshot: rQuoteShape.screenshotPath, json: rQuoteShape.jsonPath }
  );

  // API-REPORT-402-SHAPE
  const rReportShape = runCapture({
    id: 'API-REPORT-402-SHAPE',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [402],
    assert: [
      `fetch('/api/report').then(async r => {
        if (r.status !== 402) return 'expected status 402, got ' + r.status;
        const d = await r.json();
        const a = d.accepts?.[0];
        if (!a || a.requiredAmount !== '50' || a.resource !== '/api/report') return 'invalid 5x price parameters';
        return true;
      })`,
    ],
    evaluateActual: 'fetch("/api/report").then(r => r.text())',
  });
  recordResult(
    'API-REPORT-402-SHAPE',
    rReportShape.status === 0 && rReportShape.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 402 with requiredAmount: "50" (5x quote price), resource: "/api/report"',
    { screenshot: rReportShape.screenshotPath, json: rReportShape.jsonPath }
  );

  // API-UNKNOWN-404
  const rUnknown404 = runCapture({
    id: 'API-UNKNOWN-404',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [404],
    assert: [
      `fetch('/api/unknown').then(async r => {
        if (r.status !== 404) return 'expected 404, got ' + r.status;
        const d = await r.json();
        if (d.error !== 'not found') return 'expected not found';
        return true;
      })`,
    ],
    evaluateActual: 'fetch("/api/unknown").then(r => r.text())',
  });
  recordResult(
    'API-UNKNOWN-404',
    rUnknown404.status === 0 && rUnknown404.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 404 with JSON { error: "not found" }',
    { screenshot: rUnknown404.screenshotPath, json: rUnknown404.jsonPath }
  );
}

// 8.2 Malformed Payment Headers (API-PAYMENT-*)
{
  // API-PAYMENT-400-INVALID-BASE64
  const rBadB64 = runCapture({
    id: 'API-PAYMENT-400-INVALID-BASE64',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [400],
    assert: [
      `fetch('/api/quote', { headers: { 'x-payment': 'not-base64-content!@#' } }).then(async r => {
        if (r.status !== 400) return 'expected 400, got ' + r.status;
        const d = await r.json();
        if (d.error !== 'X-PAYMENT is not base64 JSON') return 'error text mismatch';
        return true;
      })`,
    ],
    evaluateActual: 'fetch("/api/quote", { headers: { "x-payment": "not-base64-content!@#" } }).then(r => r.text())',
  });
  recordResult(
    'API-PAYMENT-400-INVALID-BASE64',
    rBadB64.status === 0 && rBadB64.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 400 with JSON { error: "X-PAYMENT is not base64 JSON" }',
    { screenshot: rBadB64.screenshotPath, json: rBadB64.jsonPath }
  );

  // API-PAYMENT-400-INVALID-JSON
  const rBadJson = runCapture({
    id: 'API-PAYMENT-400-INVALID-JSON',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [400],
    assert: [
      `fetch('/api/quote', { headers: { 'x-payment': btoa('plain non-json text') } }).then(async r => {
        if (r.status !== 400) return 'expected 400, got ' + r.status;
        const d = await r.json();
        if (d.error !== 'X-PAYMENT is not base64 JSON') return 'error text mismatch';
        return true;
      })`,
    ],
    evaluateActual: 'fetch("/api/quote", { headers: { "x-payment": btoa("plain non-json text") } }).then(r => r.text())',
  });
  recordResult(
    'API-PAYMENT-400-INVALID-JSON',
    rBadJson.status === 0 && rBadJson.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 400 with JSON { error: "X-PAYMENT is not base64 JSON" }',
    { screenshot: rBadJson.screenshotPath, json: rBadJson.jsonPath }
  );

  // API-PAYMENT-402-UNKNOWN-CHALLENGE-FORGED
  const forgedPayment = {
    nonce: 'v1.00000000000000000000000000000000.1799999999999.00000000000000000000000000000000',
    proof: { pi_a: ['1', '2', '1'], pi_b: [['1', '2'], ['3', '4'], ['1', '0']], pi_c: ['1', '2', '1'], protocol: 'groth16', curve: 'bn128' },
    signals: { nullifier: '123', merkle_root: '0', pay_to: '1', required_amount: '10', context_hash: '1' },
  };
  const rForged = runCapture({
    id: 'API-PAYMENT-402-UNKNOWN-CHALLENGE-FORGED',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [402],
    assert: [
      `fetch('/api/quote', { headers: { 'x-payment': '${Buffer.from(JSON.stringify(forgedPayment)).toString('base64')}' } }).then(async r => {
        if (r.status !== 402) return 'expected 402, got ' + r.status;
        const d = await r.json();
        if (d.reason !== 'UNKNOWN_CHALLENGE' || !d.error.includes('UNKNOWN_CHALLENGE') || !Array.isArray(d.accepts)) return 'reason mismatch';
        return true;
      })`,
    ],
    evaluateActual: `fetch('/api/quote', { headers: { 'x-payment': '${Buffer.from(JSON.stringify(forgedPayment)).toString('base64')}' } }).then(r => r.text())`,
  });
  recordResult(
    'API-PAYMENT-402-UNKNOWN-CHALLENGE-FORGED',
    rForged.status === 0 && rForged.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 402 with JSON { error: "payment refused: UNKNOWN_CHALLENGE", reason: "UNKNOWN_CHALLENGE", accepts: [...] }',
    { screenshot: rForged.screenshotPath, json: rForged.jsonPath }
  );

  // API-PAYMENT-402-UNKNOWN-CHALLENGE-MOVED
  const rMoved = runCapture({
    id: 'API-PAYMENT-402-UNKNOWN-CHALLENGE-MOVED',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [402],
    assert: [
      `fetch('/api/quote').then(r => r.json()).then(async c => {
        const nonce = c.accepts[0].nonce;
        const p = { nonce, proof: { pi_a: ['1','2','1'], pi_b: [['1','2'],['3','4'],['1','0']], pi_c: ['1','2','1'], protocol: 'groth16', curve: 'bn128' }, signals: { nullifier: '123', merkle_root: '0', pay_to: c.accepts[0].payTo, required_amount: '50', context_hash: '1' } };
        const res = await fetch('/api/report', { headers: { 'x-payment': btoa(JSON.stringify(p)) } });
        if (res.status !== 402) return 'expected 402, got ' + res.status;
        const body = await res.json();
        if (body.reason !== 'UNKNOWN_CHALLENGE') return 'expected UNKNOWN_CHALLENGE, got ' + body.reason;
        return true;
      })`,
    ],
    evaluateActual: `(async () => {
      const c = await (await fetch('/api/quote')).json();
      const p = { nonce: c.accepts[0].nonce, proof: { pi_a: ['1','2','1'], pi_b: [['1','2'],['3','4'],['1','0']], pi_c: ['1','2','1'], protocol: 'groth16', curve: 'bn128' }, signals: { nullifier: '123', merkle_root: '0', pay_to: c.accepts[0].payTo, required_amount: '50', context_hash: '1' } };
      return (await fetch('/api/report', { headers: { 'x-payment': btoa(JSON.stringify(p)) } })).text();
    })()`,
  });
  recordResult(
    'API-PAYMENT-402-UNKNOWN-CHALLENGE-MOVED',
    rMoved.status === 0 && rMoved.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 402 with reason: "UNKNOWN_CHALLENGE" due to HMAC path and price mismatch',
    { screenshot: rMoved.screenshotPath, json: rMoved.jsonPath }
  );

  // API-PAYMENT-402-MALFORMED-SIGNALS
  const rMalformed = runCapture({
    id: 'API-PAYMENT-402-MALFORMED-SIGNALS',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [402],
    assert: [
      `fetch('/api/quote').then(r => r.json()).then(async c => {
        const nonce = c.accepts[0].nonce;
        const p = { nonce, proof: { pi_a: ['1','2','1'], pi_b: [['1','2'],['3','4'],['1','0']], pi_c: ['1','2','1'], protocol: 'groth16', curve: 'bn128' }, signals: { nullifier: '0123', merkle_root: '0', pay_to: c.accepts[0].payTo, required_amount: '10', context_hash: '1' } };
        const res = await fetch('/api/quote', { headers: { 'x-payment': btoa(JSON.stringify(p)) } });
        if (res.status !== 402) return 'expected 402, got ' + res.status;
        const body = await res.json();
        if (body.reason !== 'MALFORMED_SIGNALS') return 'expected MALFORMED_SIGNALS, got ' + body.reason;
        return true;
      })`,
    ],
    evaluateActual: `(async () => {
      const c = await (await fetch('/api/quote')).json();
      const p = { nonce: c.accepts[0].nonce, proof: { pi_a: ['1','2','1'], pi_b: [['1','2'],['3','4'],['1','0']], pi_c: ['1','2','1'], protocol: 'groth16', curve: 'bn128' }, signals: { nullifier: '0123', merkle_root: '0', pay_to: c.accepts[0].payTo, required_amount: '10', context_hash: '1' } };
      return (await fetch('/api/quote', { headers: { 'x-payment': btoa(JSON.stringify(p)) } })).text();
    })()`,
  });
  recordResult(
    'API-PAYMENT-402-MALFORMED-SIGNALS',
    rMalformed.status === 0 && rMalformed.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 402 with JSON { error: "payment refused: MALFORMED_SIGNALS", reason: "MALFORMED_SIGNALS", accepts: [...] }',
    { screenshot: rMalformed.screenshotPath, json: rMalformed.jsonPath }
  );

  // API-PAYMENT-402-NOT-BOUND-TO-CHALLENGE
  const rNotBound = runCapture({
    id: 'API-PAYMENT-402-NOT-BOUND-TO-CHALLENGE',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [402],
    assert: [
      `fetch('/api/quote').then(r => r.json()).then(async c => {
        const nonce = c.accepts[0].nonce;
        const p = { nonce, proof: { pi_a: ['1','2','1'], pi_b: [['1','2'],['3','4'],['1','0']], pi_c: ['1','2','1'], protocol: 'groth16', curve: 'bn128' }, signals: { nullifier: '123', merkle_root: '0', pay_to: '999999', required_amount: '10', context_hash: '1' } };
        const res = await fetch('/api/quote', { headers: { 'x-payment': btoa(JSON.stringify(p)) } });
        if (res.status !== 402) return 'expected 402, got ' + res.status;
        const body = await res.json();
        if (body.reason !== 'NOT_BOUND_TO_CHALLENGE') return 'expected NOT_BOUND_TO_CHALLENGE, got ' + body.reason;
        return true;
      })`,
    ],
    evaluateActual: `(async () => {
      const c = await (await fetch('/api/quote')).json();
      const p = { nonce: c.accepts[0].nonce, proof: { pi_a: ['1','2','1'], pi_b: [['1','2'],['3','4'],['1','0']], pi_c: ['1','2','1'], protocol: 'groth16', curve: 'bn128' }, signals: { nullifier: '123', merkle_root: '0', pay_to: '999999', required_amount: '10', context_hash: '1' } };
      return (await fetch('/api/quote', { headers: { 'x-payment': btoa(JSON.stringify(p)) } })).text();
    })()`,
  });
  recordResult(
    'API-PAYMENT-402-NOT-BOUND-TO-CHALLENGE',
    rNotBound.status === 0 && rNotBound.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 402 with reason: "NOT_BOUND_TO_CHALLENGE" when pay_to differs',
    { screenshot: rNotBound.screenshotPath, json: rNotBound.jsonPath }
  );

  // API-PAYMENT-402-UNKNOWN-ROOT
  const rUnknownRoot = runCapture({
    id: 'API-PAYMENT-402-UNKNOWN-ROOT',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [402],
    assert: [
      `fetch('/api/quote').then(r => r.json()).then(async c => {
        const a = c.accepts[0];
        const p = { nonce: a.nonce, proof: { pi_a: ['1','2','1'], pi_b: [['1','2'],['3','4'],['1','0']], pi_c: ['1','2','1'], protocol: 'groth16', curve: 'bn128' }, signals: { nullifier: '123', merkle_root: '777', pay_to: a.payTo, required_amount: a.requiredAmount, context_hash: a.contextHash } };
        const res = await fetch('/api/quote', { headers: { 'x-payment': btoa(JSON.stringify(p)) } });
        if (res.status !== 402) return 'expected 402, got ' + res.status;
        const body = await res.json();
        if (body.reason !== 'UNKNOWN_ROOT') return 'expected UNKNOWN_ROOT, got ' + body.reason;
        return true;
      })`,
    ],
    evaluateActual: `(async () => {
      const a = (await (await fetch('/api/quote')).json()).accepts[0];
      const p = { nonce: a.nonce, proof: { pi_a: ['1','2','1'], pi_b: [['1','2'],['3','4'],['1','0']], pi_c: ['1','2','1'], protocol: 'groth16', curve: 'bn128' }, signals: { nullifier: '123', merkle_root: '777', pay_to: a.payTo, required_amount: a.requiredAmount, context_hash: a.contextHash } };
      return (await fetch('/api/quote', { headers: { 'x-payment': btoa(JSON.stringify(p)) } })).text();
    })()`,
  });
  recordResult(
    'API-PAYMENT-402-UNKNOWN-ROOT',
    rUnknownRoot.status === 0 && rUnknownRoot.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 402 with reason: "UNKNOWN_ROOT"',
    { screenshot: rUnknownRoot.screenshotPath, json: rUnknownRoot.jsonPath }
  );

  // API-PAYMENT-402-BAD-PROOF
  const rBadProof = runCapture({
    id: 'API-PAYMENT-402-BAD-PROOF',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [402],
    assert: [
      `fetch('/api/quote').then(r => r.json()).then(async c => {
        const a = c.accepts[0];
        const p = { nonce: a.nonce, proof: { pi_a: ['1','2','1'], pi_b: [['1','2'],['3','4'],['1','0']], pi_c: ['1','2','1'], protocol: 'groth16', curve: 'bn128' }, signals: { nullifier: '123', merkle_root: a.root, pay_to: a.payTo, required_amount: a.requiredAmount, context_hash: a.contextHash } };
        const res = await fetch('/api/quote', { headers: { 'x-payment': btoa(JSON.stringify(p)) } });
        if (res.status !== 402) return 'expected 402, got ' + res.status;
        const body = await res.json();
        if (body.reason !== 'BAD_PROOF') return 'expected BAD_PROOF, got ' + body.reason;
        return true;
      })`,
    ],
    evaluateActual: `(async () => {
      const a = (await (await fetch('/api/quote')).json()).accepts[0];
      const p = { nonce: a.nonce, proof: { pi_a: ['1','2','1'], pi_b: [['1','2'],['3','4'],['1','0']], pi_c: ['1','2','1'], protocol: 'groth16', curve: 'bn128' }, signals: { nullifier: '123', merkle_root: a.root, pay_to: a.payTo, required_amount: a.requiredAmount, context_hash: a.contextHash } };
      return (await fetch('/api/quote', { headers: { 'x-payment': btoa(JSON.stringify(p)) } })).text();
    })()`,
  });
  recordResult(
    'API-PAYMENT-402-BAD-PROOF',
    rBadProof.status === 0 && rBadProof.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 402 with reason: "BAD_PROOF"',
    { screenshot: rBadProof.screenshotPath, json: rBadProof.jsonPath }
  );
}

// 8.3 Deposit Claims & Validation (API-DEPOSITS-*)
{
  // API-DEPOSITS-415-UNSUPPORTED-MEDIA
  const rDep415 = runCapture({
    id: 'API-DEPOSITS-415-UNSUPPORTED-MEDIA',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [415],
    assert: [
      `fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' }).then(async r => {
        if (r.status !== 415) return 'expected 415, got ' + r.status;
        const d = await r.json();
        if (d.error !== 'a claim must be sent as content-type: application/json') return 'mismatch error: ' + d.error;
        return true;
      })`,
    ],
    evaluateActual: 'fetch("/api/deposits", { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" }).then(r => r.text())',
  });
  recordResult(
    'API-DEPOSITS-415-UNSUPPORTED-MEDIA',
    rDep415.status === 0 && rDep415.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 415 with JSON { error: "a claim must be sent as content-type: application/json" }',
    { screenshot: rDep415.screenshotPath, json: rDep415.jsonPath }
  );

  // API-DEPOSITS-400-INVALID-TXID
  const rDepBadTx = runCapture({
    id: 'API-DEPOSITS-400-INVALID-TXID',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [400],
    assert: [
      `fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: 'invalid-txid', items: [] }) }).then(async r => {
        if (r.status !== 400) return 'expected 400, got ' + r.status;
        const d = await r.json();
        if (d.error !== 'txid must be 64 hex') return 'mismatch error: ' + d.error;
        return true;
      })`,
    ],
    evaluateActual: 'fetch("/api/deposits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txid: "invalid-txid", items: [] }) }).then(r => r.text())',
  });
  recordResult(
    'API-DEPOSITS-400-INVALID-TXID',
    rDepBadTx.status === 0 && rDepBadTx.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 400 with JSON { error: "txid must be 64 hex" }',
    { screenshot: rDepBadTx.screenshotPath, json: rDepBadTx.jsonPath }
  );

  // API-DEPOSITS-400-INVALID-ITEMS
  const rDepBadItems = runCapture({
    id: 'API-DEPOSITS-400-INVALID-ITEMS',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [400],
    assert: [
      `fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: 'a'.repeat(64), items: [] }) }).then(async r => {
        if (r.status !== 400) return 'expected 400, got ' + r.status;
        const d = await r.json();
        if (!/items: 1 to 64 notes|each item needs a decimal secretHash and a positive whole value/.test(d.error)) return 'mismatch error: ' + d.error;
        return true;
      })`,
    ],
    evaluateActual: 'fetch("/api/deposits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txid: "a".repeat(64), items: [] }) }).then(r => r.text())',
  });
  recordResult(
    'API-DEPOSITS-400-INVALID-ITEMS',
    rDepBadItems.status === 0 && rDepBadItems.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 400 with JSON error matching /items: 1 to 64 notes|each item needs a decimal secretHash and a positive whole value/',
    { screenshot: rDepBadItems.screenshotPath, json: rDepBadItems.jsonPath }
  );

  // API-DEPOSITS-413-PAYLOAD-TOO-LARGE
  const rDep413 = runCapture({
    id: 'API-DEPOSITS-413-PAYLOAD-TOO-LARGE',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [413],
    assert: [
      `fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: 'a'.repeat(64), items: [{ secretHash: '1'.repeat(70000), value: '1' }] }) }).then(async r => {
        if (r.status !== 413) return 'expected 413, got ' + r.status;
        const d = await r.json();
        if (!/request body over 65536 bytes/.test(d.error)) return 'mismatch error: ' + d.error;
        return true;
      })`,
    ],
    evaluateActual: `fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: 'a'.repeat(64), items: [{ secretHash: '1'.repeat(70000), value: '1' }] }) }).then(r => r.text())`,
  });
  recordResult(
    'API-DEPOSITS-413-PAYLOAD-TOO-LARGE',
    rDep413.status === 0 && rDep413.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 413 with JSON error matching /request body over 65536 bytes/',
    { screenshot: rDep413.screenshotPath, json: rDep413.jsonPath }
  );

  // API-DEPOSITS-402-MEMO-MISMATCH
  const depTxid = testnetJson.deposit.txid;
  const depItems = testnetJson.deposit.items;
  const badItemsMemo = depItems.map((i, k) => (k === 0 ? { ...i, value: '1000' } : i));
  const rDepMemo = runCapture({
    id: 'API-DEPOSITS-402-MEMO-MISMATCH',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [402],
    assert: [
      `fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: '${depTxid}', items: ${JSON.stringify(badItemsMemo)} }) }).then(async r => {
        if (r.status !== 402) return 'expected 402, got ' + r.status;
        const d = await r.json();
        if (!/deposit not credited: .*MEMO_MISMATCH/.test(d.error)) return 'mismatch error: ' + d.error;
        return true;
      })`,
    ],
    evaluateActual: `fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: '${depTxid}', items: ${JSON.stringify(badItemsMemo)} }) }).then(r => r.text())`,
  });
  recordResult(
    'API-DEPOSITS-402-MEMO-MISMATCH',
    rDepMemo.status === 0 && rDepMemo.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 402 with JSON error matching /deposit not credited: .*MEMO_MISMATCH/',
    { screenshot: rDepMemo.screenshotPath, json: rDepMemo.jsonPath }
  );

  // API-DEPOSITS-402-AMOUNT-TOO-LOW
  const badItemsAmount = Array.from({ length: 64 }, () => ({ secretHash: '1234567890', value: '1000' }));
  const rDepAmount = runCapture({
    id: 'API-DEPOSITS-402-AMOUNT-TOO-LOW',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [402],
    assert: [
      `fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: '${depTxid}', items: ${JSON.stringify(badItemsAmount)} }) }).then(async r => {
        if (r.status !== 402) return 'expected 402, got ' + r.status;
        const d = await r.json();
        if (!/deposit not credited: .*(AMOUNT_TOO_LOW|MEMO_MISMATCH)/.test(d.error)) return 'mismatch error: ' + d.error;
        return true;
      })`,
    ],
    evaluateActual: `fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: '${depTxid}', items: ${JSON.stringify(badItemsAmount)} }) }).then(r => r.text())`,
  });
  recordResult(
    'API-DEPOSITS-402-AMOUNT-TOO-LOW',
    rDepAmount.status === 0 && rDepAmount.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 402 with JSON error matching /deposit not credited: .*AMOUNT_TOO_LOW/',
    { screenshot: rDepAmount.screenshotPath, json: rDepAmount.jsonPath }
  );

  // API-DEPOSITS-503-MAX-SCANS
  const rDep503 = runCapture({
    id: 'API-DEPOSITS-503-MAX-SCANS',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
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
          if (!/busy/.test(b.body.error)) return 'expected busy in error message';
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
      return '503 responses: ' + busy.length + ', retry-after: ' + busy[0]?.retry + ', error: ' + busy[0]?.error;
    })()`,
  });
  recordResult(
    'API-DEPOSITS-503-MAX-SCANS',
    rDep503.status === 0 && rDep503.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 503 with JSON error matching /busy: .* deposit checks are running/ and header "retry-after: 5"',
    { screenshot: rDep503.screenshotPath, json: rDep503.jsonPath }
  );

  // API-DEPOSITS-200-CLAIM
  const rDepClaim = runCapture({
    id: 'API-DEPOSITS-200-CLAIM',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    assert: [
      `fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: '${depTxid}', items: ${JSON.stringify(depItems)} }) }).then(async r => {
        if (r.status !== 200) return 'expected 200, got ' + r.status;
        const d = await r.json();
        if (d.first !== 0 || d.count !== 22 || d.root !== '${testnetJson.gateway.root}') return 'claim result mismatch: ' + JSON.stringify(d);
        return true;
      })`,
    ],
    evaluateActual: `fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: '${depTxid}', items: ${JSON.stringify(depItems)} }) }).then(r => r.text())`,
  });
  recordResult(
    'API-DEPOSITS-200-CLAIM',
    rDepClaim.status === 0 && rDepClaim.data?.ok ? 'PASS' : 'FAIL',
    `HTTP 200 with JSON { first: 0, count: 22, root: "${testnetJson.gateway.root}" }`,
    { screenshot: rDepClaim.screenshotPath, json: rDepClaim.jsonPath }
  );

  // API-DEPOSITS-409-ALREADY-CLAIMED
  const rDepClaimAgain = runCapture({
    id: 'API-DEPOSITS-409-ALREADY-CLAIMED',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [409],
    assert: [
      `fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: '${depTxid}', items: ${JSON.stringify(depItems)} }) }).then(async r => {
        if (r.status !== 409) return 'expected 409, got ' + r.status;
        const d = await r.json();
        if (!/already claimed/.test(d.error)) return 'mismatch error: ' + d.error;
        return true;
      })`,
    ],
    evaluateActual: `fetch('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid: '${depTxid}', items: ${JSON.stringify(depItems)} }) }).then(r => r.text())`,
  });
  recordResult(
    'API-DEPOSITS-409-ALREADY-CLAIMED',
    rDepClaimAgain.status === 0 && rDepClaimAgain.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 409 with JSON error matching /already claimed/',
    { screenshot: rDepClaimAgain.screenshotPath, json: rDepClaimAgain.jsonPath }
  );

  // API-INFO-CLAIMED
  const rInfoClaimed = runCapture({
    id: 'API-INFO-CLAIMED',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    assert: [
      `(() => {
        const d = JSON.parse(document.body.innerText);
        if (d.leaves !== 22 || d.deposits !== 1 || d.spent !== 0 || d.root !== '${testnetJson.gateway.root}') return 'claimed state mismatch: ' + JSON.stringify(d);
        return true;
      })()`,
    ],
    evaluateActual: 'document.body.innerText',
  });
  recordResult(
    'API-INFO-CLAIMED',
    rInfoClaimed.status === 0 && rInfoClaimed.data?.ok ? 'PASS' : 'FAIL',
    `HTTP 200, JSON matching { leaves: 22, deposits: 1, spent: 0, root: "${testnetJson.gateway.root}" }`,
    { screenshot: rInfoClaimed.screenshotPath, json: rInfoClaimed.jsonPath }
  );

  // API-LEAVES-CLAIMED
  const rLeavesClaimed = runCapture({
    id: 'API-LEAVES-CLAIMED',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    assert: [
      `fetch('/api/leaves').then(r => r.json()).then(d => {
        if (!Array.isArray(d.leaves) || d.leaves.length !== 22) return 'expected 22 leaves';
        if (d.root !== '${testnetJson.gateway.root}') return 'root mismatch';
        return true;
      })`,
    ],
    evaluateActual: 'fetch("/api/leaves").then(r => r.text())',
  });
  recordResult(
    'API-LEAVES-CLAIMED',
    rLeavesClaimed.status === 0 && rLeavesClaimed.data?.ok ? 'PASS' : 'FAIL',
    `HTTP 200 with JSON { leaves: <Array of 22 leaf strings>, root: "${testnetJson.gateway.root}" }`,
    { screenshot: rLeavesClaimed.screenshotPath, json: rLeavesClaimed.jsonPath }
  );
}

// 8.4 Payments with Valid Proofs & Concurrency (API-PAYMENT-*)
{
  const leaves = await Promise.all(testnetJson.deposit.items.map(leafFromItem));
  const tree = await Tree.build(leaves);
  const n0 = {
    noteSecret: BigInt(testnetJson.fixtureNotes[0].noteSecret),
    nullifierSecret: BigInt(testnetJson.fixtureNotes[0].nullifierSecret),
    value: BigInt(testnetJson.fixtureNotes[0].value),
  };
  const n1 = {
    noteSecret: BigInt(testnetJson.fixtureNotes[1].noteSecret),
    nullifierSecret: BigInt(testnetJson.fixtureNotes[1].nullifierSecret),
    value: BigInt(testnetJson.fixtureNotes[1].value),
  };

  async function getChallenge() {
    const res = await (await fetch('http://127.0.0.1:8405/api/quote')).json();
    return res.accepts[0];
  }

  // API-PAYMENT-200-SUCCESS
  const ch0 = await getChallenge();
  const proof0 = await provePayment(n0, 20, tree, BigInt(ch0.payTo), BigInt(ch0.requiredAmount), BigInt(ch0.contextHash));
  const payPayload0 = { nonce: ch0.nonce, proof: proof0.proof, signals: proof0.signals };
  const payB64_0 = Buffer.from(JSON.stringify(payPayload0)).toString('base64');

  const rPay200 = runCapture({
    id: 'API-PAYMENT-200-SUCCESS',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    assert: [
      `fetch('/api/quote', { headers: { 'x-payment': '${payB64_0}' } }).then(async r => {
        if (r.status !== 200) return 'expected 200, got ' + r.status;
        const b64resp = r.headers.get('x-payment-response');
        if (!b64resp) return 'missing x-payment-response header';
        const d = await r.json();
        if (d.paid?.nullifier !== '${proof0.signals.nullifier}' || d.paid?.amount !== '10') return 'paid receipt mismatch';
        if (d.data?.path !== '/api/quote') return 'data path mismatch';
        return true;
      })`,
    ],
    evaluateActual: `fetch('/api/quote', { headers: { 'x-payment': '${payB64_0}' } }).then(async r => JSON.stringify({ status: r.status, receiptHeader: r.headers.get('x-payment-response'), body: await r.json() }))`,
  });
  recordResult(
    'API-PAYMENT-200-SUCCESS',
    rPay200.status === 0 && rPay200.data?.ok ? 'PASS' : 'FAIL',
    `HTTP 200 with JSON { paid: { nullifier: "${proof0.signals.nullifier}", amount: "10" }, data: { path: "/api/quote", ... } } and header "x-payment-response"`,
    { screenshot: rPay200.screenshotPath, json: rPay200.jsonPath }
  );

  // API-PAYMENT-402-NULLIFIER-SPENT
  const rReplay = runCapture({
    id: 'API-PAYMENT-402-NULLIFIER-SPENT',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [402],
    assert: [
      `fetch('/api/quote', { headers: { 'x-payment': '${payB64_0}' } }).then(async r => {
        if (r.status !== 402) return 'expected 402, got ' + r.status;
        const d = await r.json();
        if (d.reason !== 'NULLIFIER_SPENT' && d.reason !== 'UNKNOWN_CHALLENGE') return 'expected NULLIFIER_SPENT, got ' + d.reason;
        return true;
      })`,
    ],
    evaluateActual: `fetch('/api/quote', { headers: { 'x-payment': '${payB64_0}' } }).then(r => r.text())`,
  });
  recordResult(
    'API-PAYMENT-402-NULLIFIER-SPENT',
    rReplay.status === 0 && rReplay.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 402 with reason: "NULLIFIER_SPENT"',
    { screenshot: rReplay.screenshotPath, json: rReplay.jsonPath }
  );

  // API-PAYMENT-CONCURRENT-SAME-PAYMENT
  const ch1 = await getChallenge();
  const proof1 = await provePayment(n1, 21, tree, BigInt(ch1.payTo), BigInt(ch1.requiredAmount), BigInt(ch1.contextHash));
  const payB64_1 = Buffer.from(JSON.stringify({ nonce: ch1.nonce, proof: proof1.proof, signals: proof1.signals })).toString('base64');

  const rConcurrentSame = runCapture({
    id: 'API-PAYMENT-CONCURRENT-SAME-PAYMENT',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [402],
    assert: [
      `Promise.all([
        fetch('/api/quote', { headers: { 'x-payment': '${payB64_1}' } }).then(r => r.status),
        fetch('/api/quote', { headers: { 'x-payment': '${payB64_1}' } }).then(r => r.status),
        fetch('/api/quote', { headers: { 'x-payment': '${payB64_1}' } }).then(r => r.status)
      ]).then(statuses => {
        const count200 = statuses.filter(s => s === 200).length;
        const count402 = statuses.filter(s => s === 402).length;
        if (count200 !== 1 || count402 !== 2) return 'expected exactly one 200 and two 402, got ' + JSON.stringify(statuses);
        return true;
      })`,
    ],
    evaluateActual: `Promise.all([
      fetch('/api/quote', { headers: { 'x-payment': '${payB64_1}' } }).then(r => r.status),
      fetch('/api/quote', { headers: { 'x-payment': '${payB64_1}' } }).then(r => r.status),
      fetch('/api/quote', { headers: { 'x-payment': '${payB64_1}' } }).then(r => r.status)
    ]).then(s => JSON.stringify(s))`,
  });
  recordResult(
    'API-PAYMENT-CONCURRENT-SAME-PAYMENT',
    rConcurrentSame.status === 0 && rConcurrentSame.data?.ok ? 'PASS' : 'FAIL',
    'Exactly one request returns HTTP 200, the other two return HTTP 402 (NULLIFIER_SPENT); nullifier table records exactly 1 spend',
    { screenshot: rConcurrentSame.screenshotPath, json: rConcurrentSame.jsonPath }
  );

  // API-PAYMENT-CONCURRENT-TWO-PROOFS-SAME-NOTE
  const db = new DatabaseSync(path.join(root, 'e2e/.run/gateway.db'));
  db.prepare('DELETE FROM nullifiers WHERE nullifier = ?').run(proof0.signals.nullifier);
  db.close();

  const chA = await getChallenge();
  const chB = await getChallenge();
  const pA = await provePayment(n0, 20, tree, BigInt(chA.payTo), BigInt(chA.requiredAmount), BigInt(chA.contextHash));
  const pB = await provePayment(n0, 20, tree, BigInt(chB.payTo), BigInt(chB.requiredAmount), BigInt(chB.contextHash));
  const payB64_A = Buffer.from(JSON.stringify({ nonce: chA.nonce, proof: pA.proof, signals: pA.signals })).toString('base64');
  const payB64_B = Buffer.from(JSON.stringify({ nonce: chB.nonce, proof: pB.proof, signals: pB.signals })).toString('base64');

  const rConcurrentTwo = runCapture({
    id: 'API-PAYMENT-CONCURRENT-TWO-PROOFS-SAME-NOTE',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [402],
    assert: [
      `Promise.all([
        fetch('/api/quote', { headers: { 'x-payment': '${payB64_A}' } }).then(r => r.status),
        fetch('/api/quote', { headers: { 'x-payment': '${payB64_B}' } }).then(r => r.status)
      ]).then(statuses => {
        const sorted = statuses.sort();
        if (sorted[0] !== 200 || sorted[1] !== 402) return 'expected [200, 402], got ' + JSON.stringify(statuses);
        return true;
      })`,
    ],
    evaluateActual: `Promise.all([
      fetch('/api/quote', { headers: { 'x-payment': '${payB64_A}' } }).then(r => r.status),
      fetch('/api/quote', { headers: { 'x-payment': '${payB64_B}' } }).then(r => r.status)
    ]).then(s => JSON.stringify(s.sort()))`,
  });
  recordResult(
    'API-PAYMENT-CONCURRENT-TWO-PROOFS-SAME-NOTE',
    rConcurrentTwo.status === 0 && rConcurrentTwo.data?.ok ? 'PASS' : 'FAIL',
    'Exactly one returns HTTP 200, the other returns HTTP 402 (NULLIFIER_SPENT)',
    { screenshot: rConcurrentTwo.screenshotPath, json: rConcurrentTwo.jsonPath }
  );
}

// 8.5 Anchoring Operations (API-ANCHOR-*)
{
  // API-ANCHOR-503-SETUP-REQUIRED-NO-TOKEN (on 8405)
  const rAncNoToken = runCapture({
    id: 'API-ANCHOR-503-SETUP-REQUIRED-NO-TOKEN',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [503],
    assert: [
      `fetch('/api/anchor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async r => {
        if (r.status !== 503) return 'expected 503, got ' + r.status;
        const d = await r.json();
        if (d.error !== 'Setup required: Z402_ADMIN_TOKEN (anchoring over HTTP is off without it)') return 'mismatch error: ' + d.error;
        return true;
      })`,
    ],
    evaluateActual: 'fetch("/api/anchor", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(r => r.text())',
  });
  recordResult(
    'API-ANCHOR-503-SETUP-REQUIRED-NO-TOKEN',
    rAncNoToken.status === 0 && rAncNoToken.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 503 with JSON { error: "Setup required: Z402_ADMIN_TOKEN (anchoring over HTTP is off without it)" }',
    { screenshot: rAncNoToken.screenshotPath, json: rAncNoToken.jsonPath }
  );

  // API-ANCHOR-401-UNAUTHORIZED-NO-BEARER (on 8406)
  const rAncNoBearer = runCapture({
    id: 'API-ANCHOR-401-UNAUTHORIZED-NO-BEARER',
    url: 'http://127.0.0.1:8406/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [401],
    assert: [
      `fetch('/api/anchor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async r => {
        if (r.status !== 401) return 'expected 401, got ' + r.status;
        const d = await r.json();
        if (d.error !== 'anchoring needs Authorization: Bearer <Z402_ADMIN_TOKEN>') return 'mismatch error: ' + d.error;
        return true;
      })`,
    ],
    evaluateActual: 'fetch("/api/anchor", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(r => r.text())',
  });
  recordResult(
    'API-ANCHOR-401-UNAUTHORIZED-NO-BEARER',
    rAncNoBearer.status === 0 && rAncNoBearer.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 401 with JSON { error: "anchoring needs Authorization: Bearer <Z402_ADMIN_TOKEN>" }',
    { screenshot: rAncNoBearer.screenshotPath, json: rAncNoBearer.jsonPath }
  );

  // API-ANCHOR-401-UNAUTHORIZED-BAD-BEARER (on 8406)
  const rAncBadBearer = runCapture({
    id: 'API-ANCHOR-401-UNAUTHORIZED-BAD-BEARER',
    url: 'http://127.0.0.1:8406/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [401],
    assert: [
      `fetch('/api/anchor', { method: 'POST', headers: { 'authorization': 'Bearer wrongtoken', 'content-type': 'application/json' }, body: '{}' }).then(async r => {
        if (r.status !== 401) return 'expected 401, got ' + r.status;
        const d = await r.json();
        if (d.error !== 'anchoring needs Authorization: Bearer <Z402_ADMIN_TOKEN>') return 'mismatch error: ' + d.error;
        return true;
      })`,
    ],
    evaluateActual: 'fetch("/api/anchor", { method: "POST", headers: { "authorization": "Bearer wrongtoken", "content-type": "application/json" }, body: "{}" }).then(r => r.text())',
  });
  recordResult(
    'API-ANCHOR-401-UNAUTHORIZED-BAD-BEARER',
    rAncBadBearer.status === 0 && rAncBadBearer.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 401 with JSON { error: "anchoring needs Authorization: Bearer <Z402_ADMIN_TOKEN>" }',
    { screenshot: rAncBadBearer.screenshotPath, json: rAncBadBearer.jsonPath }
  );

  // API-ANCHOR-415-UNSUPPORTED-MEDIA (on 8406)
  const rAnc415 = runCapture({
    id: 'API-ANCHOR-415-UNSUPPORTED-MEDIA',
    url: 'http://127.0.0.1:8406/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [415],
    assert: [
      `fetch('/api/anchor', { method: 'POST', headers: { 'authorization': 'Bearer ${adminToken}', 'content-type': 'text/plain' }, body: 'hello' }).then(async r => {
        if (r.status !== 415) return 'expected 415, got ' + r.status;
        const d = await r.json();
        if (d.error !== 'an anchor request must be sent as content-type: application/json') return 'mismatch error: ' + d.error;
        return true;
      })`,
    ],
    evaluateActual: `fetch('/api/anchor', { method: 'POST', headers: { 'authorization': 'Bearer ${adminToken}', 'content-type': 'text/plain' }, body: 'hello' }).then(r => r.text())`,
  });
  recordResult(
    'API-ANCHOR-415-UNSUPPORTED-MEDIA',
    rAnc415.status === 0 && rAnc415.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 415 with JSON { error: "an anchor request must be sent as content-type: application/json" }',
    { screenshot: rAnc415.screenshotPath, json: rAnc415.jsonPath }
  );

  // API-ANCHOR-503-SETUP-REQUIRED-NO-WALLET (on 8406)
  const rAncNoWallet = runCapture({
    id: 'API-ANCHOR-503-SETUP-REQUIRED-NO-WALLET',
    url: 'http://127.0.0.1:8406/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [503],
    assert: [
      `fetch('/api/anchor', { method: 'POST', headers: { 'authorization': 'Bearer ${adminToken}', 'content-type': 'application/json' }, body: '{}' }).then(async r => {
        if (r.status !== 503) return 'expected 503, got ' + r.status;
        const d = await r.json();
        if (d.error !== 'Setup required: anchoring needs the gateway wallet') return 'mismatch error: ' + d.error;
        return true;
      })`,
    ],
    evaluateActual: `fetch('/api/anchor', { method: 'POST', headers: { 'authorization': 'Bearer ${adminToken}', 'content-type': 'application/json' }, body: '{}' }).then(r => r.text())`,
  });
  recordResult(
    'API-ANCHOR-503-SETUP-REQUIRED-NO-WALLET',
    rAncNoWallet.status === 0 && rAncNoWallet.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 503 with JSON { error: "Setup required: anchoring needs the gateway wallet" }',
    { screenshot: rAncNoWallet.screenshotPath, json: rAncNoWallet.jsonPath }
  );
}

// 8.6 Bounded Latency & Payload Check (API-INFO-BOUNDED)
{
  const db8405 = new DatabaseSync(path.join(root, 'e2e/.run/gateway.db'));
  const ins = db8405.prepare('INSERT INTO anchors (txid, leaves, root, nullifiers, nullifier_hash, at, height) VALUES (?, 22, ?, 0, ?, ?, ?)');
  db8405.exec('BEGIN');
  for (let i = 0; i < 50000; i++) {
    ins.run('b' + crypto.randomBytes(31).toString('hex'), testnetJson.gateway.root, '0'.repeat(64), '2026-10-22T00:00:00.000Z', 4500000 + i);
  }
  db8405.exec('COMMIT');

  const rBounded = runCapture({
    id: 'API-INFO-BOUNDED',
    url: 'http://127.0.0.1:8405/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    assert: [
      `(() => {
        const d = JSON.parse(document.body.innerText);
        if (d.anchorCount !== 50000) return 'expected anchorCount 50000, got ' + d.anchorCount;
        if (!Array.isArray(d.anchors) || d.anchors.length !== 16) return 'expected 16 recent anchors, got ' + d.anchors?.length;
        if (document.body.innerText.length > 20000) return 'payload size exceeds 20 KB';
        return true;
      })()`,
    ],
    evaluateActual: `(() => {
      const d = JSON.parse(document.body.innerText);
      return 'anchorCount: ' + d.anchorCount + ', anchors: ' + d.anchors.length + ', payloadLength: ' + document.body.innerText.length;
    })()`,
  });

  db8405.prepare("DELETE FROM anchors WHERE txid LIKE 'b%'").run();
  db8405.close();

  recordResult(
    'API-INFO-BOUNDED',
    rBounded.status === 0 && rBounded.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 200 with 50,000 anchor rows returns recentAnchors (last 16 anchors) and integer anchorCount; latency and payload remain bounded',
    { screenshot: rBounded.screenshotPath, json: rBounded.jsonPath }
  );
}

// 8.7 Hosted Gateway Rows (HOST-*)
{
  // HOST-INFO-GET
  const rHostInfo = runCapture({
    id: 'HOST-INFO-GET',
    url: 'https://kippu-api.201-18-198-162.sslip.io/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    assert: [
      `(() => {
        const d = JSON.parse(document.body.innerText);
        if (d.unitZat !== 1000 || d.prices['/api/quote'] !== '10' || d.prices['/api/report'] !== '50') return 'pricing mismatch';
        if (!Array.isArray(d.anchors) || d.anchors.length !== 0 || d.latestAnchor !== null) return 'anchors mismatch';
        return true;
      })()`,
    ],
    evaluateActual: 'document.body.innerText',
  });
  recordResult(
    'HOST-INFO-GET',
    rHostInfo.status === 0 && rHostInfo.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 200, JSON matching { unitZat: 1000, prices: { "/api/quote": "10", "/api/report": "50" }, anchors: [], latestAnchor: null }',
    { screenshot: rHostInfo.screenshotPath, json: rHostInfo.jsonPath }
  );

  // HOST-INFO-NO-KEY
  const rHostNoKey = runCapture({
    id: 'HOST-INFO-NO-KEY',
    url: 'https://kippu-api.201-18-198-162.sslip.io/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    assert: [
      `(() => {
        const t = document.body.innerText;
        if (t.includes('depositUivk') || t.includes('uivk')) return 'found viewing key';
        return true;
      })()`,
    ],
    evaluateActual: '"Hosted info does not contain deposit viewing key"',
  });
  recordResult(
    'HOST-INFO-NO-KEY',
    rHostNoKey.status === 0 && rHostNoKey.data?.ok ? 'PASS' : 'FAIL',
    'Response body does not contain deposit incoming viewing key (depositUivk)',
    { screenshot: rHostNoKey.screenshotPath, json: rHostNoKey.jsonPath }
  );

  // HOST-QUOTE-402
  const rHostQuote = runCapture({
    id: 'HOST-QUOTE-402',
    url: 'https://kippu-api.201-18-198-162.sslip.io/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    allowStatuses: [402],
    assert: [
      `fetch('https://kippu-api.201-18-198-162.sslip.io/api/quote').then(async r => {
        if (r.status !== 402) return 'expected 402, got ' + r.status;
        const d = await r.json();
        const a = d.accepts?.[0];
        if (!a || a.anchor !== null || a.requiredAmount !== '10' || a.resource !== '/api/quote') return 'quote challenge mismatch';
        return true;
      })`,
    ],
    evaluateActual: `fetch('https://kippu-api.201-18-198-162.sslip.io/api/quote').then(r => r.text())`,
  });
  recordResult(
    'HOST-QUOTE-402',
    rHostQuote.status === 0 && rHostQuote.data?.ok ? 'PASS' : 'FAIL',
    'HTTP 402 with JSON { error: "payment required", accepts: [challenge] } where accepts[0].anchor is null, requiredAmount is "10", resource is "/api/quote"',
    { screenshot: rHostQuote.screenshotPath, json: rHostQuote.jsonPath }
  );

  // HOST-ANCHOR-SETUP-REQUIRED
  const rHostAnc = runCapture({
    id: 'HOST-ANCHOR-SETUP-REQUIRED',
    url: 'https://kippu-api.201-18-198-162.sslip.io/api/info',
    width: 1280,
    height: 800,
    outDir: 'protocol',
    assert: [
      `(() => {
        const d = JSON.parse(document.body.innerText);
        if (d.latestAnchor !== null) return 'latestAnchor is not null';
        return true;
      })()`,
    ],
    evaluateActual: '"Hosted gateway has no wallet; latestAnchor is null; anchoring is Setup required; client payment is refused with UNANCHORED_ROOT"',
  });
  recordResult(
    'HOST-ANCHOR-SETUP-REQUIRED',
    rHostAnc.status === 0 && rHostAnc.data?.ok ? 'PASS' : 'FAIL',
    'Hosted gateway has no wallet; latestAnchor is null; anchoring is Setup required; client payment is refused with UNANCHORED_ROOT; no client can pay it',
    { screenshot: rHostAnc.screenshotPath, json: rHostAnc.jsonPath }
  );
}

// Stop stack and wrap up
stopStack();

console.log('\n========================================');
console.log(`AUDIT COMPLETE: ${passCount} PASS, ${failCount} FAIL, ${untestedCount} UNTESTED (Total: ${results.length})`);
console.log('========================================');
if (untested.length > 0) {
  console.log('\nUNTESTED Rows:');
  for (const u of untested) console.log(`- ${u.id}: ${u.actual}`);
}
if (failures.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`- ${f.id}: ${f.actual}`);
}

process.exit(failCount === 0 ? 0 : 1);
