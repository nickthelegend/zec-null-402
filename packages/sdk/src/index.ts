// zec-null-402 client: plan a deposit of N notes, claim it after the shielded deposit is mined, then
// pay per call with a zero-knowledge proof of one unspent note. Note secrets live in a 0600 file.
// The client proves only against a root it has read itself in an on-chain anchor (lightwalletd + the
// anchor address's published viewing key). It scans the anchor address over its whole window: every
// anchor the gateway signed there must sit on one leaf history (else ANCHOR_COMPETING), and it proves
// against the newest, whichever the gateway named. So handing a client its own root means a separate
// signed root on-chain that every client sees, and naming an older anchor learns nothing.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { contextHash, depositCommitment, leafOf, newNote, nullifierOf, provePayment, Tree, type Note } from '@z402/circuits';
import { fileLock, intEnv, readAnchor, scanAnchors, SetupRequiredError, verifyAnchorSignature, wholeNumber, type AnchorMemo, type ScannedAnchor } from '@z402/gateway';

export interface StoredNote {
  noteSecret: string;
  nullifierSecret: string;
  value: string;
  /** leaf index once the deposit is claimed */
  index: number | null;
  deposit: string;
  nullifier: string;
  spent: boolean;
  /** set (ms since epoch) while a pay() is proving with this note, so a concurrent pay() picks another */
  pending?: number;
}

interface NotesFile {
  type: 'zec-null-402-notes';
  gateway: string;
  plans: Record<string, { commitment: string; units: string; items: { secretHash: string; value: string }[]; txid: string | null; amountZat?: string }>;
  notes: StoredNote[];
  /** the newest anchor this client has accepted: later anchors must extend it */
  anchor?: AcceptedAnchor;
}

export interface AcceptedAnchor {
  txid: string;
  leaves: number;
  root: string;
  height: number;
}

export interface ClientOptions {
  /** the anchor address's published incoming viewing key (default: Z402_ANCHOR_UIVK); pinned here, never taken from the gateway */
  anchorUivk?: string;
  /** refuse an anchor mined more than this many blocks before the tip (default: Z402_MAX_ANCHOR_AGE_BLOCKS or 2,880, about 2.5 days at 75 s) */
  maxAnchorAgeBlocks?: number;
  /** confirmations the anchor needs (default 1) */
  minAnchorConf?: number;
  /** lightwalletd (default: Z402_LWD_URL or https://testnet.zec.rocks:443); the client trusts it for the anchor txs and their heights */
  lwdUrl?: string;
  /**
   * the gateway's anchor signing key (64 hex Ed25519 public key; default: Z402_ANCHOR_PUBKEY), pinned from
   * the deployment record, never taken from the gateway. With it, an anchor must carry its signature and
   * memos anyone else sends to the anchor address are ignored. Without it the deployment is taken to be
   * unsigned: a signed anchor is Setup required, and only unsigned memos on the address count.
   */
  anchorPubkey?: string;
  /**
   * Re-checks a published run as the chain stood at this block height (default: Z402_REPLAY_AT_HEIGHT,
   * else none). The window is the maxAnchorAgeBlocks blocks ending at this height, scanned once, and
   * an anchor's age and confirmations are counted from it: anchors and memos mined later are not seen.
   * The work is bounded (it does not grow with the tip) and memos sent to the anchor address after the
   * run cannot change the result. It is for replaying a recorded deployment, never for paying a live
   * gateway: a live client judges anchors against the current tip.
   */
  replayAtHeight?: number;
}

export const DEFAULT_MAX_ANCHOR_AGE_BLOCKS = 2880;
/** the window scan of the anchor address is reused this long (about a third of a block) */
const ANCHOR_SCAN_TTL_MS = 30_000;
/** a pay() that has held a note this long without finishing (a crashed process) no longer holds it */
const PENDING_MS = 10 * 60_000;

/** One read-change-write of a notes file at a time: in this process by a promise chain, across processes by the lockfile. */
const chains = new Map<string, Promise<void>>();
async function withNotesLock<T>(path: string, fn: () => T): Promise<T> {
  const key = resolvePath(path);
  const prev = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = prev.then(() => new Promise<void>((r) => (release = r)));
  chains.set(key, tail);
  await prev;
  try {
    const unlock = await fileLock(`${key}.lock`, 30_000, 'the notes file');
    try {
      return fn();
    } finally {
      unlock();
    }
  } finally {
    release();
    if (chains.get(key) === tail) chains.delete(key);
  }
}

