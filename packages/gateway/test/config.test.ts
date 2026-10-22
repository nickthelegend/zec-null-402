// Configuration fails closed: a blank number means "use the default", anything that is not a whole
// number (or is below its minimum) stops the gateway with Setup required (exit 2) instead of becoming 0
// or NaN. Each gateway here is the real serve.ts in its own process.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as netServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Gateway, intEnv, scanBinary } from '../src/index.js';

const d = JSON.parse(readFileSync(resolve(__dirname, '../../../deployments/testnet.json'), 'utf8'));
const tsx = resolve(__dirname, '../node_modules/.bin/tsx');
const serve = resolve(__dirname, '../src/serve.ts');
const kill: (() => void)[] = [];
afterAll(() => kill.forEach((k) => k()));

const freePort = () =>
  new Promise<number>((r) => {
    const s = netServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => r(port));
    });
  });
const baseEnv = (extra: Record<string, string>) => ({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', Z402_SCAN_BIN: scanBinary(), Z402_STATE: join(mkdtempSync(join(tmpdir(), 'z402-cfg-')), 'state.db'), Z402_DEPOSIT_UA: d.wallets.gateway.address, Z402_DEPOSIT_UIVK: d.wallets.gateway.uivk, ...extra });
const exitOf = (extra: Record<string, string>) => spawnSync(tsx, [serve], { env: baseEnv(extra), encoding: 'utf8', timeout: 60_000 });

describe('gateway settings from the environment', () => {
  it('a blank Z402_UNIT_ZAT or Z402_PRICE_UNITS means the default (1,000 zat, 10 units), never 0', async () => {
    const port = await freePort();
    const child = spawn(tsx, [serve], { env: baseEnv({ Z402_UNIT_ZAT: '', Z402_PRICE_UNITS: '', Z402_PORT: String(port) }), stdio: 'ignore' });
    kill.push(() => child.kill());
    let info: { unitZat: number; prices: Record<string, string> } | null = null;
    for (let i = 0; i < 120 && !info; i++) {
      info = await fetch(`http://127.0.0.1:${port}/api/info`).then((r) => r.json(), () => null);
      if (!info) await new Promise((r) => setTimeout(r, 500));
    }
    expect(info).toMatchObject({ unitZat: 1000, prices: { '/api/quote': '10', '/api/report': '50' } });
  }, 120_000);

  it('a zero, negative, fractional or malformed number stops the gateway: exit 2, Setup required', () => {
    for (const [k, v] of [['Z402_UNIT_ZAT', '0'], ['Z402_UNIT_ZAT', '-5'], ['Z402_UNIT_ZAT', '1e3'], ['Z402_PRICE_UNITS', 'abc'], ['Z402_PRICE_UNITS', '0'], ['Z402_PORT', '84O5'], ['Z402_ANCHOR_EVERY_BLOCKS', '2,880'], ['Z402_ANCHOR_EVERY_BLOCKS', '0']]) {
      const r = exitOf({ [k]: v });
      expect(r.status, `${k}=${v}: ${r.stderr}`).toBe(2);
      expect(r.stderr.trim(), `${k}=${v}`).toMatch(new RegExp(`^Setup required: ${k} \\(`));
    }
  }, 120_000);

  it('intEnv: unset or blank gives the default; digits only, at least the minimum', () => {
    expect(intEnv('X', 7, { min: 1 }, {})).toBe(7);
    expect(intEnv('X', 7, { min: 1 }, { X: '' })).toBe(7);
    expect(intEnv('X', 7, { min: 1 }, { X: '12' })).toBe(12);
    for (const bad of ['0', ' 12', '12 ', '1.5', '0x10', 'NaN', '-1', '99999999999999999999']) expect(() => intEnv('X', 7, { min: 1 }, { X: bad }), bad).toThrow(/^Setup required: X/);
  });

  it('the Gateway itself refuses a unit of 0 zat or a free endpoint', () => {
    const o = { statePath: join(mkdtempSync(join(tmpdir(), 'z402-cfg-')), 'state.db'), depositUa: d.wallets.gateway.address, depositUivk: d.wallets.gateway.uivk, content: () => ({}) };
    expect(() => new Gateway({ ...o, unitZat: 0, prices: { '/api/quote': 10n } })).toThrow(/unitZat/);
    expect(() => new Gateway({ ...o, unitZat: Number.NaN, prices: { '/api/quote': 10n } })).toThrow(/unitZat/);
    expect(() => new Gateway({ ...o, unitZat: 1000, prices: { '/api/quote': 0n } })).toThrow(/price/);
  });
});
