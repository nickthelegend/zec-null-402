// zec-null-402 gateway. Zcash has no contracts, so this gateway is the pool: it credits notes only
// for a real shielded deposit it sees with its own incoming viewing key (memo z402:<commitment>),
// keeps the Poseidon tree of credited notes, verifies each per-call Groth16 proof off-chain, and
// burns nullifiers. It periodically anchors (leaf count, root, nullifier-set hash) in a shielded memo
// to a public-viewing-key address so its history can be audited.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { commitmentOf, contextHash, fieldOfSha256, leafFromItem, R, Tree, verifyOffChain, type PaymentPublic } from '@z402/circuits';
import { scan } from './scan.js';

export interface GatewayState {
  leaves: string[];
  roots: string[];
  deposits: Record<string, { commitment: string; first: number; count: number; zat: number; height: number | null }>;
  nullifiers: Record<string, { at: string; resource: string }>;
  anchors: { txid: string; leaves: number; root: string; nullifiers: number; nullifierHash: string; at: string }[];
}

export interface GatewayOptions {
  statePath: string;
  /** the gateway's deposit address and its incoming viewing key */
  depositUa: string;
  depositUivk: string;
  /** zatoshi per note unit */
  unitZat: number;
  prices: Record<string, bigint>;
  content: (path: string) => unknown;
  minConf?: number;
  /** sends the anchor memo; returns the txid (the gateway wallet pays) */
  sendAnchor?: (memo: string) => Promise<string>;
  anchorUa?: string;
}

export interface Challenge {
  x402Version: 1;
  scheme: 'zec-null-402';
  network: 'zcash-testnet';
  payTo: string;
  requiredAmount: string;
  resource: string;
  nonce: string;
  contextHash: string;
  root: string;
  expiresAt: number;
}

const ROOTS_KEPT = 64;
const SIGNALS = ['nullifier', 'merkle_root', 'pay_to', 'required_amount', 'context_hash'] as const;
/**
 * snarkjs parses "0123" and "0x7b" as the same field element as "123", so a proof verifies with any of
 * them. The gateway keys nullifiers by string; it accepts only the one canonical decimal form (no sign,
 * no leading zero, below the field modulus) so one note has exactly one nullifier key.
 */
export const isCanonicalField = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,76})$/.test(v) && BigInt(v) < R;
export const nullifierSetHash = (ns: string[]) => createHash('sha256').update(`zec-null-402:v1:nullifiers:${[...ns].sort().join(',')}`).digest('hex');
export const anchorMemo = (leaves: number, root: string, nullifiers: number, nh: string) => `z402:anchor:${leaves}:${root}:${nullifiers}:${nh}`;

export class Gateway {
  readonly state: GatewayState;
  readonly payTo: bigint;
  private tree: Tree | null = null;
  private issued = new Map<string, Challenge>();

  constructor(readonly o: GatewayOptions) {
    this.state = existsSync(o.statePath) ? JSON.parse(readFileSync(o.statePath, 'utf8')) : { leaves: [], roots: [], deposits: {}, nullifiers: {}, anchors: [] };
    this.payTo = fieldOfSha256(`zec-null-402:payTo:${o.depositUa}`);
  }

  private save() {
    writeFileSync(`${this.o.statePath}.tmp`, JSON.stringify(this.state, null, 2));
    renameSync(`${this.o.statePath}.tmp`, this.o.statePath);
  }

  async root(): Promise<string> {
    this.tree ??= await Tree.build(this.state.leaves.map(BigInt));
    return this.tree.root.toString();
  }

  /** Credits the notes of a deposit, once, if the chain shows it paid enough with their commitment. */
  async claim(txid: string, items: { secretHash: string; value: string }[]): Promise<{ first: number; count: number; root: string }> {
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new GatewayError(400, 'txid must be 64 hex');
    if (!Array.isArray(items) || items.length === 0 || items.length > 64) throw new GatewayError(400, 'items: 1 to 64 notes');
    for (const i of items) if (!/^\d{1,78}$/.test(i?.secretHash ?? '') || !/^[1-9]\d{0,9}$/.test(i?.value ?? '')) throw new GatewayError(400, 'each item needs a decimal secretHash and a positive whole value');
    if (this.state.deposits[txid]) throw new GatewayError(409, `deposit ${txid} was already claimed`);
    const commitment = commitmentOf(items);
    const units = items.reduce((t, i) => t + BigInt(i.value), 0n);
    const r = await scan(this.o.depositUivk, txid, units * BigInt(this.o.unitZat), `z402:${commitment}`, this.o.minConf ?? 1);
    if (!r.ok) throw new GatewayError(r.reasons.every((x) => x === 'NOT_CONFIRMED') ? 425 : 402, `deposit not credited: ${r.reasons.join(', ')}`);
    const first = this.state.leaves.length;
    for (const i of items) this.state.leaves.push((await leafFromItem(i)).toString());
    this.tree = null;
    const root = await this.root();
    this.state.roots = [...this.state.roots, root].slice(-ROOTS_KEPT);
    this.state.deposits[txid] = { commitment, first, count: items.length, zat: r.paidZat, height: r.height };
    this.save();
    return { first, count: items.length, root };
  }