/** The client would not prove: the gateway's root is not one it could check on-chain. Nothing was sent. */
export class AnchorRefusedError extends Error {
  constructor(
    readonly code: 'UNANCHORED_ROOT' | 'ANCHOR_MISMATCH' | 'ANCHOR_NOT_CONFIRMED' | 'ANCHOR_TOO_OLD' | 'LEAVES_NOT_ANCHORED' | 'ANCHOR_ROLLBACK' | 'ANCHOR_FORK' | 'NOTE_NOT_ANCHORED' | 'ANCHOR_BAD_SIGNATURE' | 'ANCHOR_COMPETING',
    detail: string,
  ) {
    super(`refusing to pay: ${code}: ${detail}`);
    this.name = 'AnchorRefusedError';
  }
}

/** Every plan's amount (sent or not), in zatoshi. */
const committedZat = (f: NotesFile, unitZat: number) => Object.values(f.plans).reduce((t, p) => t + (p.amountZat !== undefined ? BigInt(p.amountZat) : BigInt(p.units) * BigInt(unitZat)), 0n);

const shortId = (s: string) => (s.length > 16 ? `${s.slice(0, 12)}…` : s);

/**
 * Judges the anchors found on the anchor address in the client's window, given the anchor the gateway
 * named (already read on-chain, mined and recent) and the leaves the gateway serves:
 * - with a pinned key, the named anchor must be signed by it (ANCHOR_BAD_SIGNATURE), and only anchors
 *   signed by it count. Without one the deployment is taken to be unsigned (the Oct 20 one is): a signed
 *   named anchor is Setup required (pin the gateway's key), and only unsigned memos count, which anyone
 *   can send to the public anchor address, so an unpinned client can be made to refuse but cannot tell
 *   who anchored what;
 * - every counted anchor must be the root of a prefix of the served leaves (ANCHOR_COMPETING otherwise:
 *   the gateway has put a root on-chain that is not on the history it shows this client);
 * - the newest counted anchor (by height, then leaf count) is the one to prove against, whichever the
 *   gateway named, so naming an older anchor cannot test whether a payer's note is in it.
 */
export async function pickAnchor(x: { named: ScannedAnchor; window: ScannedAnchor[]; leaves: string[]; anchorPubkey?: string }): Promise<AcceptedAnchor> {
  const { named, leaves, anchorPubkey } = x;
  if (anchorPubkey && !verifyAnchorSignature(anchorPubkey, named))
    throw new AnchorRefusedError('ANCHOR_BAD_SIGNATURE', `anchor ${shortId(named.txid)} is ${named.signature ? 'not signed by' : 'unsigned; this client needs a signature from'} the gateway's anchor key ${shortId(anchorPubkey)}`);
  if (!anchorPubkey && named.signature) throw new SetupRequiredError('Z402_ANCHOR_PUBKEY', `anchor ${shortId(named.txid)} is signed: pin the gateway's anchor public key from its deployment record to check it and its other anchors`);
  const ours = (a: ScannedAnchor) => (anchorPubkey ? verifyAnchorSignature(anchorPubkey, a) : !a.signature);
  const counted = [named, ...x.window.filter((a) => !(a.txid === named.txid && a.root === named.root && a.leaves === named.leaves))].filter(ours);
  const roots = new Map<number, string>();
  const rootAt = async (n: number) => {
    if (!roots.has(n)) roots.set(n, (await Tree.build(leaves.slice(0, n).map(BigInt))).root.toString());
    return roots.get(n)!;
  };
  for (const a of counted) {
    if (a.leaves === 0) continue; // no note can be proven against an empty tree
    if (a.leaves > leaves.length || (await rootAt(a.leaves)) !== a.root)
      throw new AnchorRefusedError('ANCHOR_COMPETING', `anchor ${shortId(a.txid)} at height ${a.height} (${a.leaves} leaves, root ${shortId(a.root)}) is not on the leaf history this gateway serves (${leaves.length} leaves): it has anchored conflicting roots${anchorPubkey ? ', signed with its own key' : ''}`);
  }
  const newest = counted.reduce((b, a) => (a.height > b.height || (a.height === b.height && a.leaves > b.leaves) ? a : b));
  return { txid: newest.txid, leaves: newest.leaves, root: newest.root, height: newest.height };
}

