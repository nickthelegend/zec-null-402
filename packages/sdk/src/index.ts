// zec-null-402 client: plan a deposit of N notes, claim it after the shielded deposit is mined, then
// pay per call with a zero-knowledge proof of one unspent note. Note secrets live in a 0600 file.
// The client proves only against a root it has read itself in an on-chain anchor (lightwalletd + the
// anchor address's published viewing key), so a gateway cannot tell clients apart by handing each its
// own root.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { depositCommitment, leafOf, newNote, nullifierOf, provePayment, Tree, type Note } from '@z402/circuits';
import { fileLock, intEnv, readAnchor, SetupRequiredError, wholeNumber } from '@z402/gateway';

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
  /** lightwalletd (default: Z402_LWD_URL or https://testnet.zec.rocks:443) */
  lwdUrl?: string;
}

export const DEFAULT_MAX_ANCHOR_AGE_BLOCKS = 2880;
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
  constructor(readonly code: 'UNANCHORED_ROOT' | 'ANCHOR_MISMATCH' | 'ANCHOR_NOT_CONFIRMED' | 'ANCHOR_TOO_OLD' | 'LEAVES_NOT_ANCHORED' | 'ANCHOR_ROLLBACK' | 'ANCHOR_FORK' | 'NOTE_NOT_ANCHORED', detail: string) {
    super(`refusing to pay: ${code}: ${detail}`);
    this.name = 'AnchorRefusedError';
  }
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

  constructor(readonly gateway: string, readonly notesPath: string, o: ClientOptions = {}) {
    this.anchorUivk = o.anchorUivk ?? (process.env.Z402_ANCHOR_UIVK || undefined);
    // fails closed: a malformed window would be NaN, and `age > NaN` never refuses
    this.maxAnchorAgeBlocks = wholeNumber('maxAnchorAgeBlocks', o.maxAnchorAgeBlocks ?? intEnv('Z402_MAX_ANCHOR_AGE_BLOCKS', DEFAULT_MAX_ANCHOR_AGE_BLOCKS));
    this.minAnchorConf = wholeNumber('minAnchorConf', o.minAnchorConf ?? 1);
    this.lwdUrl = o.lwdUrl ?? (process.env.Z402_LWD_URL || undefined);
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
    return this.get<{ depositUa: string; unitZat: number; payTo: string; prices: Record<string, string>; leaves: number; root: string; spent: number; anchors: unknown[]; latestAnchor: { txid: string; leaves: number; root: string; height: number | null } | null }>('/api/info');
  }

  /** Creates `count` notes of `value` units and returns what to send: address, zatoshi and memo. */
  async plan(count: number, value: bigint): Promise<{ plan: string; address: string; amountZat: bigint; memo: string }> {
    const info = await this.info();
    const notes: Note[] = Array.from({ length: count }, () => newNote(value));
    const d = await depositCommitment(notes);
    const stored: StoredNote[] = await Promise.all(notes.map(async (n) => ({ noteSecret: n.noteSecret.toString(), nullifierSecret: n.nullifierSecret.toString(), value: n.value.toString(), index: null, deposit: d.commitment, nullifier: (await nullifierOf(n)).toString(), spent: false })));
    const amountZat = value * BigInt(count) * BigInt(info.unitZat);
    await this.update((f) => {
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

  status() {
    const f = this.read();
    const unspent = f.notes.filter((n) => n.index !== null && !n.spent);
    return { notes: f.notes.length, credited: f.notes.filter((n) => n.index !== null).length, unspent: unspent.length, unspent_units: unspent.reduce((t, n) => t + BigInt(n.value), 0n).toString(), deposits: Object.values(f.plans).map((p) => ({ txid: p.txid, units: p.units })) };
  }

  /**
   * Checks, before any proof is made, that the challenge's root is in an on-chain anchor this client
   * reads itself, that the anchor is mined and recent, that it extends the last anchor this client
   * accepted, and that the gateway's leaves rebuild it. Returns the tree of the anchored leaves only:
   * leaves the gateway added after the anchor (perhaps for this client alone) never enter the proof.
   */
  async checkAnchor(c: WireChallenge, f: NotesFile): Promise<{ anchor: AcceptedAnchor; tree: Tree; leaves: string[] }> {
    if (!this.anchorUivk) throw new SetupRequiredError('Z402_ANCHOR_UIVK', "the anchor address's published viewing key; the client proves only against roots it has read on-chain");
    const a = c.anchor;
    if (!a || typeof a.txid !== 'string' || !Number.isSafeInteger(a.leaves) || a.leaves < 1 || typeof a.root !== 'string')
      throw new AnchorRefusedError('UNANCHORED_ROOT', `the gateway offers root ${short(String(c.root))} with no on-chain anchor`);
    if (c.root !== undefined && c.root !== a.root) throw new AnchorRefusedError('UNANCHORED_ROOT', `the challenge root ${short(String(c.root))} is not the root of the anchor it names (${short(a.root)})`);
    const onchain = await readAnchor(this.anchorUivk, a.txid, this.lwdUrl);
    if (!onchain.found) throw new AnchorRefusedError('ANCHOR_MISMATCH', `anchor tx ${short(a.txid)} is not on-chain`);
    if (!onchain.anchors.some((m) => m.root === a.root && m.leaves === a.leaves))
      throw new AnchorRefusedError('ANCHOR_MISMATCH', `tx ${short(a.txid)} has no anchor memo for ${a.leaves} leaves and root ${short(a.root)} readable by the anchor viewing key`);
    if (onchain.height === null || onchain.confirmations < this.minAnchorConf) throw new AnchorRefusedError('ANCHOR_NOT_CONFIRMED', `anchor ${short(a.txid)} has ${onchain.confirmations} of ${this.minAnchorConf} confirmations`);
    const age = onchain.tip - onchain.height;
    if (age > this.maxAnchorAgeBlocks) throw new AnchorRefusedError('ANCHOR_TOO_OLD', `anchor ${short(a.txid)} was mined ${age} blocks ago; this client accepts at most ${this.maxAnchorAgeBlocks}`);
    const last = f.anchor;
    if (last && (onchain.height < last.height || a.leaves < last.leaves))
      throw new AnchorRefusedError('ANCHOR_ROLLBACK', `anchor at height ${onchain.height} with ${a.leaves} leaves is behind the one this client accepted (${last.height}, ${last.leaves} leaves)`);
    const { leaves } = await this.get<{ leaves: string[] }>('/api/leaves');
    if (!Array.isArray(leaves) || leaves.length < a.leaves) throw new AnchorRefusedError('LEAVES_NOT_ANCHORED', `the gateway serves ${leaves?.length} leaves, the anchor has ${a.leaves}`);
    const tree = await Tree.build(leaves.slice(0, a.leaves).map(BigInt));
    if (tree.root.toString() !== a.root) throw new AnchorRefusedError('LEAVES_NOT_ANCHORED', `the first ${a.leaves} leaves the gateway serves do not rebuild the anchored root`);
    if (last && last.txid !== a.txid && (await Tree.build(leaves.slice(0, last.leaves).map(BigInt))).root.toString() !== last.root)
      throw new AnchorRefusedError('ANCHOR_FORK', `the anchored leaves do not extend the anchor this client accepted (${short(last.txid)}): the gateway's history forked`);
    return { anchor: { txid: a.txid, leaves: a.leaves, root: a.root, height: onchain.height }, tree, leaves: leaves.slice(0, a.leaves) };
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
    if (c.payTo !== (await this.info()).payTo) throw new Error('refusing to pay: the challenge payTo is not the gateway’s');
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
