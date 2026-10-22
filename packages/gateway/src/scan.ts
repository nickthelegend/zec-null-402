// Viewing-key checks through the zpay-verify binary (packages/scan). The key goes in the child's
// environment only. A failure to check throws; a verdict is a verdict.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ScanOutput {
  pool: string;
  value: number;
  memo: string | null;
  memo_binary: boolean;
}
export interface ScanResult {
  ok: boolean;
  reasons: string[];
  paidZat: number;
  txid: string;
  found: boolean;
  height: number | null;
  confirmations: number;
  tip: number;
  outputs: ScanOutput[];
  transparent: boolean;
}

export class SetupRequiredError extends Error {
  constructor(public readonly missing: string, detail?: string) {
    super(`Setup required: ${missing}${detail ? ` (${detail})` : ''}`);
    this.name = 'SetupRequiredError';
  }
}

export function scanBinary(env: Record<string, string | undefined> = process.env): string {
  if (env.Z402_SCAN_BIN) {
    if (!existsSync(env.Z402_SCAN_BIN)) throw new SetupRequiredError('Z402_SCAN_BIN', `${env.Z402_SCAN_BIN} does not exist`);
    return env.Z402_SCAN_BIN;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const found = [resolve(here, '../../scan/target/release/zpay-verify'), env.CARGO_TARGET_DIR ? resolve(env.CARGO_TARGET_DIR, 'release/zpay-verify') : ''].find((p) => p && existsSync(p));
  if (!found) throw new SetupRequiredError('Z402_SCAN_BIN', 'build packages/scan (cargo build --release)');
  return found;
}

function lwdEnv(uivk: string, lwdUrl?: string): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', ZPV_UIVK: uivk };
  const url = lwdUrl ?? process.env.Z402_LWD_URL;
  if (url) env.ZPV_LWD_URL = url;
  return env;
}

/** How many scanner processes this process has started (lightwalletd reads), for tests and logs. */
export const scanStats = { spawns: 0 };

/**
 * Runs the scan binary without blocking the event loop; exit 0 and 1 are verdicts (only 0 with
 * `exitZeroOnly`), anything else is a failure to check. With `timeoutMs` the child is killed after that long.
 */
async function runScan(args: string[], env: Record<string, string>, o: { timeoutMs?: number; exitZeroOnly?: boolean } = {}): Promise<string> {
  scanStats.spawns++;
  const { code, out, err, timedOut } = await new Promise<{ code: number | null; out: string; err: string; timedOut: boolean }>((res, rej) => {
    const p = spawn(scanBinary(), args, { env });
    let out = '';
    let err = '';
    let timedOut = false;
    // on timeout: kill it and answer at once (a grandchild holding the pipes must not keep the caller waiting)
    const timer =
      o.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            p.kill('SIGKILL');
            p.stdout.destroy();
            p.stderr.destroy();
            res({ code: null, out, err, timedOut });
          }, o.timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => (timer && clearTimeout(timer), rej(e)));
    p.on('close', (c) => (timer && clearTimeout(timer), res({ code: c, out, err, timedOut })));
  });
  if (timedOut) throw new Error(`scan ${args[0]} timed out after ${o.timeoutMs} ms`);
  if (code !== 0 && (code !== 1 || o.exitZeroOnly)) throw new Error(`scan failed: ${err.replace(/^error: /, '').trim() || `exit ${code}`}`);
  return out;
}

/** Did `txid` pay the holder of `uivk` at least `amountZat` with exactly `memo`? */
export async function scan(uivk: string, txid: string, amountZat: bigint | number, memo: string | undefined, minConf = 1): Promise<ScanResult> {
  const args = ['verify', txid, '--amount', String(amountZat), '--min-conf', String(minConf)];
  if (memo !== undefined) args.push('--memo', memo);
  const out = await runScan(args, lwdEnv(uivk));
  const j = JSON.parse(out) as { report: { txid: string; found: boolean; height: number | null; confirmations: number; tip: number; outputs: ScanOutput[]; pools: { transparent: boolean } }; verdict: { ok: boolean; reasons: string[]; paid_zat: number } };
  return { ok: j.verdict.ok, reasons: j.verdict.reasons, paidZat: j.verdict.paid_zat, txid: j.report.txid, found: j.report.found, height: j.report.height, confirmations: j.report.confirmations, tip: j.report.tip, outputs: j.report.outputs, transparent: j.report.pools.transparent };
}

/**
 * One anchor memo: `z402:anchor:<leaves>:<root>:<spent>:<sha256 of the sorted nullifier set>`, optionally
 * followed by `:<Ed25519 signature, 128 hex>` from the gateway's anchor key (see anchorsig.ts).
 */
