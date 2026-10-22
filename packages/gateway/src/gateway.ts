// zec-null-402 gateway. Zcash has no contracts, so this gateway is the pool: it credits notes only
// for a real shielded deposit it sees with its own incoming viewing key (memo z402:<commitment>),
// keeps the Poseidon tree of credited notes, verifies each per-call Groth16 proof off-chain, and
// burns nullifiers. It anchors (leaf count, root, nullifier-set hash) in a shielded memo to a
// public-viewing-key address; clients prove only against an anchored root they have read on-chain
// themselves, so the gateway cannot hand each client its own root.
// State (leaves, deposits, nullifiers, outstanding challenges, anchors) lives in SQLite, so a restart
// keeps it and two gateway processes on one database cannot both accept one nullifier or one challenge.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { commitmentOf, contextHash, fieldOfSha256, leafFromItem, R, Tree, verifyOffChain, type PaymentPublic } from '@z402/circuits';
import { chainTip, readAnchor, scan, SetupRequiredError } from './scan.js';

export interface Anchor {
  txid: string;
  leaves: number;
  root: string;
  nullifiers: number;
  nullifierHash: string;
  at: string;
  /** block height once mined (null while the gateway has not seen it mined) */
  height: number | null;
}

/** A read-only snapshot of the gateway's database. */
export interface GatewayState {
  leaves: string[];
  roots: string[];
  deposits: Record<string, { commitment: string; first: number; count: number; zat: number; height: number | null }>;
  nullifiers: Record<string, { at: string; resource: string }>;
  anchors: Anchor[];
}

export interface GatewayOptions {
  /** SQLite database file (created if missing) */
  statePath: string;
  /** a JSON state file from before the SQLite store; imported once into an empty database */
  legacyJsonState?: string;
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
  /** the anchor address's (published) incoming viewing key: confirms the gateway's anchors and adopts existing ones */
  anchorUivk?: string;
  /**
   * anchor after every credited deposit, so new notes become spendable once that anchor is mined; with
   * startAnchoring(), also whenever an anchor is due (anchorDue): clients pay only against a recent one
   */
  autoAnchor?: boolean;
  /** re-anchor once the newest anchor is this many blocks old (default 1,440: half the client's 2,880-block window) */
  anchorEveryBlocks?: number;
  /** how often startAnchoring() checks whether an anchor is due (default 10 minutes) */
  anchorCheckMs?: number;
  /** a failed anchor send is retried after this long (default 60 s), up to anchorRetries times (default 10) */
  anchorRetryMs?: number;
  anchorRetries?: number;
  /** an anchor not seen mined after this long is sent again (default 30 minutes) */
  anchorPendingMs?: number;
  /** the chain tip (default: lightwalletd through the scan binary) */
  chainTip?: () => Promise<number>;
  /** bearer token for POST /api/anchor, which spends from the gateway wallet */
  adminToken?: string;
  /** outstanding unpaid challenges kept (default 10,000); the oldest is dropped first */
  maxChallenges?: number;
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
  /** the root to prove against: the latest mined anchor's root (the current root when there is no anchor) */
  root: string;
  /** the anchor the client must check on-chain before proving; null: none, and a Kippu client refuses */
  anchor: { txid: string; leaves: number; root: string; height: number } | null;
  expiresAt: number;
}

const ROOTS_KEPT = 64;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_BODY = 64 * 1024;
const ANCHOR_REFRESH_MS = 20_000;
const SIGNALS = ['nullifier', 'merkle_root', 'pay_to', 'required_amount', 'context_hash'] as const;
/**
 * snarkjs parses "0123" and "0x7b" as the same field element as "123", so a proof verifies with any of
 * them. The gateway keys nullifiers by string; it accepts only the one canonical decimal form (no sign,
 * no leading zero, below the field modulus) so one note has exactly one nullifier key.
 */