  async challenge(method: string, path: string, price: bigint): Promise<Challenge> {
    const nonce = randomBytes(16).toString('hex');
    const c: Challenge = {
      x402Version: 1,
      scheme: 'zec-null-402',
      network: 'zcash-testnet',
      payTo: this.payTo.toString(),
      requiredAmount: price.toString(),
      resource: path,
      nonce,
      contextHash: contextHash(method, path, price, this.payTo, nonce).toString(),
      root: await this.root(),
      expiresAt: Date.now() + 5 * 60_000,
    };
    this.issued.set(nonce, c);
    return c;
  }

  /** Checks a payment for an issued challenge; on success burns the nullifier. Returns null or the refusal. */
  async redeem(path: string, payment: { nonce: string; proof: object; signals: PaymentPublic }): Promise<string | null> {
    const c = this.issued.get(payment?.nonce);
    if (!c || c.resource !== path || c.expiresAt < Date.now()) return 'UNKNOWN_CHALLENGE';
    const s = payment.signals;
    if (!s || typeof s !== 'object' || !SIGNALS.every((k) => isCanonicalField(s[k]))) return 'MALFORMED_SIGNALS';
    if (s.pay_to !== c.payTo || s.required_amount !== c.requiredAmount || s.context_hash !== c.contextHash) return 'NOT_BOUND_TO_CHALLENGE';
    if (!this.state.roots.includes(s.merkle_root)) return 'UNKNOWN_ROOT';
    if (this.state.nullifiers[s.nullifier]) return 'NULLIFIER_SPENT';
    const ok = await verifyOffChain([s.nullifier, s.merkle_root, s.pay_to, s.required_amount, s.context_hash], payment.proof).catch(() => false);
    if (!ok) return 'BAD_PROOF';
    this.issued.delete(c.nonce);
    this.state.nullifiers[s.nullifier] = { at: new Date().toISOString(), resource: path };
    this.save();
    return null;
  }

  async anchor(): Promise<GatewayState['anchors'][number]> {
    if (!this.o.sendAnchor) throw new GatewayError(503, 'Setup required: anchoring needs the gateway wallet');
    const ns = Object.keys(this.state.nullifiers);
    const root = await this.root();
    const nh = nullifierSetHash(ns);
    const txid = await this.o.sendAnchor(anchorMemo(this.state.leaves.length, root, ns.length, nh));
    const a = { txid, leaves: this.state.leaves.length, root, nullifiers: ns.length, nullifierHash: nh, at: new Date().toISOString() };
    this.state.anchors.push(a);
    this.save();
    return a;
  }
}

export class GatewayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function serveGateway(g: Gateway): Server {
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...headers }).end(JSON.stringify(body));
  const body = async (req: IncomingMessage) => {
    let s = '';
    for await (const c of req) s += c;
    return JSON.parse(s || '{}');
  };
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === '/api/info')
      return json(res, 200, {
        depositUa: g.o.depositUa,
        depositUivk: g.o.depositUivk,
        unitZat: g.o.unitZat,
        payTo: g.payTo.toString(),
        prices: Object.fromEntries(Object.entries(g.o.prices).map(([k, v]) => [k, v.toString()])),
        leaves: g.state.leaves.length,
        root: await g.root(),
        deposits: Object.keys(g.state.deposits).length,
        spent: Object.keys(g.state.nullifiers).length,
        anchors: g.state.anchors,
        anchorUa: g.o.anchorUa ?? null,
      });
    if (url.pathname === '/api/leaves') return json(res, 200, { leaves: g.state.leaves, root: await g.root() });
    if (url.pathname === '/api/deposits' && req.method === 'POST') {
      const b = await body(req);
      return json(res, 200, await g.claim(b.txid, b.items));
    }
    if (url.pathname === '/api/anchor' && req.method === 'POST') return json(res, 200, await g.anchor());
    const price = g.o.prices[url.pathname];
    if (price === undefined) return json(res, 404, { error: 'not found' });
    const header = req.headers['x-payment'];
    if (typeof header !== 'string') return json(res, 402, { error: 'payment required', accepts: [await g.challenge(req.method ?? 'GET', url.pathname, price)] });
    let p;
    try {
      p = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    } catch {
      return json(res, 400, { error: 'X-PAYMENT is not base64 JSON' });
    }
    const refused = await g.redeem(url.pathname, p);
    if (refused) return json(res, 402, { error: `payment refused: ${refused}`, reason: refused, accepts: [await g.challenge(req.method ?? 'GET', url.pathname, price)] });
    const receipt = { nullifier: p.signals.nullifier, amount: p.signals.required_amount };
    return json(res, 200, { paid: receipt, data: g.o.content(url.pathname) }, { 'x-payment-response': Buffer.from(JSON.stringify(receipt)).toString('base64') });
  }
  return createServer((req, res) => {
    handle(req, res).catch((e: Error) => json(res, e instanceof GatewayError ? e.status : e instanceof SyntaxError ? 400 : 502, { error: e.message }));
  });
}
