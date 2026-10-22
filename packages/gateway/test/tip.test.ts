// The chain tip read for the gateway's anchor check. It used to run the scan binary synchronously
// (execFileSync, no timeout), which froze the gateway's event loop for as long as lightwalletd took, and
// it returned Number(output): junk became NaN, and `age >= every` is false for NaN, so a bad tip meant
// "never re-anchor". Here the scan binary is replaced by small local scripts (Z402_SCAN_BIN) that print
// what a broken or slow binary would; no network is involved.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chainTip, Gateway } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'z402-tip-'));
const saved = process.env.Z402_SCAN_BIN;
afterEach(() => {
  if (saved === undefined) delete process.env.Z402_SCAN_BIN;
  else process.env.Z402_SCAN_BIN = saved;
});
let n = 0;
/** A stand-in scan binary: a shell script that runs `body`. */
function bin(body: string) {
  const p = join(dir, `scan-${n++}.sh`);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  process.env.Z402_SCAN_BIN = p;
  return p;
}

describe('chainTip', () => {
  it('does not block the event loop while the scan binary runs', async () => {
    bin('sleep 1; echo 4530000');
    let fired = 0;
    const t0 = Date.now();
    const timer = setTimeout(() => (fired = Date.now() - t0), 50);
    const tip = await chainTip();
    clearTimeout(timer);
    expect(tip).toBe(4530000);
    // the 50 ms timer ran while the tip was being read, not after the binary returned
    expect(fired).toBeGreaterThan(0);
    expect(fired).toBeLessThan(800);
  });

  it('rejects output that is not a block height instead of returning NaN', async () => {
    for (const out of ['', 'error: transport error', '4530000abc', '-5', '1e9']) {
      bin(`printf '%s' '${out}'`);
      await expect(chainTip(), out).rejects.toThrow(/block height/);
    }
  });

  it('gives up after its timeout instead of waiting on a hung lightwalletd', async () => {
    bin('sleep 30; echo 4530000');
    const t0 = Date.now();
    await expect(chainTip(300)).rejects.toThrow(/timed out after 300 ms/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('a failing binary is an error, never a height', async () => {
    bin('echo "error: connect failed" >&2; exit 1');
    await expect(chainTip()).rejects.toThrow(/connect failed/);
  });
});

describe('anchorDue with a bad tip', () => {
  it('a tip that is not a whole number is an error (the check is logged and retried), not "no anchor due"', async () => {
    const gw = new Gateway({ statePath: join(dir, 'state.db'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, unitZat: d.unitZat, prices: { '/api/quote': 10n }, content: () => ({}), chainTip: async () => Number.NaN });
    try {
      // one mined anchor over one leaf, so the age check is what decides
      gw.db.prepare('INSERT INTO leaves (idx, leaf) VALUES (0, ?)').run('1');
      gw.db.prepare("INSERT INTO anchors (txid, leaves, root, nullifiers, nullifier_hash, at, height) VALUES (?, 1, '1', 0, ?, ?, 4520000)").run('a'.repeat(64), '0'.repeat(64), new Date().toISOString());
      await expect(gw.anchorDue()).rejects.toThrow(/chain tip/);
    } finally {
      gw.close();
    }
  });
});