export const isCanonicalField = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,76})$/.test(v) && BigInt(v) < R;
export const nullifierSetHash = (ns: string[]) => createHash('sha256').update(`zec-null-402:v1:nullifiers:${[...ns].sort().join(',')}`).digest('hex');
export const anchorMemo = (leaves: number, root: string, nullifiers: number, nh: string) => `z402:anchor:${leaves}:${root}:${nullifiers}:${nh}`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leaves (idx INTEGER PRIMARY KEY, leaf TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roots (seq INTEGER PRIMARY KEY AUTOINCREMENT, root TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deposits (txid TEXT PRIMARY KEY, commitment TEXT NOT NULL, first INTEGER NOT NULL, count INTEGER NOT NULL, zat INTEGER NOT NULL, height INTEGER);
CREATE TABLE IF NOT EXISTS nullifiers (nullifier TEXT PRIMARY KEY, at TEXT NOT NULL, resource TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS challenges (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS anchors (seq INTEGER PRIMARY KEY AUTOINCREMENT, txid TEXT NOT NULL UNIQUE, leaves INTEGER NOT NULL, root TEXT NOT NULL, nullifiers INTEGER NOT NULL, nullifier_hash TEXT NOT NULL, at TEXT NOT NULL, height INTEGER);
`;

type Row = Record<string, string | number | null>;
const anchorOf = (r: Row): Anchor => ({ txid: String(r.txid), leaves: Number(r.leaves), root: String(r.root), nullifiers: Number(r.nullifiers), nullifierHash: String(r.nullifier_hash), at: String(r.at), height: r.height === null ? null : Number(r.height) });

export class Gateway {
  readonly payTo: bigint;
  readonly db: DatabaseSync;
  private tree: Tree | null = null;
  /** nullifiers and deposits being checked right now in this process: verification and scanning are async */
  private inflight = new Set<string>();
  private claiming = new Set<string>();
  private anchorRefresh: Promise<number> | null = null;
  private anchorRefreshedAt = 0;
  /** the anchor being sent, and at most one queued after it (which covers whatever changed meanwhile) */
  private anchorInFlight: Promise<Anchor> | null = null;
  private anchorQueued: Promise<Anchor> | null = null;
  private retrying = false;
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly o: GatewayOptions) {
    if (!Number.isSafeInteger(o.unitZat) || o.unitZat < 1) throw new RangeError(`gateway: unitZat must be a whole number of zatoshi, at least 1, got ${o.unitZat}`);
    for (const [path, p] of Object.entries(o.prices)) if (typeof p !== 'bigint' || p < 1n) throw new RangeError(`gateway: the price of ${path} must be at least 1 unit, got ${p}`);
    if (existsSync(o.statePath) && readFileSync(o.statePath).subarray(0, 1).toString() === '{')
      throw new SetupRequiredError('Z402_STATE', `${o.statePath} is a JSON state file; the gateway now keeps SQLite: point statePath at a new .db file and pass the JSON as legacyJsonState (Z402_LEGACY_STATE)`);
    this.db = new DatabaseSync(o.statePath);
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.payTo = fieldOfSha256(`zec-null-402:payTo:${o.depositUa}`);
    if (o.legacyJsonState && existsSync(o.legacyJsonState)) this.importLegacy(o.legacyJsonState);
  }

  /** Imports a pre-SQLite JSON state once, into an empty database. */
  private importLegacy(path: string) {
    if (this.count('leaves') > 0 || this.count('nullifiers') > 0) return;
    const j = JSON.parse(readFileSync(path, 'utf8')) as Omit<GatewayState, 'anchors'> & { anchors: Omit<Anchor, 'height'>[] };
    this.tx(() => {
      j.leaves.forEach((l, i) => this.db.prepare('INSERT INTO leaves (idx, leaf) VALUES (?, ?)').run(i, l));
      for (const r of j.roots) this.db.prepare('INSERT INTO roots (root) VALUES (?)').run(r);
      for (const [txid, x] of Object.entries(j.deposits)) this.db.prepare('INSERT INTO deposits VALUES (?, ?, ?, ?, ?, ?)').run(txid, x.commitment, x.first, x.count, x.zat, x.height);
      for (const [n, x] of Object.entries(j.nullifiers)) this.db.prepare('INSERT INTO nullifiers VALUES (?, ?, ?)').run(n, x.at, x.resource);
      for (const a of j.anchors) this.db.prepare('INSERT INTO anchors (txid, leaves, root, nullifiers, nullifier_hash, at, height) VALUES (?, ?, ?, ?, ?, ?, NULL)').run(a.txid, a.leaves, a.root, a.nullifiers, a.nullifierHash, a.at);
    });
  }

  close() {
    this.stopAnchoring();
    this.db.close();
  }

  private count(table: 'leaves' | 'nullifiers' | 'challenges'): number {
    return Number((this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as Row).n);
  }

  /** Runs `fn` in one write transaction (BEGIN IMMEDIATE: other processes wait on busy_timeout). */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  get state(): GatewayState {
    const all = (sql: string) => this.db.prepare(sql).all() as Row[];
    return {
      leaves: all('SELECT leaf FROM leaves ORDER BY idx').map((r) => String(r.leaf)),
      roots: all('SELECT root FROM roots ORDER BY seq').map((r) => String(r.root)),
      deposits: Object.fromEntries(all('SELECT * FROM deposits').map((r) => [String(r.txid), { commitment: String(r.commitment), first: Number(r.first), count: Number(r.count), zat: Number(r.zat), height: r.height === null ? null : Number(r.height) }])),
      nullifiers: Object.fromEntries(all('SELECT * FROM nullifiers').map((r) => [String(r.nullifier), { at: String(r.at), resource: String(r.resource) }])),
      anchors: all('SELECT * FROM anchors ORDER BY seq').map(anchorOf),
    };
  }

  private leaves(n?: number): bigint[] {
    const rows = (n === undefined ? this.db.prepare('SELECT leaf FROM leaves ORDER BY idx').all() : this.db.prepare('SELECT leaf FROM leaves WHERE idx < ? ORDER BY idx').all(n)) as Row[];
    return rows.map((r) => BigInt(String(r.leaf)));
  }

  /** The current root (cached; rebuilt when another process appended leaves). */
  async root(): Promise<string> {
    const n = this.count('leaves');
    if (!this.tree || this.tree.levels[0].length !== n) this.tree = await Tree.build(this.leaves());
    return this.tree.root.toString();
  }

  /** The root of the first `n` leaves: the tree is append-only, so this is the root the gateway had at `n` leaves. */
  async rootAt(n: number): Promise<string> {
    return (await Tree.build(this.leaves(n))).root.toString();
  }

  /** Credits the notes of a deposit, once, if the chain shows it paid enough with their commitment. */
  async claim(txid: string, items: { secretHash: string; value: string }[]): Promise<{ first: number; count: number; root: string }> {
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new GatewayError(400, 'txid must be 64 hex');
    if (!Array.isArray(items) || items.length === 0 || items.length > 64) throw new GatewayError(400, 'items: 1 to 64 notes');
    for (const i of items) if (!/^\d{1,78}$/.test(i?.secretHash ?? '') || !/^[1-9]\d{0,9}$/.test(i?.value ?? '')) throw new GatewayError(400, 'each item needs a decimal secretHash and a positive whole value');
    if (this.db.prepare('SELECT 1 FROM deposits WHERE txid = ?').get(txid)) throw new GatewayError(409, `deposit ${txid} was already claimed`);
    if (this.claiming.has(txid)) throw new GatewayError(409, `deposit ${txid} is being claimed`);
    this.claiming.add(txid);
    try {
      const r = await this.credit(txid, items);
      if (this.o.autoAnchor && this.o.sendAnchor) this.anchorWithRetry(`deposit ${txid.slice(0, 12)}… credited`);
      return r;
    } finally {
      this.claiming.delete(txid);
    }
  }

  private async credit(txid: string, items: { secretHash: string; value: string }[]) {
    const commitment = commitmentOf(items);
    const units = items.reduce((t, i) => t + BigInt(i.value), 0n);
    const r = await scan(this.o.depositUivk, txid, units * BigInt(this.o.unitZat), `z402:${commitment}`, this.o.minConf ?? 1);
    if (!r.ok) throw new GatewayError(r.reasons.every((x) => x === 'NOT_CONFIRMED') ? 425 : 402, `deposit not credited: ${r.reasons.join(', ')}`);
    const leaves = await Promise.all(items.map(async (i) => (await leafFromItem(i)).toString()));
    // One transaction: another process claiming the same deposit gets the primary-key conflict.
    const first = this.tx(() => {
      if (this.db.prepare('SELECT 1 FROM deposits WHERE txid = ?').get(txid)) throw new GatewayError(409, `deposit ${txid} was already claimed`);
      const first = this.count('leaves');
      leaves.forEach((l, k) => this.db.prepare('INSERT INTO leaves (idx, leaf) VALUES (?, ?)').run(first + k, l));
      this.db.prepare('INSERT INTO deposits VALUES (?, ?, ?, ?, ?, ?)').run(txid, commitment, first, items.length, r.paidZat, r.height);
      return first;
    });
    const root = await this.rootAt(first + items.length);
    this.tx(() => {
      this.db.prepare('INSERT INTO roots (root) VALUES (?)').run(root);
      this.db.prepare('DELETE FROM roots WHERE seq <= (SELECT max(seq) FROM roots) - ?').run(ROOTS_KEPT);
    });
    return { first, count: items.length, root };
  }

  /** The newest anchor the gateway has seen mined: the one clients are told to check and prove against. */
  latestAnchor(): Anchor | null {
    const r = this.db.prepare('SELECT * FROM anchors WHERE height IS NOT NULL ORDER BY height DESC, seq DESC LIMIT 1').get() as Row | undefined;
    return r ? anchorOf(r) : null;
  }

  async challenge(method: string, path: string, price: bigint): Promise<Challenge> {
    this.refreshAnchorsSoon();
    const a = this.latestAnchor();
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
      root: a?.root ?? (await this.root()),
      anchor: a ? { txid: a.txid, leaves: a.leaves, root: a.root, height: a.height! } : null,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    };
    // Every unpaid GET makes a challenge: drop expired ones, then the oldest beyond the cap.
    const max = this.o.maxChallenges ?? 10_000;
    this.tx(() => {
      this.db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(Date.now());
      const over = this.count('challenges') - max + 1;
      if (over > 0) this.db.prepare('DELETE FROM challenges WHERE nonce IN (SELECT nonce FROM challenges ORDER BY rowid LIMIT ?)').run(over);
      this.db.prepare('INSERT INTO challenges VALUES (?, ?, ?)').run(nonce, c.expiresAt, JSON.stringify(c));
    });
    return c;
  }

  private knownRoot(root: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM roots WHERE root = ? UNION SELECT 1 FROM anchors WHERE root = ?').get(root, root);
  }

  /** Checks a payment for an issued challenge; on success burns the nullifier. Returns null or the refusal. */
  async redeem(path: string, payment: { nonce: string; proof: object; signals: PaymentPublic }): Promise<string | null> {
    const nonce = payment?.nonce;
    const row = typeof nonce === 'string' ? (this.db.prepare('SELECT body FROM challenges WHERE nonce = ?').get(nonce) as Row | undefined) : undefined;
    const c = row ? (JSON.parse(String(row.body)) as Challenge) : undefined;
    if (!c || c.resource !== path || c.expiresAt < Date.now()) return 'UNKNOWN_CHALLENGE';
    const s = payment.signals;
    if (!s || typeof s !== 'object' || !SIGNALS.every((k) => isCanonicalField(s[k]))) return 'MALFORMED_SIGNALS';
    if (s.pay_to !== c.payTo || s.required_amount !== c.requiredAmount || s.context_hash !== c.contextHash) return 'NOT_BOUND_TO_CHALLENGE';
    if (!this.knownRoot(s.merkle_root)) return 'UNKNOWN_ROOT';
    if (this.db.prepare('SELECT 1 FROM nullifiers WHERE nullifier = ?').get(s.nullifier) || this.inflight.has(s.nullifier)) return 'NULLIFIER_SPENT';
    // Reserve before the async proof check: a challenge is answered once (also across processes: the
    // DELETE is atomic), a nullifier checked once at a time in this process.
    if (this.db.prepare('DELETE FROM challenges WHERE nonce = ? RETURNING nonce').all(c.nonce).length === 0) return 'UNKNOWN_CHALLENGE';
    this.inflight.add(s.nullifier);
    try {
      const ok = await verifyOffChain([s.nullifier, s.merkle_root, s.pay_to, s.required_amount, s.context_hash], payment.proof).catch(() => false);
      if (!ok) {
        // a bad proof does not use up the challenge
        this.db.prepare('INSERT OR IGNORE INTO challenges VALUES (?, ?, ?)').run(c.nonce, c.expiresAt, JSON.stringify(c));
        return 'BAD_PROOF';
      }
      // The primary key decides between two processes that verified the same note at once.
      const burned = this.db.prepare('INSERT INTO nullifiers VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(s.nullifier, new Date().toISOString(), path);
      return Number(burned.changes) === 1 ? null : 'NULLIFIER_SPENT';
    } finally {
      this.inflight.delete(s.nullifier);
    }
  }

  /**
   * Anchors the current state. One send at a time: a call while one is in flight waits for it and then
   * shares a single follow-up anchor, which is skipped if nothing changed meanwhile.
   */
  anchor(): Promise<Anchor> {
    if (!this.o.sendAnchor) return Promise.reject(new GatewayError(503, 'Setup required: anchoring needs the gateway wallet'));
    if (this.anchorQueued) return this.anchorQueued;
    if (!this.anchorInFlight) return (this.anchorInFlight = this.sendOneAnchor(false).finally(() => (this.anchorInFlight = null)));
    return (this.anchorQueued = this.anchorInFlight
      .catch(() => undefined)
      .then(() => {
        this.anchorQueued = null;
        return (this.anchorInFlight = this.sendOneAnchor(true).finally(() => (this.anchorInFlight = null)));
      }));
  }

  /** The newest anchor recorded: one still waiting to be mined first, else the highest mined one. */
  newestAnchor(): Anchor | null {
    const r = this.db.prepare('SELECT * FROM anchors ORDER BY height IS NULL DESC, height DESC, seq DESC LIMIT 1').get() as Row | undefined;
    return r ? anchorOf(r) : null;
  }

  private async sendOneAnchor(skipIfUnchanged: boolean): Promise<Anchor> {
    const ns = (this.db.prepare('SELECT nullifier FROM nullifiers').all() as Row[]).map((r) => String(r.nullifier));
    const leaves = this.count('leaves');
    const nh = nullifierSetHash(ns);
    const last = this.newestAnchor();
    if (skipIfUnchanged && last && last.leaves === leaves && last.nullifierHash === nh) return last;
    const root = await this.rootAt(leaves);
    const txid = await this.o.sendAnchor!(anchorMemo(leaves, root, ns.length, nh));
    const a: Anchor = { txid, leaves, root, nullifiers: ns.length, nullifierHash: nh, at: new Date().toISOString(), height: null };
    // The tx is out: record it, and if that fails say which tx it was, so it can be adopted once mined.
    const insert = () => this.db.prepare('INSERT INTO anchors (txid, leaves, root, nullifiers, nullifier_hash, at, height) VALUES (?, ?, ?, ?, ?, ?, NULL)').run(a.txid, a.leaves, a.root, a.nullifiers, a.nullifierHash, a.at);
    try {
      insert();
    } catch {
      try {
        insert();
      } catch (e) {
        const msg = `anchor tx ${txid} was sent but not recorded (${(e as Error).message}); record it with adoptAnchor('${txid}') once it is mined`;
        console.error(msg);
        throw new GatewayError(500, msg);
      }
    }
    return a;
  }

  /** Anchors now; a failed send is retried every anchorRetryMs, up to anchorRetries times. One retry chain at a time. */
  anchorWithRetry(reason: string): void {
    if (this.retrying) return;
    this.retrying = true;
    const every = this.o.anchorRetryMs ?? 60_000;
    const max = this.o.anchorRetries ?? 10;
    const attempt = (n: number) => {
      this.anchor().then(
        (a) => {
          this.retrying = false;
          console.log(`anchored (${reason}): ${a.txid} with ${a.leaves} leaves, ${a.nullifiers} spent`);
        },
        (e: Error) => {
          if (n >= max) {
            this.retrying = false;
            console.error(`anchor failed (${reason}) ${n + 1} times, giving up until the next check: ${e.message}`);
            return;
          }
          console.error(`anchor failed (${reason}): ${e.message}; retry ${n + 1} of ${max} in ${Math.round(every / 1000)} s`);
          setTimeout(() => attempt(n + 1), every).unref();
        },
      );
    };
    attempt(0);
  }

  /**
   * Why an anchor is due, or null: notes credited since the newest anchor, a changed spent count, an
   * anchor that was never seen mined, or a mined one at least anchorEveryBlocks old (clients refuse old ones).
   */
  async anchorDue(): Promise<string | null> {
    const leaves = this.count('leaves');
    if (leaves === 0) return null;
    const last = this.newestAnchor();
    if (!last) return 'no anchor yet';
    if (last.leaves < leaves) return `${leaves - last.leaves} credited notes are newer than the newest anchor`;
    const spent = this.count('nullifiers');
    if (last.nullifiers !== spent) return `spent count changed since the newest anchor (${last.nullifiers} → ${spent})`;
    if (last.height === null) {
      const wait = this.o.anchorPendingMs ?? 30 * 60_000;
      return Date.now() - Date.parse(last.at) > wait ? `anchor ${last.txid.slice(0, 12)}… was not seen mined within ${Math.round(wait / 60_000)} min` : null;
    }
    const age = (await (this.o.chainTip ?? chainTip)()) - last.height;
    const every = this.o.anchorEveryBlocks ?? 1440;
    return age >= every ? `the newest anchor is ${age} blocks old (re-anchoring every ${every})` : null;
  }

  /** With autoAnchor and a wallet: checks every anchorCheckMs (and now) whether an anchor is due, and sends it. */
  startAnchoring(): void {
    if (!this.o.autoAnchor || !this.o.sendAnchor || this.timer) return;
    const tick = async () => {
      if (this.ticking || this.retrying) return;
      this.ticking = true;
      try {
        if (this.o.anchorUivk) await this.confirmAnchors().catch((e: Error) => console.error(`anchor check failed: ${e.message}`));
        const reason = await this.anchorDue();
        if (reason) this.anchorWithRetry(reason);
      } catch (e) {
        console.error(`anchor check failed: ${(e as Error).message}`);
      } finally {
        this.ticking = false;
      }
    };
    this.timer = setInterval(tick, this.o.anchorCheckMs ?? 10 * 60_000);
    this.timer.unref();
    void tick();
  }

  stopAnchoring(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private needAnchorKey(): string {
    if (!this.o.anchorUivk) throw new SetupRequiredError('Z402_ANCHOR_UIVK', "the anchor address's viewing key, to read anchors on-chain");
    return this.o.anchorUivk;
  }

  /** Reads this gateway's unmined anchors on-chain and records the height of those now mined. */
  async confirmAnchors(): Promise<number> {
    const key = this.needAnchorKey();
    let n = 0;
    for (const a of (this.db.prepare('SELECT * FROM anchors WHERE height IS NULL').all() as Row[]).map(anchorOf)) {
      const r = await readAnchor(key, a.txid);
      if (r.height !== null && r.anchors.some((m) => m.root === a.root && m.leaves === a.leaves)) {
        this.db.prepare('UPDATE anchors SET height = ? WHERE txid = ?').run(r.height, a.txid);
        n++;
      }
    }
    return n;
  }

  private refreshAnchorsSoon() {
    if (!this.o.anchorUivk || this.anchorRefresh || Date.now() - this.anchorRefreshedAt < ANCHOR_REFRESH_MS) return;
    if (!this.db.prepare('SELECT 1 FROM anchors WHERE height IS NULL').get()) return;
    this.anchorRefreshedAt = Date.now();
    this.anchorRefresh = this.confirmAnchors()
      .catch((e: Error) => (console.error(`anchor check failed: ${e.message}`), 0))
      .finally(() => (this.anchorRefresh = null));
  }

  /**
   * Records an anchor already on-chain (for example after the database was rebuilt from the published
   * deposits). Read with the anchor viewing key; refused unless its leaf count and root match this
   * gateway's leaves.
   */
  async adoptAnchor(txid: string): Promise<Anchor> {
    const r = await readAnchor(this.needAnchorKey(), txid);
    if (!r.found || r.height === null) throw new GatewayError(409, `anchor ${txid} is not mined (or the anchor viewing key cannot see it)`);
    const m = r.anchors[0];
    if (!m) throw new GatewayError(409, `tx ${txid} has no z402 anchor memo readable by the anchor viewing key`);
    if (m.leaves > this.count('leaves') || (await this.rootAt(m.leaves)) !== m.root) throw new GatewayError(409, `anchor ${txid} (root of ${m.leaves} leaves) does not match this gateway's leaves`);
    const a: Anchor = { txid, ...m, at: new Date().toISOString(), height: r.height };
    this.db.prepare('INSERT INTO anchors (txid, leaves, root, nullifiers, nullifier_hash, at, height) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (txid) DO UPDATE SET height = excluded.height').run(a.txid, a.leaves, a.root, a.nullifiers, a.nullifierHash, a.at, a.height);
    return a;
  }
}

export class GatewayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const got = Buffer.from(header ?? '');
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function serveGateway(g: Gateway): Server {
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...headers }).end(JSON.stringify(body));
  const body = async (req: IncomingMessage) => {
    let s = '';
    for await (const c of req) {
      s += c;
      if (s.length > MAX_BODY) throw new GatewayError(413, `request body over ${MAX_BODY} bytes`);
    }
    return JSON.parse(s || '{}');
  };
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local');
    const st = g.state;
    if (url.pathname === '/api/info')
      return json(res, 200, {
        // not the deposit viewing key: with it anyone could read every deposit's amount and memo
        depositUa: g.o.depositUa,
        unitZat: g.o.unitZat,
        payTo: g.payTo.toString(),
        prices: Object.fromEntries(Object.entries(g.o.prices).map(([k, v]) => [k, v.toString()])),
        leaves: st.leaves.length,
        root: await g.root(),
        deposits: Object.keys(st.deposits).length,
        spent: Object.keys(st.nullifiers).length,
        anchors: st.anchors,
        latestAnchor: g.latestAnchor(),
        anchorUa: g.o.anchorUa ?? null,
      });
    if (url.pathname === '/api/leaves') return json(res, 200, { leaves: st.leaves, root: await g.root() });
    if (url.pathname === '/api/deposits' && req.method === 'POST') {
      const b = await body(req);
      return json(res, 200, await g.claim(b.txid, b.items));
    }
    if (url.pathname === '/api/anchor' && req.method === 'POST') {
      // Anchoring spends from the gateway wallet; any web page could POST here, so it needs the token.
      if (!g.o.adminToken) return json(res, 503, { error: 'Setup required: Z402_ADMIN_TOKEN (anchoring over HTTP is off without it)' });
      if (!bearerMatches(req.headers.authorization, g.o.adminToken)) return json(res, 401, { error: 'anchoring needs Authorization: Bearer <Z402_ADMIN_TOKEN>' });
      return json(res, 200, await g.anchor());
    }
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