interface WireChallenge {
  scheme: string;
  payTo: string;
  requiredAmount: string;
  contextHash: string;
  nonce: string;
  resource: string;
  root?: string;
  anchor?: { txid: string; leaves: number; root: string; height: number } | null;
}

interface GatewayInfo {
  depositUa: string;
  unitZat: number;
  payTo: string;
  prices: Record<string, string>;
  leaves: number;
  root: string;
  spent: number;
  anchorCount?: number;
  anchors: unknown[];
  latestAnchor: { txid: string; leaves: number; root: string; height: number | null } | null;
}

/** pay() reuses the gateway's payTo and prices this long, so a payment does not read /api/info each time */
const INFO_TTL_MS = 5 * 60_000;

export class GatewayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const short = (s: string) => (s.length > 16 ? `${s.slice(0, 12)}…` : s);

export class Z402Client {
  readonly anchorUivk: string | undefined;
  readonly maxAnchorAgeBlocks: number;
  readonly minAnchorConf: number;
  readonly lwdUrl: string | undefined;
  readonly anchorPubkey: string | undefined;
  readonly replayAtHeight: number | undefined;
  /** the anchor address's anchors in the window, from the last scan (reused for ANCHOR_SCAN_TTL_MS, then extended) */
  private scanned: { at: number; tip: number; to: number; anchors: ScannedAnchor[] } | null = null;
  private infoCache: { at: number; info: GatewayInfo } | null = null;

  constructor(readonly gateway: string, readonly notesPath: string, o: ClientOptions = {}) {
    this.anchorUivk = o.anchorUivk ?? (process.env.Z402_ANCHOR_UIVK || undefined);
    // fails closed: a malformed window would be NaN, and `age > NaN` never refuses
    this.maxAnchorAgeBlocks = wholeNumber('maxAnchorAgeBlocks', o.maxAnchorAgeBlocks ?? intEnv('Z402_MAX_ANCHOR_AGE_BLOCKS', DEFAULT_MAX_ANCHOR_AGE_BLOCKS));
    this.minAnchorConf = wholeNumber('minAnchorConf', o.minAnchorConf ?? 1);
    this.lwdUrl = o.lwdUrl ?? (process.env.Z402_LWD_URL || undefined);
    this.anchorPubkey = o.anchorPubkey ?? (process.env.Z402_ANCHOR_PUBKEY || undefined);
    if (this.anchorPubkey !== undefined && !/^[0-9a-f]{64}$/.test(this.anchorPubkey)) throw new SetupRequiredError('Z402_ANCHOR_PUBKEY', "the gateway's anchor public key as 64 lowercase hex characters");
    const replay = o.replayAtHeight ?? (process.env.Z402_REPLAY_AT_HEIGHT ? intEnv('Z402_REPLAY_AT_HEIGHT', 0, { min: 1 }) : undefined);
    this.replayAtHeight = replay === undefined ? undefined : wholeNumber('replayAtHeight', replay);
  }

  /**
   * Every anchor memo on the anchor address mined in the last maxAnchorAgeBlocks blocks, found by scanning
   * compact blocks with the anchor viewing key. One scan is reused for 30 s; after that only the new
   * blocks are scanned, so lightwalletd is read about once per block, not once per payment.
   * With replayAtHeight the window ends at that height instead of the tip, and is scanned once.
   */
  async windowAnchors(): Promise<{ tip: number; anchors: ScannedAnchor[] }> {
    const s = this.scanned;
    const at = this.replayAtHeight;
    if (at !== undefined) {
      if (s) return { tip: s.tip, anchors: s.anchors };
      const r = await scanAnchors(this.anchorUivk!, { from: Math.max(0, at - this.maxAnchorAgeBlocks), to: at }, this.lwdUrl);
      if (r.tip < at || r.to !== at) throw new Error(`replayAtHeight ${at} is above the chain tip ${r.tip}`);
      const anchors = r.anchors.filter((a) => a.height <= at);
      this.scanned = { at: Date.now(), tip: at, to: at, anchors };
      return { tip: at, anchors };
    }
    if (s && Date.now() - s.at < ANCHOR_SCAN_TTL_MS) return { tip: s.tip, anchors: s.anchors };
    const r = s ? await scanAnchors(this.anchorUivk!, { from: s.to + 1 }, this.lwdUrl) : await scanAnchors(this.anchorUivk!, { last: this.maxAnchorAgeBlocks + 1 }, this.lwdUrl);
    const floor = r.tip - this.maxAnchorAgeBlocks;
    const seen = new Set<string>();
    const anchors = [...(s?.anchors ?? []), ...r.anchors].filter((a) => a.height >= floor && !seen.has(`${a.txid}:${a.root}:${a.leaves}`) && seen.add(`${a.txid}:${a.root}:${a.leaves}`));
    this.scanned = { at: Date.now(), tip: r.tip, to: Math.max(r.to, s?.to ?? 0), anchors };
    return { tip: r.tip, anchors };
  }

