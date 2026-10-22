// Copied from zec-pq-intents / zec-payment-verify-sdk (same author, MIT). Thin wrapper over zingo-cli (testnet). One process per call; --waitsync so every read is current.
// Never calls `recovery_info` (it prints the seed). Errors carry zingo-cli's own message.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileLock } from './lock.js';

const run = promisify(execFile);

export interface ZingoConfig {
  bin: string;
  server: string;
}

export function zingoConfig(env: Record<string, string | undefined> = process.env): ZingoConfig {
  return {
    bin: env.Z402_ZINGO_CLI ?? join(homedir(), 'src/zingolib/target/release/zingo-cli'),
    server: env.Z402_LWD_URL ?? 'https://testnet.zec.rocks:443',
  };
}

/** The treasury wallet is never used by this repo, whatever a variable says. */
function refuseTreasury(walletDir: string) {
  if (resolve(walletDir).startsWith(resolve(homedir(), 'zec-testnet-wallet'))) throw new Error(`refusing ${walletDir}: the treasury wallet is not used by these examples`);
}

/** zingo-cli's mixnet proxy sometimes fails to start; nothing was sent then, so a retry is safe. */
const MIXNET_NOT_STARTED = /Mixnet Mode could not start/;

async function zingo(cfg: ZingoConfig, walletDir: string, args: string[], timeoutMs = 600_000): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await zingoOnce(cfg, walletDir, args, timeoutMs);
    } catch (e) {
      if (!MIXNET_NOT_STARTED.test((e as Error).message) || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

async function zingoOnce(cfg: ZingoConfig, walletDir: string, args: string[], timeoutMs: number): Promise<string> {
  if (args[0] === 'recovery_info') throw new Error('refusing recovery_info: it prints the seed');
  refuseTreasury(walletDir);
  // One zingo-cli at a time per wallet directory, across processes: two at once on one --data-dir can
  // both spend the same notes, and their mixnet proxies collide.
  const unlock = await fileLock(join(walletDir, '.z402-zingo.lock'), timeoutMs, `wallet ${walletDir}`);
  try {
    const { stdout, stderr } = await run(cfg.bin, ['--chain', 'testnet', '--server', cfg.server, '--data-dir', walletDir, '--waitsync', ...args], {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      cwd: '/tmp',
      env: { ...process.env, ZINGO_SEED: '' },
    });
    return `${stdout}\n${stderr}`;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(`zingo-cli ${args[0]} failed: ${(err.stderr || err.stdout || err.message).trim().split('\n').slice(-3).join(' | ')}`);
  } finally {
    unlock();
  }
}

export async function address(cfg: ZingoConfig, walletDir: string): Promise<string> {
  const out = await zingo(cfg, walletDir, ['addresses']);
  const m = out.match(/"encoded_address":\s*"(utest1[0-9a-z]+)"/);
  if (!m) throw new Error(`no unified address in zingo-cli output for ${walletDir}`);
  return m[1];
}

export async function spendable(cfg: ZingoConfig, walletDir: string): Promise<bigint> {
  const out = await zingo(cfg, walletDir, ['spendable_balance']);
  const m = out.match(/spendable_balance["\s:]+(\d+)/) ?? out.match(/"?balance"?:\s*(\d+)/);
  if (!m) throw new Error(`could not read spendable balance: ${out.slice(-300)}`);
  return BigInt(m[1]);
}

export interface Receiver {
  address: string;
  amount: bigint;
  memo?: string;
}

/** One shielded transaction to all receivers. Returns the broadcast txids. */
export async function quicksend(cfg: ZingoConfig, walletDir: string, receivers: Receiver[]): Promise<string[]> {
  const json = JSON.stringify(receivers.map((r) => ({ address: r.address, amount: Number(r.amount), ...(r.memo ? { memo: r.memo } : {}) })));
  const out = await zingo(cfg, walletDir, ['quicksend', json]);
  const m = out.match(/"txids":\s*\[([^\]]*)\]/);
  if (!m) throw new Error(`quicksend did not report a txid: ${out.trim().split('\n').slice(-4).join(' | ')}`);
  const txids = [...m[1].matchAll(/[0-9a-f]{64}/g)].map((x) => x[0]);
  if (txids.length === 0) throw new Error(`quicksend reported no txids: ${m[0]}`);
  return txids;
}

export interface ValueTransfer {
  txid: string;
  status: string;
  blockheight: number | null;
  kind: string;
  value: bigint;
  memos: string[];
}

/** Parses zingo-cli's `value_transfers` listing. */
export async function valueTransfers(cfg: ZingoConfig, walletDir: string): Promise<ValueTransfer[]> {
  const out = await zingo(cfg, walletDir, ['value_transfers']);
  const blocks = out.split(/\n\{\n/).slice(1);
  return blocks.map((b) => {
    const field = (k: string) => b.match(new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
    const memosLine = field('memos');
    return {
      txid: field('txid'),
      status: field('status'),
      blockheight: /^\d+$/.test(field('blockheight')) ? Number(field('blockheight')) : null,
      kind: field('kind'),
      value: BigInt(/^\d+$/.test(field('value')) ? field('value') : '0'),
      memos: memosLine ? memosLine.split(/,\s*/).filter(Boolean) : [],
    };
  });
}

export async function height(cfg: ZingoConfig, walletDir: string): Promise<number> {
  const out = await zingo(cfg, walletDir, ['height']);
  const m = out.match(/"?height"?:\s*(\d+)/) ?? out.match(/(\d{7})/);
  if (!m) throw new Error('could not read the chain height');
  return Number(m[1]);
}

export async function exportUfvk(cfg: ZingoConfig, walletDir: string): Promise<string> {
  const out = await zingo(cfg, walletDir, ['export_ufvk']);
  const m = out.match(/uviewtest1[0-9a-z]+/);
  if (!m) throw new Error('no UFVK in export_ufvk output');
  return m[0];
}