export interface AnchorMemo {
  leaves: number;
  root: string;
  nullifiers: number;
  nullifierHash: string;
  /** present on signed anchors */
  signature?: string;
}
export function parseAnchorMemo(memo: string | null | undefined): AnchorMemo | null {
  const m = /^z402:anchor:(0|[1-9]\d{0,9}):(0|[1-9]\d{0,76}):(0|[1-9]\d{0,9}):([0-9a-f]{64})(?::([0-9a-f]{128}))?$/.exec(memo ?? '');
  if (!m) return null;
  return { leaves: Number(m[1]), root: m[2], nullifiers: Number(m[3]), nullifierHash: m[4], ...(m[5] ? { signature: m[5] } : {}) };
}

export interface OnChainAnchor {
  txid: string;
  found: boolean;
  height: number | null;
  confirmations: number;
  tip: number;
  /** anchor memos in outputs to the holder of the viewing key (normally one) */
  anchors: AnchorMemo[];
}

/**
 * Reads the anchor memos of `txid` that the anchor address's viewing key can decrypt, straight from
 * lightwalletd. Used by the gateway to adopt an anchor and by clients to check one themselves.
 */
export async function readAnchor(anchorUivk: string, txid: string, lwdUrl?: string): Promise<OnChainAnchor> {
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error(`anchor txid must be 64 hex, got ${JSON.stringify(String(txid).slice(0, 80))}`);
  const r = JSON.parse(await runScan(['inspect', txid], lwdEnv(anchorUivk, lwdUrl))) as { txid: string; found: boolean; height: number | null; confirmations: number; tip: number; outputs: ScanOutput[] };
  return { txid: r.txid, found: r.found, height: r.height, confirmations: r.confirmations, tip: r.tip, anchors: r.outputs.map((o) => parseAnchorMemo(o.memo)).filter((a): a is AnchorMemo => a !== null) };
}

/** An anchor memo found on-chain, with the tx and block that carry it. */
export interface ScannedAnchor extends AnchorMemo {
  txid: string;
  height: number;
}

/**
 * Every anchor memo sent to the anchor address in a block range, found without knowing any txid: the scan
 * binary trial-decrypts compact blocks from lightwalletd with the anchor viewing key and re-reads each hit.
 * `{ last: n }` is the n blocks ending at the tip; `to` defaults to the tip.
 */
export async function scanAnchors(anchorUivk: string, range: { from: number; to?: number } | { last: number }, lwdUrl?: string): Promise<{ tip: number; from: number; to: number; blocks: number; anchors: ScannedAnchor[] }> {
  const h = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`block height must be a whole number, got ${n}`);
    return String(n);
  };
  const args = 'last' in range ? ['scan-range', '--last', h(range.last)] : ['scan-range', h(range.from), ...(range.to !== undefined ? [h(range.to)] : [])];
  const r = JSON.parse(await runScan(args, lwdEnv(anchorUivk, lwdUrl))) as { tip: number; from: number; to: number; blocks: number; txs: { txid: string; height: number | null; outputs: ScanOutput[] }[] };
  const anchors = r.txs.flatMap((t) => (t.height === null ? [] : t.outputs.map((o) => parseAnchorMemo(o.memo)).filter((a): a is AnchorMemo => a !== null).map((a) => ({ txid: t.txid, height: t.height!, ...a }))));
  return { tip: r.tip, from: r.from, to: r.to, blocks: r.blocks, anchors };
}

/** UFVK → UIVK with the scan binary (env only; the event loop keeps running). */
export async function uivkFromUfvk(ufvk: string, timeoutMs = 30_000): Promise<string> {
  return (await runScan(['derive'], { PATH: process.env.PATH ?? '', ZPV_UFVK: ufvk }, { timeoutMs, exitZeroOnly: true })).trim();
}

/**
 * Current chain height from lightwalletd, read without blocking the event loop and given up after
 * `timeoutMs`. Anything but a whole block height is an error: NaN would make every age check false.
 */
export async function chainTip(timeoutMs = 30_000): Promise<number> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  if (process.env.Z402_LWD_URL) env.ZPV_LWD_URL = process.env.Z402_LWD_URL;
  const out = (await runScan(['tip'], env, { timeoutMs, exitZeroOnly: true })).trim();
  const n = /^\d{1,12}$/.test(out) ? Number(out) : Number.NaN;
  if (!Number.isSafeInteger(n)) throw new Error(`scan tip did not print a block height: ${JSON.stringify(out.slice(0, 80))}`);
  return n;
}