  private read(): NotesFile {
    if (!existsSync(this.notesPath)) return { type: 'zec-null-402-notes', gateway: this.gateway, plans: {}, notes: [] };
    const f = JSON.parse(readFileSync(this.notesPath, 'utf8')) as NotesFile;
    if (f.type !== 'zec-null-402-notes') throw new Error(`${this.notesPath} is not a zec-null-402 notes file`);
    return f;
  }

  private write(f: NotesFile) {
    const tmp = `${this.notesPath}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(f, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.notesPath);
  }

  /**
   * Re-reads the notes file under the lock, applies `change` and writes it back. Every change goes
   * through here, so a slow call (a claim waiting on the chain, a proof) never writes back a stale copy
   * over notes another call added meanwhile.
   */
  private update<T>(change: (f: NotesFile) => T): Promise<T> {
    return withNotesLock(this.notesPath, () => {
      const f = this.read();
      const r = change(f);
      this.write(f);
      return r;
    });
  }

  async get<T>(path: string, init?: RequestInit): Promise<T> {
    let r: Response;
    try {
      // never follow a redirect: it could send the request to another origin
      r = await fetch(this.gateway + path, { ...init, redirect: 'error' });
    } catch {
      throw new GatewayError(0, `Setup required: no gateway answering at ${this.gateway}`);
    }
    const b = (await r.json()) as T & { error?: string };
    if (!r.ok) throw new GatewayError(r.status, b.error ?? `HTTP ${r.status}`);
    return b;
  }

  info() {
    return this.get<GatewayInfo>('/api/info');
  }

  /** payTo and prices for pay(): read once and kept for INFO_TTL_MS, or read again when `fresh`. */
  private async terms(fresh = false): Promise<GatewayInfo> {
    if (!fresh && this.infoCache && Date.now() - this.infoCache.at < INFO_TTL_MS) return this.infoCache.info;
    const info = await this.info();
    this.infoCache = { at: Date.now(), info };
    return info;
  }

  /**
   * Creates `count` notes of `value` units and returns what to send: address, zatoshi and memo. With
   * `maxTotalZat`, the plan is refused unless every plan in the notes file (sent or about to be sent) plus
   * this one stays within it; the check and the insert happen under one lock, so two deposits at once cannot
   * both pass it.
   */
  async plan(count: number, value: bigint, o: { maxTotalZat?: bigint; budgetName?: string } = {}): Promise<{ plan: string; address: string; amountZat: bigint; memo: string }> {
    const info = await this.info();
    const notes: Note[] = Array.from({ length: count }, () => newNote(value));
    const d = await depositCommitment(notes);
    const stored: StoredNote[] = await Promise.all(notes.map(async (n) => ({ noteSecret: n.noteSecret.toString(), nullifierSecret: n.nullifierSecret.toString(), value: n.value.toString(), index: null, deposit: d.commitment, nullifier: (await nullifierOf(n)).toString(), spent: false })));
    const amountZat = value * BigInt(count) * BigInt(info.unitZat);
    await this.update((f) => {
      if (o.maxTotalZat !== undefined) {
        const committed = committedZat(f, info.unitZat);
        if (committed + amountZat > o.maxTotalZat)
          throw new Error(`refused: deposits from this notes file would total ${committed + amountZat} zat, above ${o.budgetName ?? 'maxTotalZat'} (${o.maxTotalZat}); ${committed} zat already deposited or being sent`);
      }
      f.plans[d.commitment] = { commitment: d.commitment, units: String(value * BigInt(count)), items: d.items, txid: null, amountZat: amountZat.toString() };
      f.notes.push(...stored);
    });
    return { plan: d.commitment, address: info.depositUa, amountZat, memo: `z402:${d.commitment}` };
  }

  /** Records the txid of a deposit sent for `plan`, as soon as it is sent (before it is mined or claimed). */
  recordDeposit(plan: string, txid: string): Promise<void> {
    return this.update((f) => {
      if (!f.plans[plan]) throw new Error(`no deposit plan ${plan}`);
      f.plans[plan].txid = txid;
    });
  }

  /** Removes a plan whose deposit was never sent (its notes were never credited), for example after the wallet refused to send it. */
  dropPlan(plan: string): Promise<void> {
    return this.update((f) => {
      if (f.plans[plan]?.txid) throw new Error(`plan ${plan} has a deposit (${f.plans[plan].txid}); it is kept`);
      delete f.plans[plan];
      f.notes = f.notes.filter((n) => n.deposit !== plan || n.index !== null);
    });
  }

  /** After the deposit tx is mined: the gateway credits the planned notes. */
  async claim(plan: string, txid: string): Promise<{ first: number; count: number; root: string }> {
    const p = this.read().plans[plan];
    if (!p) throw new Error(`no deposit plan ${plan}`);
    const r = await this.get<{ first: number; count: number; root: string }>('/api/deposits', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid, items: p.items }) });
    await this.update((f) => {
      if (f.plans[plan]) f.plans[plan].txid = txid;
      f.notes.filter((n) => n.deposit === plan).forEach((n, i) => (n.index = r.first + i));
    });
    return r;
  }

  /**
   * Zatoshi this notes file has deposited or is sending: every plan, with a txid or not (a plan whose send
   * failed may still have gone out; dropPlan removes one the wallet refused), for a total budget.
   */
  depositedZat(unitZat: number): bigint {
    return committedZat(this.read(), unitZat);
  }

  status() {
    const f = this.read();
    const unspent = f.notes.filter((n) => n.index !== null && !n.spent);
    return { notes: f.notes.length, credited: f.notes.filter((n) => n.index !== null).length, unspent: unspent.length, unspent_units: unspent.reduce((t, n) => t + BigInt(n.value), 0n).toString(), deposits: Object.values(f.plans).map((p) => ({ txid: p.txid, units: p.units })) };
  }

  /**
   * Checks, before any proof is made, that the challenge's anchor is on-chain (read by this client with the
   * pinned anchor viewing key), mined, recent, signed by the pinned key if there is one, and is rebuilt by
   * the gateway's leaves; then that every anchor of the gateway in the window sits on those leaves, picks
   * the newest (pickAnchor), and checks that one is not behind, and extends, the last anchor this client
   * accepted (the named anchor may be older: it is not the one proven against). Returns the tree of that
   * anchor's leaves only: leaves the gateway added after it (perhaps for this client alone) never enter the proof.
   */
  async checkAnchor(c: WireChallenge, f: NotesFile): Promise<{ anchor: AcceptedAnchor; tree: Tree; leaves: string[] }> {
    if (!this.anchorUivk) throw new SetupRequiredError('Z402_ANCHOR_UIVK', "the anchor address's published viewing key; the client proves only against roots it has read on-chain");
    const a = c.anchor;
    if (!a || typeof a.txid !== 'string' || !Number.isSafeInteger(a.leaves) || a.leaves < 1 || typeof a.root !== 'string')
      throw new AnchorRefusedError('UNANCHORED_ROOT', `the gateway offers root ${short(String(c.root))} with no on-chain anchor`);
    if (c.root !== undefined && c.root !== a.root) throw new AnchorRefusedError('UNANCHORED_ROOT', `the challenge root ${short(String(c.root))} is not the root of the anchor it names (${short(a.root)})`);
    const win = await this.windowAnchors();
    // The named anchor from the window scan; one outside the window (unmined, or too old) is read on its own.
    const inWindow = win.anchors.filter((m) => m.txid === a.txid);
    let memos: AnchorMemo[] = inWindow;
    let height: number | null = inWindow[0]?.height ?? null;
    let tip = win.tip;
    if (inWindow.length === 0) {
      const onchain = await readAnchor(this.anchorUivk, a.txid, this.lwdUrl);
      if (!onchain.found) throw new AnchorRefusedError('ANCHOR_MISMATCH', `anchor tx ${short(a.txid)} is not on-chain`);
      ({ anchors: memos, height, tip } = onchain);
      // a replay sees the chain as it stood at replayAtHeight: a tx mined after it was not mined yet
      if (this.replayAtHeight !== undefined) {
        tip = this.replayAtHeight;
        if (height !== null && height > tip) height = null;
      }
    }
    const memo = memos.find((m) => m.root === a.root && m.leaves === a.leaves);
    if (!memo) throw new AnchorRefusedError('ANCHOR_MISMATCH', `tx ${short(a.txid)} has no anchor memo for ${a.leaves} leaves and root ${short(a.root)} readable by the anchor viewing key`);
    const confirmations = height === null ? 0 : tip - height + 1;
    if (height === null || confirmations < this.minAnchorConf) throw new AnchorRefusedError('ANCHOR_NOT_CONFIRMED', `anchor ${short(a.txid)} has ${confirmations} of ${this.minAnchorConf} confirmations`);
    const age = tip - height;
    if (age > this.maxAnchorAgeBlocks) throw new AnchorRefusedError('ANCHOR_TOO_OLD', `anchor ${short(a.txid)} was mined ${age} blocks ago; this client accepts at most ${this.maxAnchorAgeBlocks}`);
    const { leaves } = await this.get<{ leaves: string[] }>('/api/leaves');
    if (!Array.isArray(leaves) || leaves.length < a.leaves) throw new AnchorRefusedError('LEAVES_NOT_ANCHORED', `the gateway serves ${leaves?.length} leaves, the anchor has ${a.leaves}`);
    if ((await Tree.build(leaves.slice(0, a.leaves).map(BigInt))).root.toString() !== a.root) throw new AnchorRefusedError('LEAVES_NOT_ANCHORED', `the first ${a.leaves} leaves the gateway serves do not rebuild the anchored root`);
    const chosen = await pickAnchor({ named: { txid: a.txid, height, ...memo }, window: win.anchors, leaves, anchorPubkey: this.anchorPubkey });
    // The anchor proven against must not be behind the last one accepted. The named one may be: an older
    // anchor of the same history is fine, since the client proves against the newest in its window anyway.
    const last = f.anchor;
    if (last && (chosen.height < last.height || chosen.leaves < last.leaves))
      throw new AnchorRefusedError('ANCHOR_ROLLBACK', `the newest anchor in this client's window (height ${chosen.height}, ${chosen.leaves} leaves) is behind the one it accepted before (${last.height}, ${last.leaves} leaves)`);
    if (last && last.txid !== chosen.txid && (chosen.leaves < last.leaves || (await Tree.build(leaves.slice(0, last.leaves).map(BigInt))).root.toString() !== last.root))
      throw new AnchorRefusedError('ANCHOR_FORK', `the anchored leaves do not extend the anchor this client accepted (${short(last.txid)}): the gateway's history forked`);
    const used = leaves.slice(0, chosen.leaves);
    return { anchor: chosen, tree: await Tree.build(used.map(BigInt)), leaves: used };
  }

