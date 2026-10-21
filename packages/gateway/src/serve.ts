#!/usr/bin/env node
// Env: Z402_STATE (gateway state file), Z402_DEPOSIT_UA, Z402_DEPOSIT_UIVK, Z402_UNIT_ZAT (default 1000),
// Z402_PRICE_UNITS (default 10), Z402_PORT (default 8405). Anchoring: Z402_WALLET (the gateway's zingo
// data dir) and Z402_ANCHOR_UA; POST /api/anchor also needs Z402_ADMIN_TOKEN as a bearer token.
import { Gateway, serveGateway } from './gateway.js';
import { SetupRequiredError } from './scan.js';
import { quicksend, zingoConfig } from './zingo.js';

const need = (k: string) => process.env[k] || (() => { throw new SetupRequiredError(k); })();
try {
  const price = BigInt(process.env.Z402_PRICE_UNITS ?? '10');
  const wallet = process.env.Z402_WALLET;
  const anchorUa = process.env.Z402_ANCHOR_UA;
  const g = new Gateway({
    statePath: need('Z402_STATE'),
    depositUa: need('Z402_DEPOSIT_UA'),
    depositUivk: need('Z402_DEPOSIT_UIVK'),
    unitZat: Number(process.env.Z402_UNIT_ZAT ?? 1000),
    prices: { '/api/quote': price, '/api/report': price * 5n },
    content: (path) => ({ path, servedAt: new Date().toISOString(), note: 'paid with a zero-knowledge proof of a prepaid shielded note' }),
    anchorUa,
    adminToken: process.env.Z402_ADMIN_TOKEN || undefined,
    sendAnchor: wallet && anchorUa ? async (memo) => (await quicksend(zingoConfig(), wallet, [{ address: anchorUa, amount: 10_000n, memo }]))[0] : undefined,
  });
  const port = Number(process.env.Z402_PORT ?? 8405);
  serveGateway(g).listen(port, '127.0.0.1', () => console.log(`zec-null-402 gateway on http://127.0.0.1:${port}`));
} catch (e) {
  console.error((e as Error).message);
  process.exit(e instanceof SetupRequiredError ? 2 : 1);
}