  /**
   * GET a paid URL; on 402, prove with an unspent note of exactly the price and retry.
   * Pays only challenges from this client's gateway, for the path it asked for, to the gateway's payTo:
   * otherwise a server could relay a challenge from the gateway and redeem the proof for its own request.
   * Proves only against the root of an anchor it has checked on-chain (checkAnchor).
   * Fetches nothing outside its gateway's origin and follows no redirect, so a URL handed to it (by an
   * agent's prompt, say) cannot make it send a request, or read a body, anywhere else.
   */
  async pay(url: string): Promise<{ status: number; body: unknown; nullifier: string | null; proveMs: number; anchor: AcceptedAnchor | null }> {
    const target = new URL(url);
    const origin = new URL(this.gateway).origin;
    if (target.origin !== origin) throw new Error(`refusing to fetch ${target.origin}: this client only talks to its gateway ${origin}`);
    const first = await fetch(url, { redirect: 'error' });
    if (first.status !== 402) return { status: first.status, body: await first.json(), nullifier: null, proveMs: 0, anchor: null };
    const c = ((await first.json()) as { accepts?: WireChallenge[] }).accepts?.find((a) => a.scheme === 'zec-null-402');
    if (!c) throw new Error('402 without a zec-null-402 challenge');
    if (c.resource !== target.pathname) throw new Error(`refusing to pay: the challenge is for ${c.resource}, the request was ${target.pathname}`);
    // The challenge must ask the gateway's listed price for this path and bind the proof to this request:
    // otherwise a note could pay for another (dearer) resource. The terms are cached; a mismatch re-reads them once.
    const path = target.pathname;
    let terms = await this.terms();
    if (c.payTo !== terms.payTo || c.requiredAmount !== terms.prices?.[path]) terms = await this.terms(true);
    if (c.payTo !== terms.payTo) throw new Error('refusing to pay: the challenge payTo is not the gateway’s');
    const price = terms.prices?.[path];
    if (price === undefined) throw new Error(`refusing to pay: the gateway lists no price for ${path}`);
    if (typeof c.requiredAmount !== 'string' || c.requiredAmount !== price) throw new Error(`refusing to pay: the challenge asks ${String(c.requiredAmount)} units for ${path}; the gateway's price is ${price}`);
    if (typeof c.nonce !== 'string' || typeof c.contextHash !== 'string' || c.contextHash !== contextHash('GET', path, BigInt(price), BigInt(c.payTo), c.nonce).toString())
      throw new Error(`refusing to pay: the challenge's context hash is not bound to GET ${path} at ${price} units with its nonce`);
    const f = this.read();
    const usable = (n: StoredNote, now: number) => n.index !== null && !n.spent && n.value === c.requiredAmount && !(n.pending && now - n.pending < PENDING_MS);
    if (!f.notes.some((n) => n.index !== null && !n.spent && n.value === c.requiredAmount)) throw new Error(`no unspent note of exactly ${c.requiredAmount} units (a note pays one call of its full value)`);
    const { anchor, tree, leaves } = await this.checkAnchor(c, f);
    // Pick under the lock and mark the note pending, so a concurrent pay() proves with a different note.
    const pick = await this.update((g) => {
      const now = Date.now();
      const free = g.notes.filter((n) => usable(n, now));
      if (free.length === 0) throw new Error(`no unspent note of exactly ${c.requiredAmount} units that another payment is not using right now`);
      const p = free.find((n) => n.index! < anchor.leaves);
      if (!p) throw new AnchorRefusedError('NOTE_NOT_ANCHORED', `every unspent ${c.requiredAmount}-unit note was credited after the latest anchor (${anchor.leaves} leaves); it can pay once the gateway's next anchor is mined`);
      p.pending = now;
      if (!g.anchor || anchor.height > g.anchor.height || (anchor.height === g.anchor.height && anchor.leaves >= g.anchor.leaves)) g.anchor = anchor;
      return { ...p };
    });
    let spent = false;
    try {
      const note: Note = { noteSecret: BigInt(pick.noteSecret), nullifierSecret: BigInt(pick.nullifierSecret), value: BigInt(pick.value) };
      if ((await leafOf(note)).toString() !== leaves[pick.index!]) throw new Error(`leaf ${pick.index} on the gateway is not this note's leaf`);
      const t0 = Date.now();
      const { proof, signals } = await provePayment(note, pick.index!, tree, BigInt(c.payTo), BigInt(c.requiredAmount), BigInt(c.contextHash));
      const proveMs = Date.now() - t0;
      const res = await fetch(url, { redirect: 'error', headers: { 'x-payment': Buffer.from(JSON.stringify({ nonce: c.nonce, proof, signals })).toString('base64') } });
      const body = await res.json();
      spent = res.status === 200 || (body as { reason?: string }).reason === 'NULLIFIER_SPENT';
      return { status: res.status, body, nullifier: signals.nullifier, proveMs, anchor };
    } finally {
      await this.update((g) => {
        const n = g.notes.find((x) => x.nullifier === pick.nullifier);
        if (!n) return;
        delete n.pending;
        if (spent) n.spent = true;
      });
    }
  }
}
